import { ASSETS, type Asset, CURRENCIES, type Currency, fiatToAssetUnits, rateFromString } from '../amount.js';
import type { PaymentPolicy } from '../payments/policy.js';
import type { PaymentRequest } from '../payments/types.js';
import { verifyChain } from '../rates/snapshot.js';
import type { AddressDeriver } from '../wallet/derive.js';
import type { SyncOp, SyncResponse } from './pos.js';

/** Plain-data snapshot of a LeaseRegistry's state, safe to hand to `KVStore.set` and back. */
export interface LeaseRegistrySnapshot {
  cursor: number;
  ranges: Record<string, Array<{ start: number; end: number }>>;
}

/** Hands out disjoint address-index ranges so two POS devices can never generate the same address. */
export class LeaseRegistry {
  private readonly ranges = new Map<string, Array<{ start: number; end: number }>>();
  private cursor: number;

  constructor(opts: { firstIndex?: number } = {}) {
    this.cursor = opts.firstIndex ?? 0;
  }

  /** Allocate a range of `size` indexes to a device. Returns its existing lease if it already has one. */
  allocate(deviceId: string, size = 1_000): { start: number; end: number } {
    return this.ranges.get(deviceId)?.at(-1) ?? this.renew(deviceId, size);
  }

  /** Give a device a further range (call when it reports LeaseExhausted). Earlier ranges stay valid for syncing old requests. */
  renew(deviceId: string, size = 1_000): { start: number; end: number } {
    const lease = { start: this.cursor, end: this.cursor + size };
    this.cursor += size;
    this.ranges.set(deviceId, [...(this.ranges.get(deviceId) ?? []), lease]);
    return lease;
  }

  contains(deviceId: string, index: number): boolean {
    return (this.ranges.get(deviceId) ?? []).some((l) => index >= l.start && index < l.end);
  }

  /** Plain-data copy of all state, for persistence (see `LeaseRegistryStore` in @paycryt/core). */
  snapshot(): LeaseRegistrySnapshot {
    return { cursor: this.cursor, ranges: Object.fromEntries(this.ranges) };
  }

  /** Rebuild a registry from a previously saved `snapshot()`, so restarting a server doesn't reissue addresses. */
  static fromSnapshot(snapshot: LeaseRegistrySnapshot): LeaseRegistry {
    const registry = new LeaseRegistry({ firstIndex: snapshot.cursor });
    for (const [deviceId, ranges] of Object.entries(snapshot.ranges)) registry.ranges.set(deviceId, ranges.map((r) => ({ ...r })));
    return registry;
  }
}

export interface SyncReceiverOptions {
  /** Default address source, used when `resolveDeriver` is absent or returns nothing. */
  deriver: AddressDeriver;
  /**
   * Picks the deriver a specific op's address must come from — e.g. the xpub of the merchant that owns
   * the device — so each tenant's payments are checked against their own wallet, not a shared one.
   * Return undefined to fall back to `deriver`.
   */
  resolveDeriver?: (op: SyncOp) => AddressDeriver | undefined | Promise<AddressDeriver | undefined>;
  leases: LeaseRegistry;
  /**
   * Assets a device may price a sale in. A device supplies its own asset description (decimals, contract),
   * and the server recomputes the price from it — so an unchecked description lets a device claim
   * `decimals: 0` and undercharge by a factor of a million. Defaults to the built-in `ASSETS` table.
   */
  allowedAssets?: readonly Asset[];
  /**
   * The policy a synced payment will really run under. A device's own `policy` is never trusted (it could
   * set `toleranceBps: 10000` so any payment counts as paid); when this is set it replaces the request's
   * policy before the request is accepted. Strongly recommended for any server that accepts devices.
   */
  policyFor?: (op: SyncOp) => PaymentPolicy | Promise<PaymentPolicy>;
  /** Finds an already-known request by id (e.g. `(id) => watcher.get(id)?.request`), so a device can't reuse another payment's id. */
  lookupRequest?: (id: string) => PaymentRequest | undefined;
  /** Called once per accepted payment request. Typically: `(r) => watcher.watch(r)`. */
  onAccepted: (request: PaymentRequest) => void | Promise<void>;
  /** Highest extra spread you will honour on an offline device, in bps. Guards against a tampered device under-pricing sales. Default 500. */
  maxOfflineSpreadBps?: number;
  /**
   * Authenticity check for the root rate snapshot (a hash proves integrity, not origin).
   * Pass `(hash) => !!engine.log.get(hash)` so only rates your own server issued are accepted.
   */
  isKnownSnapshot?: (hash: string) => boolean;
}

