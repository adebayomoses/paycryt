import type { Asset } from '../amount.js';
import { randomId } from '../hash.js';
import { DEFAULT_POLICY, type PaymentPolicy } from '../payments/policy.js';
import { createPaymentRequest, paymentUri } from '../payments/request.js';
import type { PaymentRequest } from '../payments/types.js';
import type { RateEngine } from '../rates/engine.js';
import { type RateSnapshot, deriveSnapshot, verifySnapshot } from '../rates/snapshot.js';
import type { KVStore } from '../serialize.js';
import type { AddressDeriver } from '../wallet/derive.js';

/** A change made while offline, waiting to be replayed against the server. */
export interface SyncOp {
  /** Idempotency key. The server applies each opId at most once. */
  opId: string;
  deviceId: string;
  type: 'payment.create';
  createdAt: number;
  request: PaymentRequest;
  /** Full rate lineage (cached parent first, offline-derived last) so the server can audit the price. */
  snapshots: RateSnapshot[];
  addressIndex: number;
}

export type SyncResponse = { status: 'accepted' | 'duplicate' } | { status: 'rejected'; reason: string };

export interface SyncTransport {
  push(op: SyncOp): Promise<SyncResponse>;
}

export class RateTooStaleError extends Error {
  constructor(pair: string, ageMs: number, maxMs: number) {
    super(`Cached ${pair} rate is ${Math.round(ageMs / 60_000)} min old (max ${Math.round(maxMs / 60_000)} min). Connect to refresh rates.`);
    this.name = 'RateTooStaleError';
  }
}

export class LeaseExhaustedError extends Error {
  constructor() {
    super('This device has used all of its leased addresses. Connect to sync and get a new lease.');
    this.name = 'LeaseExhaustedError';
  }
}

export interface OfflinePOSOptions {
  deviceId: string;
  /** Derives addresses locally from an xpub. Needs no network. */
  deriver: AddressDeriver;
  /** The slice of address indexes this device owns: [start, end). Other devices get disjoint slices. */
  lease: { start: number; end: number };
  store: KVStore;
  policy?: PaymentPolicy;
  clock?: () => number;
  /** Is the device online right now? Offline payments carry an extra safety margin. Default: assume offline. */
  isOnline?: () => boolean;
  /** Refuse to price from a cached rate older than this. Default 6h. */
  maxRateAgeMs?: number;
  /** Extra margin against the customer while offline, covering price movement you cannot see. Default 150 bps (1.5%). */
  offlineSpreadBps?: number;
  /** How long an offline-priced request stays payable. Default 30 min. */
  offlineExpiryMs?: number;
}

const K = { rate: (pair: string) => `rate:${pair}`, req: (id: string) => `req:${id}`, op: (n: string) => `queue:${n}`, next: 'lease:next', seq: 'queue-seq', dead: (id: string) => `dead:${id}` };

/**
 * A point-of-sale that keeps working with no internet:
 *  1. Online: `cacheRates()` stores fresh, hash-sealed rate snapshots on the device.
 *  2. Offline: `createPayment()` derives a deposit address locally, prices from the cached rate plus a safety margin,
 *     and queues the request.
 *  3. Back online: `sync()` replays the queue. The server re-checks every price and address before trusting it.
 */
export class OfflinePOS {
  private readonly clock: () => number;
  private readonly policy: PaymentPolicy;

  constructor(private readonly o: OfflinePOSOptions) {
    this.clock = o.clock ?? Date.now;
    this.policy = o.policy ?? DEFAULT_POLICY;
  }

  /** Online-only: fetch and store a fresh CRYPTO_TO_FIAT snapshot for each pair. */
  async cacheRates(engine: RateEngine, pairs: Array<{ base: string; quote: string; spreadBps?: number }>): Promise<void> {
    for (const p of pairs) {
      const snapshot = await engine.getSnapshot({ ...p, direction: 'CRYPTO_TO_FIAT' });
      await this.o.store.set(K.rate(`${p.base}/${p.quote}`), snapshot);
    }
  }

  /** Online-only: store a snapshot fetched from your server (e.g. `GET /v1/rates/USDT-NGN`). Rejects tampered snapshots. */
  async cacheSnapshot(snapshot: RateSnapshot): Promise<void> {
    if (!verifySnapshot(snapshot)) throw new Error('Snapshot failed its integrity check');
    if (snapshot.direction !== 'CRYPTO_TO_FIAT') throw new Error('POS devices cache CRYPTO_TO_FIAT snapshots');
    await this.o.store.set(K.rate(`${snapshot.base}/${snapshot.quote}`), snapshot);
  }

