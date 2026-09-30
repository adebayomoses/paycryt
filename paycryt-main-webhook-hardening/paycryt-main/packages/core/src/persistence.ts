import { LeaseRegistry, type LeaseRegistrySnapshot } from './offline/receiver.js';
import type { PaymentRequest } from './payments/types.js';
import type { RateSnapshot } from './rates/snapshot.js';
import type { KVStore } from './serialize.js';

/**
 * Durable payment-request storage over any `KVStore`, so a server can reload every in-flight payment
 * after a restart and hand them back to a fresh `PaymentWatcher` via `watcher.watch(request)`.
 *
 * This does not persist chain-deposit history: on a real chain, the chain itself is that history, and
 * the watcher re-discovers deposits on its next poll. Only the fake-chain sandbox loses deposit history
 * across a restart, because the fake chain was never meant to be durable.
 */
export class PaymentRequestStore {
  constructor(private readonly store: KVStore) {}

  async save(request: PaymentRequest): Promise<void> {
    await this.store.set(`payment:${request.id}`, request);
  }

  async get(id: string): Promise<PaymentRequest | undefined> {
    return this.store.get<PaymentRequest>(`payment:${id}`);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(`payment:${id}`);
  }

  /** Every stored payment request, in no particular order. */
  async all(): Promise<PaymentRequest[]> {
    const keys = await this.store.keys('payment:');
    const requests = await Promise.all(keys.map((k) => this.store.get<PaymentRequest>(k)));
    return requests.filter((r): r is PaymentRequest => !!r);
  }
}

/**
 * Durable, order-preserving storage for a rate-snapshot chain, so `RateAuditLog` survives a restart with
 * its hash chain intact. Snapshots are stored under a zero-padded sequence number, so `loadAll()` returns
 * them in the exact order they were appended — the order the hash chain (`prevHash`) requires.
 */
export class RateSnapshotStore {
  constructor(private readonly store: KVStore) {}

  /** Call this every time your `RateEngine` mints a new snapshot (it's already appended to `engine.log` by then). */
  async append(snapshot: RateSnapshot): Promise<void> {
    const seq = await this.nextSeq();
    await this.store.set(`ratesnapshot:${seq}`, snapshot);
  }

  /** All snapshots in append order — feed each into a fresh `RateAuditLog.append()` (or a `RateEngine`'s `log`) to restore it. */
  async loadAll(): Promise<RateSnapshot[]> {
    const keys = await this.store.keys('ratesnapshot:');
    const snapshots = await Promise.all(keys.map((k) => this.store.get<RateSnapshot>(k)));
    return snapshots.filter((s): s is RateSnapshot => !!s);
  }

  private async nextSeq(): Promise<string> {
    const n = ((await this.store.get<number>('ratesnapshot-seq')) ?? 0) + 1;
    await this.store.set('ratesnapshot-seq', n);
    return String(n).padStart(10, '0');
  }
}

/** Durable storage for a `LeaseRegistry`, so devices never get overlapping address ranges across a restart. */
export class LeaseRegistryStore {
  constructor(private readonly store: KVStore) {}

  async save(registry: LeaseRegistry): Promise<void> {
    await this.store.set('lease-registry', registry.snapshot());
  }

  /** Returns a fresh, empty `LeaseRegistry` when nothing has been saved yet. */
  async load(): Promise<LeaseRegistry> {
    const snapshot = await this.store.get<LeaseRegistrySnapshot>('lease-registry');
    return snapshot ? LeaseRegistry.fromSnapshot(snapshot) : new LeaseRegistry();
  }
}