/**
 * The server half of offline sync. It trusts nothing the device says:
 * it re-derives the address, re-checks the rate lineage hashes, and recomputes the amount due.
 */
export class SyncReceiver {
  private readonly applied = new Set<string>();
  private readonly addresses = new Map<string, string>(); // address -> request id
  private readonly ids = new Map<string, string>(); // request id -> address

  constructor(private readonly o: SyncReceiverOptions) {}

  /**
   * Rebuild the address-ownership map from requests reloaded after a restart (see `PaymentRequestStore`).
   * Without this, a device re-sending an op it already synced before the restart would be re-validated
   * from scratch — harmlessly, since the address is still owned by the same request id, but pointlessly.
   */
  hydrate(requests: PaymentRequest[]): void {
    for (const r of requests) {
      this.addresses.set(r.address, r.id);
      this.ids.set(r.id, r.address);
    }
  }

  async apply(op: SyncOp): Promise<SyncResponse> {
    if (this.applied.has(op.opId)) return { status: 'duplicate' };
    const deriver = (await this.o.resolveDeriver?.(op)) ?? this.o.deriver;
    // Re-check after the await: a concurrent retry of this same op may have been applied while we waited.
    if (this.applied.has(op.opId)) return { status: 'duplicate' };
    const reason = this.validate(op, deriver);
    if (reason) return { status: 'rejected', reason };
    this.applied.add(op.opId);
    this.addresses.set(op.request.address, op.request.id);
    this.ids.set(op.request.id, op.request.address);
    if (this.o.policyFor) op.request.policy = await this.o.policyFor(op);
    await this.o.onAccepted(op.request);
    return { status: 'accepted' };
  }

  private validate(op: SyncOp, deriver: AddressDeriver): string | null {
    const r = op.request;
    if (op.type !== 'payment.create') return `unsupported op type ${op.type}`;
    if (r.offline?.deviceId !== op.deviceId) return 'device id does not match the request';

    if (!this.o.leases.contains(op.deviceId, op.addressIndex)) return `address index ${op.addressIndex} is outside this device's lease`;
    if (r.addressIndex !== op.addressIndex) return 'address index mismatch';
    if (deriver.derive(op.addressIndex) !== r.address) return 'address does not derive from the merchant xpub at that index';
    const owner = this.addresses.get(r.address);
    if (owner && owner !== r.id) return `address already used by payment ${owner}`;
    // The same id may be replayed for the same address (a retry), but never pointed at a different one.
    const knownAddress = this.ids.get(r.id) ?? this.o.lookupRequest?.(r.id)?.address;
    if (knownAddress !== undefined && knownAddress !== r.address) return 'payment id is already in use';

    const allowed = this.o.allowedAssets ?? (Object.values(ASSETS) as Asset[]);
    const a = r.asset;
    if (!allowed.some((k) => k.symbol === a?.symbol && k.chain === a.chain && k.decimals === a.decimals && k.contract === a.contract)) {
      return `asset ${a?.symbol}/${a?.chain} is not one this server prices`;
    }

    const chain = verifyChain(op.snapshots);
    if (!chain.ok) return `rate audit trail invalid at #${chain.index}: ${chain.reason}`;
    const priced = op.snapshots.at(-1);
    if (!priced || priced.hash !== r.rateSnapshotHash) return 'request is not priced from the last snapshot in its lineage';
    if (priced.direction !== 'CRYPTO_TO_FIAT') return 'wrong rate direction';
    if (priced.effectiveRate !== r.effectiveRate) return 'effective rate mismatch';

    if (r.expiresAt > priced.lockedUntil) return 'request outlives the rate it was priced with';

    const root = op.snapshots[0]!;
    if (this.o.isKnownSnapshot && !this.o.isKnownSnapshot(root.hash)) return 'root rate snapshot was not issued by this server';
    const extra = priced.spreadBps - root.spreadBps;
    if (extra < 0 || extra > (this.o.maxOfflineSpreadBps ?? 500)) return `offline margin of ${extra} bps is outside the allowed range`;
    if (priced.spreadBps < 0) return 'negative spread';

    const currency: Currency | undefined = (CURRENCIES as Record<string, Currency>)[r.fiat.currency];
    if (!currency) return `unsupported currency ${r.fiat.currency}`;
    const expected = fiatToAssetUnits(r.fiat.amountMinor, currency, r.asset, rateFromString(priced.effectiveRate));
    if (expected !== r.amountDue) return `amount due should be ${expected}, device said ${r.amountDue}`;
    return null;
  }
}
