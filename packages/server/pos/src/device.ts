/**
 * The till's brain: pairing, selling with no connection, and syncing. No DOM in here, so the whole flow can be
 * tested against a real server in Node (see packages/server/test/pos-device.test.ts) and reused by other front-ends.
 *
 * Everything that makes a sale work offline is `OfflinePOS` from @paycryt/core (local address derivation, hash-sealed
 * cached rates plus a safety margin, an idempotent queue). This class adds what a real device needs around it:
 * pairing with a merchant key, lease renewal, a sales list, and being careful about what "online" means.
 */
import {
  ASSETS,
  CURRENCIES,
  FakeChain,
  LeaseExhaustedError,
  OfflinePOS,
  RateTooStaleError,
  deriverForWallet,
  parseUnits,
  toJson,
  walletFamilyForChain,
  type AddressDeriver,
  type Asset,
  type KVStore,
  type RateSnapshot,
  type SyncOp,
  type SyncResponse,
  type SyncTransport,
  type WalletFamily,
} from '@paycryt/core';

export type SaleStatus = 'queued' | 'synced' | 'rejected';

export interface Sale {
  id: string;
  createdAt: number;
  expiresAt: number;
  fiat: { currency: string; amountMinor: bigint };
  assetKey: string;
  asset: Asset;
  address: string;
  amountDue: bigint;
  effectiveRate: string;
  /** Priced while the device could not reach the server, so it carries the offline safety margin. */
  pricedOffline: boolean;
  note?: string;
  /** queued = only on this device so far; synced = the server has it; rejected = the server refused it (see `reason`). */
  status: SaleStatus;
  reason?: string;
  /** The server's view once synced: awaiting_payment, confirming, paid, ... */
  serverStatus?: string;
  received?: bigint;
}

export interface DeviceConfig {
  version: 1;
  deviceId: string;
  apiKey: string;
  merchant: { id: string; name: string; wallets: Partial<Record<WalletFamily, string>>; spreadBps?: number };
  /** Sandbox servers hand out fake addresses to a merchant with no wallet; a live server never does. */
  sandbox: boolean;
  /** The one currency this till sells in. */
  currency: string;
  /** Chains the server is actually watching. */
  chains: string[];
  leases: Array<{ start: number; end: number }>;
  /** `SYMBOL/CUR` -> when the cached rate snapshot was issued. */
  rates: Record<string, number>;
  pairedAt: number;
  forceOffline: boolean;
}

export interface DeviceStatus {
  paired: boolean;
  online: boolean;
  forceOffline: boolean;
  queued: number;
  leaseRemaining: number;
  lastSyncAt?: number;
  lastError?: string;
  rates: Array<{ pair: string; ageMs: number }>;
}

export interface SyncReport {
  attempted: boolean;
  accepted: number;
  duplicates: number;
  rejected: number;
  remaining: number;
}