  async createPayment(input: {
    fiat: { currency: string; amountMinor: bigint };
    asset: Asset;
    metadata?: Record<string, string>;
  }): Promise<{ request: PaymentRequest; uri: string }> {
    const now = this.clock();
    const pair = `${input.asset.symbol}/${input.fiat.currency}`;
    const cached = await this.o.store.get<RateSnapshot>(K.rate(pair));
    if (!cached) throw new Error(`No cached rate for ${pair}. Connect once to download rates.`);
    if (!verifySnapshot(cached)) throw new Error(`Cached rate for ${pair} failed its integrity check`);
    const maxAge = this.o.maxRateAgeMs ?? 6 * 3_600_000;
    if (now - cached.createdAt > maxAge) throw new RateTooStaleError(pair, now - cached.createdAt, maxAge);

    const online = this.o.isOnline?.() ?? false;
    const snapshots: RateSnapshot[] = [cached];
    let priced = cached;
    const policy = online ? this.policy : { ...this.policy, expiryMs: this.o.offlineExpiryMs ?? 30 * 60_000 };
    if (!online) {
      priced = deriveSnapshot(cached, {
        extraSpreadBps: this.o.offlineSpreadBps ?? 150,
        reason: `offline safety margin (device ${this.o.deviceId})`,
        now,
        lockedUntil: now + policy.expiryMs,
        prevHash: cached.hash,
      });
      snapshots.push(priced);
    } else if (now > cached.lockedUntil) {
      // Online but the cached lock lapsed: re-lock the same market rate for a short window rather than fail the sale.
      priced = deriveSnapshot(cached, { extraSpreadBps: 0, reason: 'cached rate re-locked', now, lockedUntil: now + policy.expiryMs, prevHash: cached.hash });
      snapshots.push(priced);
    }

    const index = await this.leaseIndex();
    const request = createPaymentRequest({
      fiat: input.fiat,
      asset: input.asset,
      address: this.o.deriver.derive(index),
      addressIndex: index,
      snapshot: priced,
      policy,
      now,
      offline: { deviceId: this.o.deviceId, createdOfflineAt: now },
      metadata: input.metadata,
    });

    await this.o.store.set(K.req(request.id), request);
    const seq = await this.nextSeq();
    const op: SyncOp = { opId: randomId('op'), deviceId: this.o.deviceId, type: 'payment.create', createdAt: now, request, snapshots, addressIndex: index };
    await this.o.store.set(K.op(seq), op);
    return { request, uri: paymentUri(request) };
  }

  async pending(): Promise<SyncOp[]> {
    const keys = await this.o.store.keys('queue:');
    return (await Promise.all(keys.map((k) => this.o.store.get<SyncOp>(k)))).filter((o): o is SyncOp => !!o);
  }

  /** Requests the server refused. Surface these to the cashier: the customer may already have paid. */
  async rejected(): Promise<Array<{ op: SyncOp; reason: string }>> {
    const keys = await this.o.store.keys('dead:');
    return (await Promise.all(keys.map((k) => this.o.store.get<{ op: SyncOp; reason: string }>(k)))).filter((x): x is { op: SyncOp; reason: string } => !!x);
  }

  async getPayment(id: string): Promise<PaymentRequest | undefined> {
    return this.o.store.get<PaymentRequest>(K.req(id));
  }

  /**
   * Replay queued operations in order. Stops at the first network failure so ordering is preserved;
   * the remainder stays queued for the next attempt.
   */
  async sync(transport: SyncTransport): Promise<{ accepted: number; duplicates: number; rejected: number; remaining: number }> {
    const summary = { accepted: 0, duplicates: 0, rejected: 0, remaining: 0 };
    const keys = await this.o.store.keys('queue:');
    for (const key of keys) {
      const op = await this.o.store.get<SyncOp>(key);
      if (!op) continue;
      let res: SyncResponse;
      try {
        res = await transport.push(op);
      } catch {
        break;
      }
      if (res.status === 'accepted') summary.accepted++;
      else if (res.status === 'duplicate') summary.duplicates++;
      else if (res.status === 'rejected') {
        summary.rejected++;
        await this.o.store.set(K.dead(op.opId), { op, reason: res.reason });
      }
      await this.o.store.delete(key);
    }
    summary.remaining = (await this.o.store.keys('queue:')).length;
    return summary;
  }

  private async leaseIndex(): Promise<number> {
    const next = (await this.o.store.get<number>(K.next)) ?? this.o.lease.start;
    if (next >= this.o.lease.end) throw new LeaseExhaustedError();
    await this.o.store.set(K.next, next + 1);
    return next;
  }

  /** Zero-padded so lexicographic key order equals insertion order. */
  private async nextSeq(): Promise<string> {
    const n = ((await this.o.store.get<number>(K.seq)) ?? 0) + 1;
    await this.o.store.set(K.seq, n);
    return String(n).padStart(10, '0');
  }
}

