import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  ASSETS,
  type Asset,
  CURRENCIES,
  type ChainDeposit,
  type Currency,
  FakeChain,
  type KVStore,
  LeaseRegistry,
  LeaseRegistryStore,
  MockSettlementProvider,
  type PaymentEvent,
  type PaymentRequest,
  PaymentRequestStore,
  PaymentWatcher,
  RateEngine,
  type RateSnapshot,
  RateSnapshotStore,
  SettlementOrchestrator,
  StaticRateProvider,
  SyncReceiver,
  type SyncOp,
  WebhookDispatcher,
  createPaymentRequest,
  fromJson,
  parseUnits,
  safeEqual,
  withPolicy,
} from '@paycryt/core';

export interface ServerConfig {
  /** Bearer token clients must send. */
  apiKey: string;
  /** Where to POST signed payment events. Optional. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** Your margin in bps, applied against customers. */
  spreadBps?: number;
  /** Enables /v1/sandbox/* (fake deposits, mining, time travel, rate changes). Never enable in production. */
  sandbox?: boolean;
  /** Starting sandbox prices (fiat per asset), e.g. { 'USDT/NGN': '1500' }. */
  sandboxPrices?: Record<string, string>;
  /**
   * Persist payments, the rate audit trail and address leases here (e.g. `new SqliteStore(path)` from
   * @paycryt/adapters) so they survive a restart. Omit it to run fully in-memory, as before — nothing
   * changes for existing callers. Note: the fake-chain sandbox's deposit history is never persisted,
   * on purpose (see docs/persistence.md) — only payments/rates/leases are.
   */
  store?: KVStore;
}

const ASSET_LIST = ASSETS as Record<string, Asset>;
const CHAINS = ['tron', 'ethereum', 'bsc', 'base', 'bitcoin'];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A small reference API around @paycryt/core with a built-in fake-chain sandbox.
 * Pass `store` in `ServerConfig` (e.g. `new SqliteStore(path)` from @paycryt/adapters) and payments, the
 * rate audit trail and address leases all survive a restart; omit it and it runs fully in-memory as
 * before. Either way, swap the pieces for real chain adapters and rate providers when you build your
 * production service — this class stays a starting point, not a production service in itself.
 */
export class PaycrytServer {
  readonly http: Server;
  readonly engine: RateEngine;
  readonly watcher: PaymentWatcher;
  readonly leases: LeaseRegistry;
  readonly chains = new Map<string, FakeChain>();
  readonly events: PaymentEvent[] = [];
  readonly settlement = new MockSettlementProvider();
  readonly prices: StaticRateProvider[];
  private clockOffset = 0;
  private ticker?: NodeJS.Timeout;
  private readonly serverLease: { start: number; end: number };
  private nextIndex: number;
  private readonly dispatcher?: WebhookDispatcher;
  private readonly receiver: SyncReceiver;
  private readonly deriver = new FakeChain('sandbox');
  private readonly payments?: PaymentRequestStore;
  private readonly snapshots?: RateSnapshotStore;
  private readonly leaseStore?: LeaseRegistryStore;