export class NetworkError extends Error {
  constructor(message = 'Cannot reach the server') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface DeviceOptions {
  store: KVStore;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Server base URL. Empty means same origin, which is how the browser app runs. */
  baseUrl?: string;
  clock?: () => number;
}

const CONFIG_KEY = 'device:config';
const SALE_PREFIX = 'sale:';
const RATE_MAX_AGE_MS = 6 * 3_600_000; // matches OfflinePOS's default refusal point
const LEASE_SIZE = 200;
const FINAL_STATUSES = ['paid', 'overpaid', 'expired', 'refund_required', 'manual_review'];

const NO_DERIVER: AddressDeriver = {
  chain: 'none',
  derive() {
    throw new Error('this OfflinePOS instance is only used to cache rates and sync');
  },
};

const saleKey = (s: { createdAt: number; id: string }) => `${SALE_PREFIX}${String(s.createdAt).padStart(15, '0')}:${s.id}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export class PosDevice {
  private config?: DeviceConfig;
  private reachable = false;
  private lastSyncAt?: number;
  private lastError?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: KVStore;
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly clock: () => number;

  private constructor(o: DeviceOptions) {
    this.store = o.store;
    this.fetchFn = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.base = (o.baseUrl ?? '').replace(/\/+$/, '');
    this.clock = o.clock ?? Date.now;
  }

  /** Loads the saved pairing, if this device has one. */
  static async open(o: DeviceOptions): Promise<PosDevice> {
    const d = new PosDevice(o);
    d.config = await o.store.get<DeviceConfig>(CONFIG_KEY);
    return d;
  }

  get paired(): boolean {
    return !!this.config;
  }
  get deviceConfig(): Readonly<DeviceConfig> | undefined {
    return this.config;
  }
  /** True only when the server was reachable on the last attempt AND the cashier has not switched to offline mode. */
  get online(): boolean {
    return this.reachable && !this.config?.forceOffline;
  }
  get error(): string | undefined {
    return this.lastError;
  }

  // ---------------------------------------------------------------- network

  private async http(path: string, init: { method?: string; body?: string; key?: string | null; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
    if (this.config?.forceOffline && init.key === undefined) throw new NetworkError('Offline mode is on');
    const headers: Record<string, string> = {};
    const key = init.key === undefined ? this.config?.apiKey : init.key;
    if (key) headers.authorization = `Bearer ${key}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(init.timeoutMs ?? 8_000) });
    } catch (err) {
      this.reachable = false;
      throw new NetworkError(err instanceof Error ? err.message : undefined);
    }
    this.reachable = true; // the server answered, whatever it said
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, body };
  }

  private async api(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<any> {
    const r = await this.http(path, { method: init.method, key: init.key, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    if (r.status === 401) throw new ApiError(401, 'The server did not accept this device’s API key. It may have been rotated or the merchant disabled.');
    if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.body?.error ?? `The server answered ${r.status}`);
    return r.body;
  }

  /** Cheap reachability check. Use before deciding whether to price with the offline margin. */
  async probe(): Promise<boolean> {
    if (this.config?.forceOffline) {
      this.reachable = false;
      return false;
    }
    try {
      await this.http('/health', { key: null, timeoutMs: 3_000 });
    } catch {
      /* reachable is already false */
    }
    return this.online;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- pairing

  async pair(input: { apiKey: string; currency: string; deviceName?: string; leaseSize?: number }): Promise<void> {
    const key = input.apiKey.trim();
    if (!key) throw new Error('Enter the merchant API key.');
    if (!(input.currency in CURRENCIES)) throw new Error(`Unsupported currency ${input.currency}.`);
    // A fresh suffix every time: re-pairing under an old name could be handed the old lease back while this
    // device's own address cursor is gone, which would reuse addresses.
    const suffix = Math.random().toString(36).slice(2, 6);
    const deviceId = `${slug(input.deviceName ?? '') || 'till'}-${suffix}`;

    const health = (await this.http('/health', { key: null })).body;
    const me = await this.api('/v1/me', { key });
    if (me.role !== 'merchant') {
      throw new Error('That is the operator key. A till needs a merchant key: add a merchant in the dashboard and use the key it shows once.');
    }
    const catalog = await this.api('/v1/assets', { key });
    const lease = await this.api('/v1/leases', { method: 'POST', key, body: { deviceId, size: input.leaseSize ?? LEASE_SIZE } });

    this.config = {
      version: 1,
      deviceId,
      apiKey: key,
      merchant: { id: me.merchant.id, name: me.merchant.name, wallets: me.merchant.wallets ?? {}, spreadBps: me.merchant.spreadBps },
      sandbox: !!health?.sandbox,
      currency: input.currency,
      chains: catalog.chains,
      leases: [{ start: lease.start, end: lease.end }],
      rates: {},
      pairedAt: this.clock(),
      forceOffline: false,
    };
    await this.save();
    await this.refreshRates();
  }

  private requireConfig(): DeviceConfig {
    if (!this.config) throw new Error('This device is not paired yet.');
    return this.config;
  }

  private async save(): Promise<void> {
    if (this.config) await this.store.set(CONFIG_KEY, this.config);
  }

  async setForceOffline(on: boolean): Promise<void> {
    const cfg = this.requireConfig();
    cfg.forceOffline = on;
    if (on) this.reachable = false;
    await this.save();
    if (!on) await this.probe();
  }

  // ---------------------------------------------------------------- assets and addresses

  private deriverFor(asset: Asset): AddressDeriver | undefined {
    const cfg = this.requireConfig();
    const family = walletFamilyForChain(asset.chain);
    const key = family ? cfg.merchant.wallets[family] : undefined;
    if (family && key) return deriverForWallet(family, key, asset.chain);
    // A sandbox server gives wallet-less merchants fake addresses (and checks them the same way). A live one never does.
    return cfg.sandbox ? new FakeChain('sandbox') : undefined;
  }

  /** Assets this shop could sell: the server watches the chain and the merchant has somewhere to be paid. */
  candidateKeys(): string[] {
    const cfg = this.requireConfig();
    return Object.entries(ASSETS as Record<string, Asset>)
      .filter(([, a]) => cfg.chains.includes(a.chain) && !!this.deriverFor(a))
      .map(([k]) => k);
  }

  /** Candidates that also have a cached rate in the shop currency, so a sale can actually be priced. */
  sellableKeys(): string[] {
    const cfg = this.requireConfig();
    return this.candidateKeys().filter((k) => `${(ASSETS as Record<string, Asset>)[k]!.symbol}/${cfg.currency}` in cfg.rates);
  }

  private currentLease(): { start: number; end: number } {
    const cfg = this.requireConfig();
    return cfg.leases[cfg.leases.length - 1]!;
  }

  private pos(deriver: AddressDeriver = NO_DERIVER): OfflinePOS {
    const cfg = this.requireConfig();
    return new OfflinePOS({
      deviceId: cfg.deviceId,
      deriver,
      lease: this.currentLease(),
      store: this.store,
      clock: this.clock,
      isOnline: () => this.online,
    });
  }

  // ---------------------------------------------------------------- rates and leases (online)

  /** Downloads a fresh, hash-sealed rate for each sellable pair. Returns the pairs that could not be fetched. */
  refreshRates(): Promise<{ failed: string[] }> {
    return this.serial(async () => {
      const cfg = this.requireConfig();
      const symbols = [...new Set(this.candidateKeys().map((k) => (ASSETS as Record<string, Asset>)[k]!.symbol))];
      const pos = this.pos();
      const failed: string[] = [];
      for (const symbol of symbols) {
        const pair = `${symbol}/${cfg.currency}`;
        try {
          const snapshot = (await this.api(`/v1/rates/${symbol}-${cfg.currency}`)) as RateSnapshot;
          await pos.cacheSnapshot(snapshot); // rejects anything whose hash does not match its contents
          cfg.rates[pair] = snapshot.createdAt;
        } catch (err) {
          if (err instanceof NetworkError) throw err;
          failed.push(pair);
        }
      }
      await this.save();
      return { failed };
    });
  }

  private async renewLeaseNow(): Promise<void> {
    const cfg = this.requireConfig();
    const lease = await this.api('/v1/leases/renew', { method: 'POST', body: { deviceId: cfg.deviceId, size: LEASE_SIZE } });
    cfg.leases.push({ start: lease.start, end: lease.end });
    await this.save();
  }

  /** Everything worth doing whenever there is a connection: fresh rates, current wallets, and a lease top-up. */
  refresh(): Promise<{ failed: string[] }> {
    return this.serial(async () => {
      const cfg = this.requireConfig();
      const me = await this.api('/v1/me');
      cfg.merchant = { id: me.merchant.id, name: me.merchant.name, wallets: me.merchant.wallets ?? {}, spreadBps: me.merchant.spreadBps };
      cfg.chains = (await this.api('/v1/assets')).chains;
      await this.save();
      if ((await this.pos().leaseRemaining()) < Math.max(10, LEASE_SIZE / 10)) await this.renewLeaseNow();
      return { failed: [] as string[] };
    }).then(async (r) => ({ failed: [...r.failed, ...(await this.refreshRates()).failed] }));
  }

  // ---------------------------------------------------------------- selling (works offline)

  sell(input: { amount: string; assetKey: string; note?: string }): Promise<Sale> {
    return this.serial(async () => {
      const cfg = this.requireConfig();
      const asset = (ASSETS as Record<string, Asset>)[input.assetKey];
      if (!asset) throw new Error('Choose what the customer pays in.');
      const deriver = this.deriverFor(asset);
      if (!deriver || !cfg.chains.includes(asset.chain)) throw new Error(`${asset.symbol} on ${asset.chain} is not set up for this shop.`);
      const currency = CURRENCIES[cfg.currency as keyof typeof CURRENCIES];
      let amountMinor: bigint;
      try {
        amountMinor = parseUnits(input.amount.trim(), currency.decimals);
      } catch {
        throw new Error('Enter a valid amount.');
      }
      if (amountMinor <= 0n) throw new Error('Enter an amount above zero.');

      const note = input.note?.trim() || undefined;
      const create = () => this.pos(deriver).createPayment({ fiat: { currency: cfg.currency, amountMinor }, asset, metadata: note ? { note } : undefined });
      const wasOnline = this.online;
      let made;
      try {
        made = await create();
      } catch (err) {
        const rateProblem = err instanceof RateTooStaleError || (err instanceof Error && err.message.startsWith('No cached rate'));
        if (err instanceof LeaseExhaustedError && this.online) {
          await this.renewLeaseNow();
          made = await create();
        } else if (rateProblem && this.online) {
          await this.refreshRatesInline();
          made = await create();
        } else if (err instanceof LeaseExhaustedError) {
          throw new Error('This till has used all of its addresses. Connect to the internet once so it can get more.');
        } else if (rateProblem) {
          throw new Error('The saved exchange rate is too old to sell with. Connect to the internet once to refresh it.');
        } else {
          throw err;
        }
      }
      const r = made.request;
      const sale: Sale = {
        id: r.id,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        fiat: { currency: cfg.currency, amountMinor },
        assetKey: input.assetKey,
        asset,
        address: r.address,
        amountDue: r.amountDue,
        effectiveRate: r.effectiveRate,
        pricedOffline: !wasOnline,
        note,
        status: 'queued',
      };
      await this.store.set(saleKey(sale), sale);
      return sale;
    });
  }

  /** Rate refresh from inside an already-serialised operation (no re-queueing, or it would deadlock). */
  private async refreshRatesInline(): Promise<void> {
    const cfg = this.requireConfig();
    const pos = this.pos();
    for (const symbol of new Set(this.candidateKeys().map((k) => (ASSETS as Record<string, Asset>)[k]!.symbol))) {
      const snapshot = (await this.api(`/v1/rates/${symbol}-${cfg.currency}`)) as RateSnapshot;
      try {
        await pos.cacheSnapshot(snapshot);
      } catch {
        throw new Error(`The server sent a ${symbol}/${cfg.currency} rate that failed its integrity check, so it was not used. Try again, and tell the operator if it keeps happening.`);
      }
      cfg.rates[`${symbol}/${cfg.currency}`] = snapshot.createdAt;
    }
    await this.save();
  }

  // ---------------------------------------------------------------- sales and sync

  async sales(): Promise<Sale[]> {
    const keys = await this.store.keys(SALE_PREFIX);
    const all = await Promise.all(keys.map((k) => this.store.get<Sale>(k)));
    return all.filter((s): s is Sale => !!s).reverse(); // newest first
  }

  private async updateSale(id: string, patch: Partial<Sale>): Promise<void> {
    const sale = (await this.sales()).find((s) => s.id === id);
    if (!sale) return;
    await this.store.set(saleKey(sale), { ...sale, ...patch });
  }

  private async pushOp(op: SyncOp): Promise<SyncResponse> {
    const r = await this.http('/v1/sync', { method: 'POST', body: toJson(op), timeoutMs: 15_000 });
    const status = r.body?.status;
    if (status === 'accepted' || status === 'duplicate' || status === 'rejected') return r.body as SyncResponse;
    // Not an answer about this sale (auth failure, rate limit, server error): throw, so the sale stays queued.
    if (r.status === 401) throw new ApiError(401, 'The server did not accept this device’s API key.');
    throw new ApiError(r.status, r.body?.error ?? `The server answered ${r.status}`);
  }

  /** Sends every queued sale and then refreshes what the server says about the ones it has. Safe to call at any time. */
  sync(): Promise<SyncReport> {
    return this.serial(async () => {
      this.requireConfig();
      const none: SyncReport = { attempted: false, accepted: 0, duplicates: 0, rejected: 0, remaining: (await this.pos().pending()).length };
      if (!(await this.probe())) return none;
      const results = new Map<string, SyncResponse>();
      // OfflinePOS.sync stops quietly at the first delivery failure and leaves the sale queued, which is right, but
      // it also swallows the reason. Capture it here so the cashier is told why sales are stuck.
      let stoppedBecause: Error | undefined;
      const transport: SyncTransport = {
        push: async (op) => {
          try {
            const res = await this.pushOp(op);
            results.set(op.request.id, res);
            return res;
          } catch (err) {
            stoppedBecause = err instanceof Error ? err : new Error(String(err));
            throw err;
          }
        },
      };
      const summary = await this.pos().sync(transport);
      const why = stoppedBecause as Error | undefined;
      this.lastError = !why ? undefined : why instanceof NetworkError ? 'Lost the connection part-way. The rest will be sent when it is back.' : why.message;
      for (const [id, res] of results) {
        if (res.status === 'rejected') await this.updateSale(id, { status: 'rejected', reason: res.reason });
        else await this.updateSale(id, { status: 'synced' });
      }
      this.lastSyncAt = this.clock();
      await this.refreshServerStatuses();
      return { attempted: true, ...summary };
    });
  }

  /** Asks the server how the synced sales are doing (paid yet?). One request for all of them. */
  private async refreshServerStatuses(): Promise<void> {
    const open = (await this.sales()).filter((s) => s.status === 'synced' && !FINAL_STATUSES.includes(s.serverStatus ?? ''));
    if (!open.length) return;
    let list: any[];
    try {
      list = await this.api('/v1/payments');
    } catch {
      return;
    }
    const byId = new Map(list.map((p) => [p.id, p]));
    for (const s of open) {
      const p = byId.get(s.id);
      if (!p) continue;
      await this.updateSale(s.id, { serverStatus: p.status, received: BigInt(p.received ?? '0') });
    }
  }

  /** Whether there is anything the cashier should be told about, for the header badge. */
  async status(): Promise<DeviceStatus> {
    if (!this.config) return { paired: false, online: this.reachable, forceOffline: false, queued: 0, leaseRemaining: 0, rates: [] };
    const now = this.clock();
    return {
      paired: true,
      online: this.online,
      forceOffline: this.config.forceOffline,
      queued: (await this.pos().pending()).length,
      leaseRemaining: await this.pos().leaseRemaining(),
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      rates: Object.entries(this.config.rates).map(([pair, at]) => ({ pair, ageMs: now - at })),
    };
  }

  /** Sales the server refused after the customer may have paid: the cashier must see these. */
  async rejectedSales(): Promise<Sale[]> {
    return (await this.sales()).filter((s) => s.status === 'rejected');
  }

  /** True when a cached rate is old enough that a sale would be refused. */
  rateIsStale(pair: string): boolean {
    const at = this.config?.rates[pair];
    return at === undefined || this.clock() - at > RATE_MAX_AGE_MS;
  }

  /**
   * Wipes this device: pairing, rates, queue and sales. Refuses while sales have not reached the server, because
   * those exist nowhere else and the customer may already have paid them.
   */
  async forget(opts: { discardUnsynced?: boolean } = {}): Promise<void> {
    if (this.config) {
      const queued = (await this.pos().pending()).length;
      if (queued > 0 && !opts.discardUnsynced) {
        throw new Error(`${queued} sale${queued === 1 ? ' has' : 's have'} not reached the server yet and exist only on this device. Sync first, or choose to discard them.`);
      }
    }
    for (const key of await this.store.keys('')) await this.store.delete(key);
    this.config = undefined;
    this.reachable = false;
  }
}
