import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  ASSETS,
  type AddressDeriver,
  type Asset,
  type ChainAdapter,
  CURRENCIES,
  type ChainDeposit,
  type Currency,
  FakeChain,
  type KVStore,
  LeaseRegistry,
  LeaseRegistryStore,
  MemoryStore,
  type Merchant,
  MerchantStore,
  MockSettlementProvider,
  type PaymentEvent,
  type PaymentRequest,
  PaymentRequestStore,
  PaymentWatcher,
  RateEngine,
  type RateProvider,
  type RateSnapshot,
  RateSnapshotStore,
  SettlementOrchestrator,
  StaticRateProvider,
  SyncReceiver,
  type SyncOp,
  WalletConflictError,
  type WalletFamily,
  WebhookDispatcher,
  createPaymentRequest,
  deriverForWallet,
  fromJson,
  mergePolicyOverrides,
  parseUnits,
  safeEqual,
  toMerchantView,
  validatePolicyOverrides,
  walletFamilyForChain,
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
  /** Starting sandbox prices (fiat per asset), e.g. { 'USDT/NGN': '1500' }. Sandbox only. */
  sandboxPrices?: Record<string, string>;
  /**
   * LIVE MODE (`sandbox: false`) needs real chain watchers here, one per chain you accept, e.g.
   * `TronGridChainAdapter`, `EvmRpcChainAdapter`, `EsploraChainAdapter` from @paycryt/adapters. Live mode
   * refuses to start without them, so a live server can never quietly run on the fake chain and accept
   * payments that will never confirm. Not allowed in sandbox mode, which supplies its own fake chains.
   */
  chains?: ChainAdapter[];
  /** Live exchange-rate sources (median-combined). Required in live mode; not allowed in sandbox mode. */
  rateProviders?: RateProvider[];
  /** Minimum agreeing rate sources before a price is issued. Default 1. */
  minRateSources?: number;
  /** How far a rate source may sit from the median of the sources before it is dropped as an outlier. Default 300 (3%). */
  maxRateDeviationBps?: number;
  /** How often to check the chain for deposits. Default 1s in the sandbox, 5s live. */
  pollIntervalMs?: number;
  /** How many payments to check in parallel per poll. Default 1 in the sandbox, 4 live. */
  pollConcurrency?: number;
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
  readonly chains = new Map<string, ChainAdapter>();
  private readonly fakeChains = new Map<string, FakeChain>();
  private lastTick?: { at: number; ms: number };
  readonly events: PaymentEvent[] = [];
  readonly settlement = new MockSettlementProvider();
  readonly prices: StaticRateProvider[];
  private clockOffset = 0;
  private ticker?: NodeJS.Timeout;
  private readonly serverLease: { start: number; end: number };
  private nextIndex: number;
  private readonly dispatcher?: WebhookDispatcher;
  private readonly merchantDispatchers = new Map<string, WebhookDispatcher>();
  private readonly walletDerivers = new Map<string, AddressDeriver>();
  private readonly walletCounters = new Map<string, number>();
  private readonly kv: KVStore;
  private readonly merchants: MerchantStore;
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
    const sandbox = !!config.sandbox;
    if (sandbox && (config.chains || config.rateProviders)) {
      throw new Error('Sandbox mode uses its own fake chains and static prices. To use real chains or rate sources, set sandbox: false.');
    }
    if (!sandbox && (!config.chains?.length || !config.rateProviders?.length)) {
      throw new Error(
        'Live mode (sandbox: false) needs `chains` (real chain watchers) and `rateProviders` (real exchange-rate sources). Refusing to start on fake chains or made-up prices. Use sandbox: true for local development.',
      );
    }
    const seed = config.sandboxPrices ?? { 'USDT/NGN': '1500', 'USDC/NGN': '1500', 'BTC/NGN': '150000000', 'USDT/GHS': '15', 'USDT/KES': '129' };
    // Two slightly different sources so the sandbox demonstrates median + outlier rejection.
    this.prices = sandbox
      ? [
          new StaticRateProvider('sandbox-exchange', seed, now),
          new StaticRateProvider('sandbox-parallel', Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, (Number(v) * 1.002).toString()])), now),
        ]
      : [];
    this.engine = new RateEngine({ providers: sandbox ? this.prices : config.rateProviders!, spreadBps: config.spreadBps ?? 100, minSources: config.minRateSources, maxDeviationBps: config.maxRateDeviationBps, now });
    for (const s of restored.snapshots) this.engine.log.append(s); // restores the hash chain, in the order it was appended
    if (!this.engine.log.verify().ok) console.warn('[paycryt] restored rate audit trail failed verification — the persisted store may be corrupted or tampered.');

    if (sandbox) {
      for (const c of CHAINS) {
        const fake = new FakeChain(c, now);
        this.fakeChains.set(c, fake);
        this.chains.set(c, fake);
      }
    } else {
      for (const c of config.chains!) {
        if (this.chains.has(c.chain)) throw new Error(`Two chain adapters were given for "${c.chain}"; use one per chain.`);
        this.chains.set(c.chain, c);
      }
    }
    this.watcher = new PaymentWatcher([...this.chains.values()], now, { concurrency: config.pollConcurrency ?? (sandbox ? 1 : 4) });

    this.leases = restored.leases;
    this.serverLease = this.leases.allocate('server', 1_000_000);
    // Only this server's own (non-offline) payments draw from serverLease; resume past whatever it already issued.
    this.nextIndex = restored.requests
      .filter((r) => !r.offline && r.addressIndex !== undefined && r.addressIndex >= this.serverLease.start && r.addressIndex < this.serverLease.end)
      .reduce((max, r) => Math.max(max, r.addressIndex! + 1), this.serverLease.start);

    // Merchants and device ownership live in the configured store, or in memory when there is none.
    this.kv = config.store ?? new MemoryStore();
    this.merchants = new MerchantStore(this.kv);

    if (config.store) {
      this.payments = new PaymentRequestStore(config.store);
      this.snapshots = new RateSnapshotStore(config.store);
      this.leaseStore = new LeaseRegistryStore(config.store);
    }

    this.receiver = new SyncReceiver({
      deriver: this.deriver,
      leases: this.leases,
      // Each tenant's offline payments must derive from THEIR wallet and run under THEIR policy, never the device's own.
      resolveDeriver: async (op) => this.addressSource(await this.merchantOf(op.request.merchantId), op.request.asset?.chain),
      policyFor: async (op) => withPolicy(mergePolicyOverrides((await this.merchantOf(op.request.merchantId))?.policy)),
      lookupRequest: (id) => this.watcher.get(id)?.request,
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
      void this.deliverWebhook(e);
    });
    this.watcher.onError((err, ctx) => console.warn(`[paycryt] ${ctx.stage} error for ${ctx.paymentId}: ${err instanceof Error ? err.message : String(err)}`));

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
        this.ticker = setInterval(() => void this.poll(), this.config.pollIntervalMs ?? (this.config.sandbox ? 1_000 : 5_000));
        this.ticker.unref();
        resolve((this.http.address() as { port: number }).port);
      });
    });
  }

  /** One timed check of every open payment. Ticks are serialised by the watcher, so a slow poll never overlaps the next. */
  private async poll(): Promise<void> {
    const started = Date.now();
    try {
      await this.watcher.tick();
      this.lastTick = { at: this.now(), ms: Date.now() - started };
    } catch (err) {
      console.warn(`[paycryt] poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  // ---------------------------------------------------------------- routing

  /** Who is calling: the operator (admin key) or one merchant (their own key). */
  private async authenticate(req: IncomingMessage): Promise<Auth> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (token && safeEqual(token, this.config.apiKey)) return { role: 'admin' };
    const merchant = token ? await this.merchants.authenticate(token) : undefined;
    if (merchant) return { role: 'merchant', merchant };
    throw new HttpError(401, 'Missing or invalid API key');
  }

  /** Admin sees everything; a merchant sees only payments created under their own key or synced from their own devices. */
  private canSee(auth: Auth, request: PaymentRequest | undefined): boolean {
    if (!request) return false;
    return auth.role === 'admin' || request.merchantId === auth.merchant.id;
  }

  private requireAdmin(auth: Auth): void {
    if (auth.role !== 'admin') throw new HttpError(403, 'This endpoint needs the admin API key');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, sandbox: !!this.config.sandbox, mode: this.config.sandbox ? 'sandbox' : 'live' });

      const auth = await this.authenticate(req);

      const body = method === 'POST' ? await readBody(req) : '';
      const json = body ? (JSON.parse(body) as any) : {};

      if (method === 'GET' && path === '/v1/status') {
        this.requireAdmin(auth);
        return send(res, 200, this.status());
      }

      if (method === 'GET' && path === '/v1/me') {
        return send(res, 200, auth.role === 'admin' ? { role: 'admin' } : { role: 'merchant', merchant: toMerchantView(auth.merchant) });
      }

      // ---- admin: merchants (tenants)
      if (path === '/v1/admin/merchants' || path.startsWith('/v1/admin/merchants/')) {
        this.requireAdmin(auth);
        return await this.adminMerchants(method, path, json, res);
      }

      // ---- rates (shared: the rate log holds prices, not anyone's business data)
      let m = /^\/v1\/rates\/([A-Z0-9]+)-([A-Z]+)$/.exec(path);
      if (method === 'GET' && m) {
        const spread = url.searchParams.get('spreadBps');
        const spreadBps = spread ? Number(spread) : auth.role === 'merchant' ? auth.merchant.spreadBps : undefined;
        return send(res, 200, await this.getSnapshot({ base: m[1]!, quote: m[2]!, direction: 'CRYPTO_TO_FIAT', spreadBps }));
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

      // ---- payments (scoped to the caller)
      if (method === 'POST' && path === '/v1/payments') return send(res, 201, await this.createPayment(json, auth));
      m = /^\/v1\/payments\/([\w-]+)$/.exec(path);
      if (method === 'GET' && m) return send(res, 200, this.getPayment(m[1]!, auth));
      if (method === 'GET' && path === '/v1/payments') {
        return send(res, 200, this.watcher.list().filter((w) => this.canSee(auth, w.request)).map((w) => view(w)));
      }
      if (method === 'GET' && path === '/v1/events') {
        return send(res, 200, this.events.filter((e) => this.canSee(auth, this.watcher.get(e.paymentId)?.request)).map(serializeEvent));
      }
      if (method === 'GET' && path === '/v1/payouts') {
        return send(
          res,
          200,
          [...this.settlement.payouts.values()]
            .filter((p) => this.canSee(auth, this.watcher.get(p.reference.replace(/^settle_/, ''))?.request))
            .map((p) => ({ ...p, request: { ...p.request } })),
        );
      }

      // ---- offline POS
      if (method === 'POST' && (path === '/v1/leases' || path === '/v1/leases/renew')) {
        const deviceId = validDeviceId(json.deviceId);
        const size = validLeaseSize(json.size);
        await this.claimDevice(deviceId, auth);
        return send(res, 200, path === '/v1/leases' ? await this.allocateLease(deviceId, size) : await this.renewLease(deviceId, size));
      }
      if (method === 'POST' && path === '/v1/sync') {
        // Devices send bigint-tagged JSON (see toJson/fromJson in @paycryt/core).
        const op = fromJson<SyncOp>(body);
        const owner = await this.deviceOwner(String(op.deviceId));
        if (auth.role === 'merchant' && owner !== auth.merchant.id) {
          return send(res, 403, { status: 'rejected', reason: 'this device is not registered to your merchant account' });
        }
        // The tenant comes from who owns the device, never from anything the device claims about itself.
        op.request.merchantId = owner && owner !== ADMIN_OWNER ? owner : undefined;
        if (!this.config.sandbox && !this.addressSource(await this.merchantOf(op.request.merchantId), op.request.asset?.chain)) {
          return send(res, 200, { status: 'rejected', reason: 'no wallet is configured for this chain on your merchant account' });
        }
        const result = await this.receiver.apply(op);
        await this.watcher.tick();
        return send(res, 200, result);
      }

      // ---- sandbox
      if (path.startsWith('/v1/sandbox/')) {
        if (!this.config.sandbox) throw new HttpError(404, 'Sandbox is disabled');
        return send(res, 200, await this.sandbox(method, path, json, auth));
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof WalletConflictError) return send(res, 409, { error: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
      return send(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    }
  }

  // ------------------------------------------------------------ merchants (admin)

  private async adminMerchants(method: string, path: string, json: any, res: ServerResponse): Promise<void> {
    if (path === '/v1/admin/merchants') {
      if (method === 'GET') return send(res, 200, (await this.merchants.list()).map(toMerchantView));
      if (method === 'POST') {
        const input = validateMerchantInput(json);
        const { merchant, apiKey } = await this.merchants.create({ ...input, now: this.now() });
        // The API key and a generated webhook secret are returned exactly once, here.
        return send(res, 201, { merchant: toMerchantView(merchant), apiKey, webhookSecret: merchant.webhookSecret });
      }
      throw new HttpError(405, 'Use GET or POST');
    }
    const m = /^\/v1\/admin\/merchants\/(mch_[0-9a-f]+)(\/rotate-key|\/disable|\/enable|\/wallets)?$/.exec(path);
    if (!m) throw new HttpError(404, 'Not found');
    const id = m[1]!;
    const action = m[2];
    if (!action && method === 'GET') {
      const merchant = await this.merchants.get(id);
      if (!merchant) throw new HttpError(404, 'Unknown merchant');
      return send(res, 200, toMerchantView(merchant));
    }
    if (action === '/rotate-key' && method === 'POST') {
      const rotated = await this.merchants.rotateKey(id);
      if (!rotated) throw new HttpError(404, 'Unknown merchant');
      return send(res, 200, { merchant: toMerchantView(rotated.merchant), apiKey: rotated.apiKey });
    }
    if (action === '/wallets' && method === 'POST') {
      if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new HttpError(400, 'Body must be an object like { "evm": "xpub...", "tron": null }');
      const merchant = await this.merchants.setWallets(id, json);
      if (!merchant) throw new HttpError(404, 'Unknown merchant');
      return send(res, 200, toMerchantView(merchant));
    }
    if ((action === '/disable' || action === '/enable') && method === 'POST') {
      const merchant = await this.merchants.setDisabled(id, action === '/disable');
      if (!merchant) throw new HttpError(404, 'Unknown merchant');
      return send(res, 200, toMerchantView(merchant));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ------------------------------------------------------------ wallets

  private async merchantOf(id: string | undefined): Promise<Merchant | undefined> {
    return id ? this.merchants.get(id) : undefined;
  }

  /** The deriver for this merchant's wallet on `chain`, or undefined if they have none configured. */
  private addressSource(merchant: Merchant | undefined, chain: string | undefined): AddressDeriver | undefined {
    const family = chain ? walletFamilyForChain(chain) : undefined;
    const key = family ? merchant?.wallets?.[family] : undefined;
    if (!family || !key) return undefined;
    const cacheKey = `${family}:${key}`;
    let deriver = this.walletDerivers.get(cacheKey);
    if (!deriver) {
      deriver = deriverForWallet(family, key, chain);
      this.walletDerivers.set(cacheKey, deriver);
    }
    return deriver;
  }

  /**
   * Next unused derivation index for a merchant's wallet in one family. Resumes after a restart from the
   * payments already on record, so an address is never handed to two customers. Devices draw from their own
   * leased ranges, which sit above this server range, so the two can't collide either.
   */
  private nextWalletIndex(merchantId: string, family: WalletFamily): number {
    const key = `${merchantId}:${family}`;
    let next = this.walletCounters.get(key);
    if (next === undefined) {
      next = this.serverLease.start;
      for (const { request: r } of this.watcher.list()) {
        if (r.merchantId === merchantId && !r.offline && r.addressIndex !== undefined && walletFamilyForChain(r.asset.chain) === family) {
          if (r.addressIndex >= this.serverLease.start && r.addressIndex < this.serverLease.end) next = Math.max(next, r.addressIndex + 1);
        }
      }
    }
    if (next >= this.serverLease.end) throw new HttpError(409, 'This wallet has used all of its server address range');
    this.walletCounters.set(key, next + 1);
    return next;
  }

  // ------------------------------------------------------------ device ownership

  private async deviceOwner(deviceId: string): Promise<string | undefined> {
    return this.kv.get<string>(`device-owner:${deviceId}`);
  }

  /** First caller to lease a device owns it; nobody else can lease, renew or sync it afterwards. */
  private async claimDevice(deviceId: string, auth: Auth): Promise<void> {
    const me = auth.role === 'admin' ? ADMIN_OWNER : auth.merchant.id;
    const owner = await this.deviceOwner(deviceId);
    if (owner === undefined) {
      await this.kv.set(`device-owner:${deviceId}`, me);
    } else if (owner !== me && auth.role === 'merchant') {
      throw new HttpError(403, 'This device is registered to another merchant');
    }
  }

  // ------------------------------------------------------------ webhooks

  /** Sends an event to the owning merchant's endpoint, signed with that merchant's own secret — never anyone else's. */
  private async deliverWebhook(e: PaymentEvent): Promise<void> {
    const merchantId = this.watcher.get(e.paymentId)?.request.merchantId;
    if (!merchantId) {
      await this.dispatcher?.send(serializeEvent(e));
      return;
    }
    const merchant = await this.merchants.get(merchantId);
    if (!merchant?.webhookUrl || !merchant.webhookSecret || merchant.disabled) return;
    let dispatcher = this.merchantDispatchers.get(merchant.id);
    if (!dispatcher) {
      dispatcher = new WebhookDispatcher({ url: merchant.webhookUrl, secret: merchant.webhookSecret, fetch: globalThis.fetch as never });
      this.merchantDispatchers.set(merchant.id, dispatcher);
    }
    await dispatcher.send(serializeEvent(e));
  }

  // ------------------------------------------------------------ payments

  private async createPayment(input: any, auth: Auth) {
    const merchant = auth.role === 'merchant' ? auth.merchant : undefined;
    const currency: Currency | undefined = (CURRENCIES as Record<string, Currency>)[String(input.currency)];
    if (!currency) throw new HttpError(400, `Unsupported currency: ${input.currency}`);
    const asset = ASSET_LIST[String(input.asset)];
    if (!asset) throw new HttpError(400, `Unknown asset "${input.asset}". Try one of: ${Object.keys(ASSET_LIST).join(', ')}`);
    const chain = this.chains.get(asset.chain);
    if (!chain) throw new HttpError(400, `No chain adapter for ${asset.chain}`);
    const policy = withPolicy(mergePolicyOverrides(merchant?.policy, validatePolicyOverrides(input.policy)));
    const metadata = validateMetadata(input.metadata);

    // A merchant's customers pay into that merchant's own wallet. The shared sandbox address source is only a
    // stand-in for the sandbox; outside it, a merchant with no wallet for this chain can't take payments.
    const walletDeriver = this.addressSource(merchant, asset.chain);
    const family = walletFamilyForChain(asset.chain);
    if (!walletDeriver && !this.config.sandbox) {
      throw new HttpError(
        400,
        merchant
          ? `No ${family ?? asset.chain} wallet is configured on your account, so payments on ${asset.chain} can't be created. Ask the operator to set one.`
          : 'Live payments are created with a merchant API key that has a wallet; the admin key has none to pay into.',
      );
    }

    const snapshot = await this.getSnapshot({ base: asset.symbol, quote: currency.code, direction: 'CRYPTO_TO_FIAT', spreadBps: merchant?.spreadBps });
    const { index, address } = await this.issueAddress(chain, asset, walletDeriver, merchant, family);    const request = createPaymentRequest({
      fiat: { currency: currency.code, amountMinor: parseUnits(String(input.amount), currency.decimals) },
      asset,
      address,
      addressIndex: index,
      snapshot,
      policy,
      now: this.now(),
      metadata,
      merchantId: merchant?.id,
    });
    await this.payments?.save(request);
    this.watcher.watch(request);
    return view(this.watcher.get(request.id)!);
  }

  /**
   * Picks the next deposit address, skipping any that already have funds on chain. A merchant importing a
   * wallet with history would otherwise be handed used addresses, and a payment must never be "paid" by old
   * money. Gives up after a run of used addresses, as wallets do with their gap limit.
   */
  private async issueAddress(chain: ChainAdapter, asset: Asset, walletDeriver: AddressDeriver | undefined, merchant: Merchant | undefined, family: WalletFamily | undefined) {
    const MAX_USED_IN_A_ROW = 20;
    for (let attempt = 0; attempt < MAX_USED_IN_A_ROW; attempt++) {
      const index = walletDeriver ? this.nextWalletIndex(merchant!.id, family!) : this.nextIndex++;
      const address = (walletDeriver ?? this.deriver).derive(index);
      let existing;
      try {
        existing = await chain.getDeposits(address, asset.symbol);
      } catch (err) {
        // If we can't tell whether the address is unused, don't hand it to a customer.
        throw new HttpError(503, `Could not confirm that the deposit address is unused (${err instanceof Error ? err.message : String(err)}). Try again shortly.`);
      }
      if (existing.length === 0) return { index, address };
    }
    throw new HttpError(409, `The last ${MAX_USED_IN_A_ROW} addresses in this wallet already have funds. Use a fresh wallet, or ask the operator to check it.`);
  }

  /** Operator view: is the server healthy and is it actually keeping up with the chain? */
  private status() {
    const all = this.watcher.list();
    const byStatus: Record<string, number> = {};
    for (const w of all) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    return {
      mode: this.config.sandbox ? 'sandbox' : 'live',
      chains: [...this.chains.keys()],
      rateSources: this.config.sandbox ? this.prices.map((p) => p.name) : this.config.rateProviders!.map((p) => p.name),
      pollIntervalMs: this.config.pollIntervalMs ?? (this.config.sandbox ? 1_000 : 5_000),
      lastPoll: this.lastTick ? { at: this.lastTick.at, tookMs: this.lastTick.ms, agoMs: this.now() - this.lastTick.at } : null,
      payments: { total: all.length, byStatus },
      // Payments whose chain check is failing right now (rate-limited or unreachable node). Empty is healthy.
      chainErrors: all.filter((w) => w.lastError).map((w) => ({ paymentId: w.request.id, chain: w.request.asset.chain, ...w.lastError })),
    };
  }

  private getPayment(id: string, auth: Auth) {
    const w = this.watcher.get(id);
    // Someone else's payment answers exactly like one that doesn't exist, so ids can't be probed.
    if (!w || !this.canSee(auth, w.request)) throw new HttpError(404, 'Unknown payment');
    return view(w);
  }

  /** Fetches a fresh snapshot and, if a store is configured, persists it to the durable rate-audit chain. */
  private async getSnapshot(req: Parameters<RateEngine['getSnapshot']>[0]): Promise<RateSnapshot> {
    let snapshot: RateSnapshot;
    try {
      snapshot = await this.engine.getSnapshot(req);
    } catch (err) {
      throw new HttpError(503, `No exchange rate available right now: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  private async sandbox(method: string, path: string, json: any, auth: Auth) {
    const out = await this.sandboxAction(method, path, json, auth);
    await this.watcher.tick();
    return out;
  }

  private async sandboxAction(method: string, path: string, json: any, auth: Auth): Promise<unknown> {
    if (method !== 'POST') throw new HttpError(405, 'Use POST');
    if (path === '/v1/sandbox/deposit') {
      const w = this.watcher.get(String(json.paymentId));
      if (!w || !this.canSee(auth, w.request)) throw new HttpError(404, 'Unknown payment');
      const chain = this.fakeChains.get(w.request.asset.chain);
      if (!chain) throw new HttpError(400, 'Simulated deposits need the sandbox fake chain');
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
    // The rest change global state (every tenant's chain, clock and market), so they are operator-only.
    this.requireAdmin(auth);
    if (path === '/v1/sandbox/mine') {
      for (const c of this.fakeChains.values()) c.mine(Number(json.blocks ?? 1));
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

type Auth = { role: 'admin' } | { role: 'merchant'; merchant: Merchant };

/** Owner marker for devices the operator registered directly, so no merchant can claim them later. */
const ADMIN_OWNER = 'admin';

function validDeviceId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(v)) throw new HttpError(400, 'deviceId must be 1-64 characters: letters, digits, "_", "-" or "."');
  return v;
}

function validLeaseSize(v: unknown): number {
  if (v === undefined) return 1_000;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100_000) throw new HttpError(400, 'size must be an integer between 1 and 100000');
  return v;
}

function validateMetadata(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'metadata must be an object of string values');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 20) throw new HttpError(400, 'metadata can have at most 20 keys');
  for (const [k, val] of entries) {
    if (typeof val !== 'string' || val.length > 500 || k.length > 40) throw new HttpError(400, 'metadata keys must be under 40 characters and values must be strings under 500 characters');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function validateMerchantInput(v: any) {
  if (typeof v !== 'object' || v === null) throw new HttpError(400, 'Body must be a JSON object');
  const allowed = ['name', 'webhookUrl', 'webhookSecret', 'spreadBps', 'policy', 'wallets'];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field "${k}". Allowed: ${allowed.join(', ')}`);
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100) throw new HttpError(400, 'name is required (max 100 characters)');
  if (v.webhookUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(String(v.webhookUrl));
    } catch {
      throw new HttpError(400, 'webhookUrl must be a valid URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'webhookUrl must be http(s)');
  }
  if (v.webhookSecret !== undefined && (typeof v.webhookSecret !== 'string' || v.webhookSecret.length < 8)) throw new HttpError(400, 'webhookSecret must be a string of at least 8 characters');
  return {
    name: v.name as string,
    webhookUrl: v.webhookUrl as string | undefined,
    webhookSecret: v.webhookSecret as string | undefined,
    spreadBps: v.spreadBps as number | undefined,
    policy: validatePolicyOverrides(v.policy),
    wallets: v.wallets as Record<string, string> | undefined,
  };
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
    merchantId: request.merchantId,
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

