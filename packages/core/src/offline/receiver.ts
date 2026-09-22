import { CURRENCIES, type Currency, fiatToAssetUnits, rateFromString } from '../amount.js';
import type { PaymentRequest } from '../payments/types.js';
import { verifyChain } from '../rates/snapshot.js';
import type { AddressDeriver } from '../wallet/derive.js';
import type { SyncOp, SyncResponse } from './pos.js';

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
}

export interface SyncReceiverOptions {
  deriver: AddressDeriver;
  leases: LeaseRegistry;
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

  constructor(private readonly o: SyncReceiverOptions) {}

  async apply(op: SyncOp): Promise<SyncResponse> {
    if (this.applied.has(op.opId)) return { status: 'duplicate' };
    const reason = this.validate(op);
    if (reason) return { status: 'rejected', reason };
    this.applied.add(op.opId);
    this.addresses.set(op.request.address, op.request.id);
    await this.o.onAccepted(op.request);
    return { status: 'accepted' };
  }

  private validate(op: SyncOp): string | null {
    const r = op.request;
    if (op.type !== 'payment.create') return `unsupported op type ${op.type}`;
    if (r.offline?.deviceId !== op.deviceId) return 'device id does not match the request';

    if (!this.o.leases.contains(op.deviceId, op.addressIndex)) return `address index ${op.addressIndex} is outside this device's lease`;
    if (r.addressIndex !== op.addressIndex) return 'address index mismatch';
    if (this.o.deriver.derive(op.addressIndex) !== r.address) return 'address does not derive from the merchant xpub at that index';
    const owner = this.addresses.get(r.address);
    if (owner && owner !== r.id) return `address already used by payment ${owner}`;

    const chain = verifyChain(op.snapshots);
    if (!chain.ok) return `rate audit trail invalid at #${chain.index}: ${chain.reason}`;
    const priced = op.snapshots.at(-1);
    if (!priced || priced.hash !== r.rateSnapshotHash) return 'request is not priced from the last snapshot in its lineage';
    if (priced.direction !== 'CRYPTO_TO_FIAT') return 'wrong rate direction';
    if (priced.effectiveRate !== r.effectiveRate) return 'effective rate mismatch';

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