  /** Use `PaycrytServer.create(config)` instead — restoring persisted state needs an async step. */
  private constructor(
    private readonly config: ServerConfig,
    restored: { leases: LeaseRegistry; snapshots: RateSnapshot[]; requests: PaymentRequest[] },
  ) {
    const now = () => this.now();
    const seed = config.sandboxPrices ?? { 'USDT/NGN': '1500', 'USDC/NGN': '1500', 'BTC/NGN': '150000000', 'USDT/GHS': '15', 'USDT/KES': '129' };
    // Two slightly different sources so the sandbox demonstrates median + outlier rejection.
    this.prices = [
      new StaticRateProvider('sandbox-exchange', seed, now),
      new StaticRateProvider('sandbox-parallel', Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, (Number(v) * 1.002).toString()])), now),
    ];
    this.engine = new RateEngine({ providers: this.prices, spreadBps: config.spreadBps ?? 100, now });
    for (const s of restored.snapshots) this.engine.log.append(s); // restores the hash chain, in the order it was appended
    if (!this.engine.log.verify().ok) console.warn('[paycryt] restored rate audit trail failed verification — the persisted store may be corrupted or tampered.');

    for (const c of CHAINS) this.chains.set(c, new FakeChain(c, now));
    this.watcher = new PaymentWatcher([...this.chains.values()], now);

    this.leases = restored.leases;
    this.serverLease = this.leases.allocate('server', 1_000_000);
    // Only this server's own (non-offline) payments draw from serverLease; resume past whatever it already issued.
    this.nextIndex = restored.requests
      .filter((r) => !r.offline && r.addressIndex !== undefined && r.addressIndex >= this.serverLease.start && r.addressIndex < this.serverLease.end)
      .reduce((max, r) => Math.max(max, r.addressIndex! + 1), this.serverLease.start);

    if (config.store) {
      this.payments = new PaymentRequestStore(config.store);
      this.snapshots = new RateSnapshotStore(config.store);
      this.leaseStore = new LeaseRegistryStore(config.store);
    }

    this.receiver = new SyncReceiver({
      deriver: this.deriver,
      leases: this.leases,
      onAccepted: async (r) => {
        await this.payments?.save(r);
        this.watcher.watch(r);
      },
      isKnownSnapshot: (h) => !!this.engine.log.get(h),
    });
    this.receiver.hydrate(restored.requests); // so a re-synced already-known op isn't treated as an address collision

    for (const r of restored.requests) this.watcher.watch(r); // re-evaluated for real on the next tick() against the chain

    if (config.webhookUrl) {
      this.dispatcher = new WebhookDispatcher({ url: config.webhookUrl, secret: config.webhookSecret ?? config.apiKey, fetch: globalThis.fetch as never });
    }
    const orchestrator = new SettlementOrchestrator(
      this.settlement,
      { destination: { type: 'bank', bankCode: '058', accountNumber: '0000000000', accountName: 'Sandbox Merchant' } },
      (id) => this.watcher.get(id)?.request,
    );
    this.watcher.on(async (e) => {
      this.events.push(e);
      if (config.sandbox) await orchestrator.handle(e);
      void this.dispatcher?.send(serializeEvent(e));
    });

    this.http = createServer((req, res) => void this.handle(req, res));
  }

  /** Builds the server, reloading payments/rates/leases from `config.store` if one is given. */
  static async create(config: ServerConfig): Promise<PaycrytServer> {
    let restored: { leases: LeaseRegistry; snapshots: RateSnapshot[]; requests: PaymentRequest[] } = { leases: new LeaseRegistry(), snapshots: [], requests: [] };
    if (config.store) {
      const [requests, snapshots, leases] = await Promise.all([
        new PaymentRequestStore(config.store).all(),
        new RateSnapshotStore(config.store).loadAll(),
        new LeaseRegistryStore(config.store).load(),
      ]);
      restored = { leases, snapshots, requests };
    }
    const server = new PaycrytServer(config, restored);
    await server.leaseStore?.save(server.leases); // persist the server's own lease allocation on a first-ever boot
    return server;
  }

  now(): number {
    return Date.now() + this.clockOffset;
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        this.ticker = setInterval(() => void this.watcher.tick(), 1_000);
        this.ticker.unref();
        resolve((this.http.address() as { port: number }).port);
      });
    });
  }

  close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  // ---------------------------------------------------------------- routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, sandbox: !!this.config.sandbox });

      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!safeEqual(token, this.config.apiKey)) throw new HttpError(401, 'Missing or invalid API key');

      const body = method === 'POST' ? await readBody(req) : '';
      const json = body ? (JSON.parse(body) as any) : {};

      // ---- rates
      let m = /^\/v1\/rates\/([A-Z0-9]+)-([A-Z]+)$/.exec(path);
      if (method === 'GET' && m) {
        const spread = url.searchParams.get('spreadBps');
        return send(res, 200, await this.getSnapshot({ base: m[1]!, quote: m[2]!, direction: 'CRYPTO_TO_FIAT', spreadBps: spread ? Number(spread) : undefined }));
      }
      if (method === 'GET' && path === '/v1/audit/rates') {
        return send(res, 200, { verification: this.engine.log.verify(), snapshots: this.engine.log.all() });
      }
      m = /^\/v1\/audit\/rates\/([0-9a-f]{64})$/.exec(path);
      if (method === 'GET' && m) {
        const s = this.engine.log.get(m[1]!);
        if (!s) throw new HttpError(404, 'Unknown snapshot');
        return send(res, 200, s);
      }

      // ---- payments
      if (method === 'POST' && path === '/v1/payments') return send(res, 201, await this.createPayment(json));
      m = /^\/v1\/payments\/([\w-]+)$/.exec(path);
      if (method === 'GET' && m) return send(res, 200, this.getPayment(m[1]!));
      if (method === 'GET' && path === '/v1/payments') return send(res, 200, this.watcher.list().map((w) => view(w)));
      if (method === 'GET' && path === '/v1/events') return send(res, 200, this.events.map(serializeEvent));
      if (method === 'GET' && path === '/v1/payouts') return send(res, 200, [...this.settlement.payouts.values()].map((p) => ({ ...p, request: { ...p.request } })));

      // ---- offline POS
      if (method === 'POST' && path === '/v1/leases') return send(res, 200, await this.allocateLease(String(json.deviceId), json.size ? Number(json.size) : 1_000));
      if (method === 'POST' && path === '/v1/leases/renew') return send(res, 200, await this.renewLease(String(json.deviceId), json.size ? Number(json.size) : 1_000));
      if (method === 'POST' && path === '/v1/sync') {
        // Devices send bigint-tagged JSON (see toJson/fromJson in @paycryt/core).
        const result = await this.receiver.apply(fromJson<SyncOp>(body));
        await this.watcher.tick();
        return send(res, 200, result);
      }

      // ---- sandbox
      if (path.startsWith('/v1/sandbox/')) {
        if (!this.config.sandbox) throw new HttpError(404, 'Sandbox is disabled');
        return send(res, 200, await this.sandbox(method, path, json));
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
      return send(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    }
  }

  private async createPayment(input: any) {
    const currency: Currency | undefined = (CURRENCIES as Record<string, Currency>)[String(input.currency)];
    if (!currency) throw new HttpError(400, `Unsupported currency: ${input.currency}`);
    const asset = ASSET_LIST[String(input.asset)];
    if (!asset) throw new HttpError(400, `Unknown asset "${input.asset}". Try one of: ${Object.keys(ASSET_LIST).join(', ')}`);
    const chain = this.chains.get(asset.chain);
    if (!chain) throw new HttpError(400, `No chain adapter for ${asset.chain}`);

    const snapshot = await this.getSnapshot({ base: asset.symbol, quote: currency.code, direction: 'CRYPTO_TO_FIAT' });
    const index = this.nextIndex++;
    const request = createPaymentRequest({
      fiat: { currency: currency.code, amountMinor: parseUnits(String(input.amount), currency.decimals) },
      asset,
      address: this.deriver.derive(index),
      addressIndex: index,
      snapshot,
      policy: withPolicy(input.policy ?? {}),
      now: this.now(),
      metadata: input.metadata,
    });
    await this.payments?.save(request);
    this.watcher.watch(request);
    return view(this.watcher.get(request.id)!);
  }

  private getPayment(id: string) {
    const w = this.watcher.get(id);
    if (!w) throw new HttpError(404, 'Unknown payment');
    return view(w);
  }

  /** Fetches a fresh snapshot and, if a store is configured, persists it to the durable rate-audit chain. */
  private async getSnapshot(req: Parameters<RateEngine['getSnapshot']>[0]): Promise<RateSnapshot> {
    const snapshot = await this.engine.getSnapshot(req);
    await this.snapshots?.append(snapshot);
    return snapshot;
  }

  private async allocateLease(deviceId: string, size: number) {
    const lease = this.leases.allocate(deviceId, size);
    await this.leaseStore?.save(this.leases);
    return lease;
  }

  private async renewLease(deviceId: string, size: number) {
    const lease = this.leases.renew(deviceId, size);
    await this.leaseStore?.save(this.leases);
    return lease;
  }

  private async sandbox(method: string, path: string, json: any) {
    const out = await this.sandboxAction(method, path, json);
    await this.watcher.tick();
    return out;
  }

  private async sandboxAction(method: string, path: string, json: any): Promise<unknown> {
    if (method !== 'POST') throw new HttpError(405, 'Use POST');
    if (path === '/v1/sandbox/deposit') {
      const w = this.watcher.get(String(json.paymentId));
      if (!w) throw new HttpError(404, 'Unknown payment');
      const chain = this.chains.get(w.request.asset.chain)!;
      const s = chain.scenarios;
      const scenario = String(json.scenario ?? 'exact');
      const deposits: ChainDeposit[] =
        scenario === 'exact' ? s.exact(w.request)
        : scenario === 'underpay' ? s.underpay(w.request, Number(json.percent ?? 50))
        : scenario === 'overpay' ? s.overpay(w.request, Number(json.percent ?? 120))
        : scenario === 'split' ? s.split(w.request, Number(json.parts ?? 2))
        : scenario === 'late' ? s.late(w.request, Number(json.afterMs ?? w.request.policy.graceMs + 1_000))
        : scenario === 'unconfirmed' ? s.unconfirmed(w.request)
        : (() => { throw new HttpError(400, 'scenario must be exact | underpay | overpay | split | late | unconfirmed'); })();
      return { deposits: deposits.map((d) => ({ ...d, amount: d.amount.toString() })) };
    }
    if (path === '/v1/sandbox/mine') {
      for (const c of this.chains.values()) c.mine(Number(json.blocks ?? 1));
      return { mined: Number(json.blocks ?? 1) };
    }
    if (path === '/v1/sandbox/time') {
      this.clockOffset += Number(json.advanceMs ?? 0);
      return { now: this.now() };
    }
    if (path === '/v1/sandbox/rates') {
      for (const p of this.prices) p.setPrice(String(json.pair), String(json.price));
      return { pair: json.pair, price: json.price };
    }
    throw new HttpError(404, 'Unknown sandbox route');
  }
}

// -------------------------------------------------------------------- helpers

function view(w: NonNullable<ReturnType<PaymentWatcher['get']>>) {
  const { request, evaluation } = w;
  return {
    id: request.id,
    status: w.status,
    address: request.address,
    asset: request.asset,
    fiat: request.fiat,
    amountDue: request.amountDue,
    effectiveRate: request.effectiveRate,
    rateSnapshotHash: request.rateSnapshotHash,
    expiresAt: request.expiresAt,
    offline: request.offline,
    received: evaluation.received,
    pending: evaluation.pending,
    shortfall: evaluation.shortfall,
    excess: evaluation.excess,
    late: evaluation.late,
    actions: evaluation.actions,
  };
}

function serializeEvent(e: PaymentEvent) {
  const { evaluation, ...rest } = e;
  return { ...rest, data: { received: evaluation.received, due: evaluation.due, shortfall: evaluation.shortfall, excess: evaluation.excess, actions: evaluation.actions } };
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  // bigint -> string for plain-JSON clients
  res.end(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

