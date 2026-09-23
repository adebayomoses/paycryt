import { bps } from '../amount.js';
import type { PaymentRequest, ChainDeposit } from './types.js';

/**
 * What to do when a customer does not pay exactly what was asked.
 * Every knob has a conservative default, and each decision is returned as data
 * (see `PolicyAction`) so your app, not this library, moves the money.
 */
export interface PaymentPolicy {
  /** Confirmations needed before a deposit counts. */
  minConfirmations: number;
  /** Payment requests expire this long after creation. */
  expiryMs: number;
  /** Deposits arriving up to this long after expiry are still honoured at the locked rate. */
  graceMs: number;

  underpayment: {
    /** Shortfalls up to this many bps of the amount due are forgiven (covers network-fee shaving and rounding). */
    toleranceBps: number;
    /** What to do with a partial payment once the request (plus grace) has expired. */
    onExpiry: 'refund' | 'accept_partial' | 'manual_review';
  };

  overpayment: {
    /** Excess up to this many bps is silently kept by the merchant. */
    toleranceBps: number;
    /** What to do with excess above the tolerance. */
    action: 'keep' | 'credit' | 'refund' | 'manual_review';
  };

  /** Deposits after expiry + grace: send them back, or flag for a human. */
  latePayment: 'refund' | 'manual_review';

  /**
   * Once a payment reaches a final status, `PaymentWatcher` keeps polling its address for this long
   * before giving up — so a stray deposit that lands after the request is already closed still gets
   * caught (as `refund_required`/`manual_review`, per `latePayment`) instead of vanishing silently.
   */
  lateWatchMs: number;
}

export const DEFAULT_POLICY: PaymentPolicy = {
  minConfirmations: 1,
  expiryMs: 15 * 60_000,
  graceMs: 10 * 60_000,
  underpayment: { toleranceBps: 50, onExpiry: 'refund' },
  overpayment: { toleranceBps: 50, action: 'credit' },
  latePayment: 'refund',
  lateWatchMs: 24 * 60 * 60_000,
};

export function withPolicy(overrides: DeepPartial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    ...DEFAULT_POLICY,
    ...overrides,
    underpayment: { ...DEFAULT_POLICY.underpayment, ...overrides.underpayment },
    overpayment: { ...DEFAULT_POLICY.overpayment, ...overrides.overpayment },
  } as PaymentPolicy;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type PaymentStatus =
  | 'awaiting_payment'
  | 'confirming'
  | 'partially_paid'
  | 'paid'
  | 'overpaid'
  | 'expired'
  | 'refund_required'
  | 'manual_review';

export type PolicyAction =
  | { type: 'request_topup'; remaining: bigint }
  | { type: 'refund'; amount: bigint; reason: 'underpaid_expired' | 'overpaid' | 'late_payment' }
  | { type: 'credit'; amount: bigint }
  | { type: 'manual_review'; reason: string };

export interface PaymentEvaluation {
  status: PaymentStatus;
  due: bigint;
  /** Confirmed and on time. */
  received: bigint;
  /** Seen but not yet confirmed enough. */
  pending: bigint;
  /** Amount still missing after forgiving the tolerance. 0 when covered. */
  shortfall: bigint;
  /** Amount above what was due (before tolerance). 0 when not overpaid. */
  excess: bigint;
  /** Deposits that arrived after expiry + grace. */
  late: bigint;
  actions: PolicyAction[];
}

/** Pure function: same request, deposits, clock and policy always give the same answer. */
export function evaluatePayment(
  request: PaymentRequest,
  deposits: ChainDeposit[],
  now: number,
  policy: PaymentPolicy = request.policy,
): PaymentEvaluation {
  const cutoff = request.expiresAt + policy.graceMs;
  const mine = deposits.filter((d) => d.address === request.address && d.assetSymbol === request.asset.symbol);

  let received = 0n;
  let pending = 0n;
  let late = 0n;
  for (const d of mine) {
    if (d.receivedAt > cutoff) late += d.amount;
    else if (d.confirmations >= policy.minConfirmations) received += d.amount;
    else pending += d.amount;
  }

  const due = request.amountDue;
  const underTolerance = bps(due, policy.underpayment.toleranceBps);
  const overTolerance = bps(due, policy.overpayment.toleranceBps);
  const covered = received + underTolerance >= due;
  const shortfall = covered ? 0n : due - received;
  const excess = received > due ? received - due : 0n;
  const actions: PolicyAction[] = [];

  if (late > 0n) {
    actions.push(
      policy.latePayment === 'refund'
        ? { type: 'refund', amount: late, reason: 'late_payment' }
        : { type: 'manual_review', reason: `late deposit of ${late} base units` },
    );
  }

  const base = { due, received, pending, shortfall, excess, late };
  const expired = now > cutoff;

  if (covered) {
    if (excess > overTolerance) {
      const { action } = policy.overpayment;
      if (action === 'credit') actions.push({ type: 'credit', amount: excess });
      else if (action === 'refund') actions.push({ type: 'refund', amount: excess, reason: 'overpaid' });
      else if (action === 'manual_review') actions.push({ type: 'manual_review', reason: `overpaid by ${excess} base units` });
      return { ...base, status: 'overpaid', actions };
    }
    return { ...base, status: 'paid', actions };
  }

  if (received + pending + underTolerance >= due && !expired) {
    return { ...base, status: 'confirming', actions };
  }

  if (expired) {
    if (received === 0n) {
      return { ...base, status: late > 0n ? 'refund_required' : 'expired', actions };
    }
    switch (policy.underpayment.onExpiry) {
      case 'accept_partial':
        return { ...base, status: 'paid', actions };
      case 'manual_review':
        actions.push({ type: 'manual_review', reason: `underpaid by ${shortfall} base units` });
        return { ...base, status: 'manual_review', actions };
      default:
        actions.push({ type: 'refund', amount: received, reason: 'underpaid_expired' });
        return { ...base, status: 'refund_required', actions };
    }
  }

  if (received > 0n) {
    actions.push({ type: 'request_topup', remaining: shortfall });
    return { ...base, status: 'partially_paid', actions };
  }
  return { ...base, status: 'awaiting_payment', actions };
}
