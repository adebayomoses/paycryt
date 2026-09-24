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

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const DAY = 24 * 60 * 60_000;

function intInRange(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`policy.${name} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`policy.${name} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

function onlyKeys(obj: Record<string, unknown>, prefix: string, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`Unknown policy field "${prefix}${k}". Allowed: ${allowed.join(', ')}`);
  }
}

/**
 * Checks untrusted policy overrides (for example from an API request) and returns them typed. Rejects
 * unknown fields, so a typo like `expiry` fails loudly instead of being silently ignored, and rejects
 * out-of-range values.
 */
export function validatePolicyOverrides(input: unknown): DeepPartial<PaymentPolicy> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('policy must be an object');
  const p = input as Record<string, unknown>;
  onlyKeys(p, '', ['minConfirmations', 'expiryMs', 'graceMs', 'underpayment', 'overpayment', 'latePayment', 'lateWatchMs']);

  const out: DeepPartial<PaymentPolicy> = {};
  if (p.minConfirmations !== undefined) out.minConfirmations = intInRange(p.minConfirmations, 'minConfirmations', 0, 1_000);
  if (p.expiryMs !== undefined) out.expiryMs = intInRange(p.expiryMs, 'expiryMs', 1_000, 30 * DAY);
  if (p.graceMs !== undefined) out.graceMs = intInRange(p.graceMs, 'graceMs', 0, 7 * DAY);
  if (p.lateWatchMs !== undefined) out.lateWatchMs = intInRange(p.lateWatchMs, 'lateWatchMs', 0, 30 * DAY);
  if (p.latePayment !== undefined) out.latePayment = oneOf(p.latePayment, 'latePayment', ['refund', 'manual_review'] as const);

  if (p.underpayment !== undefined) {
    const o = objectOf(p.underpayment, 'underpayment');
    onlyKeys(o, 'underpayment.', ['toleranceBps', 'onExpiry']);
    out.underpayment = {};
    if (o.toleranceBps !== undefined) out.underpayment.toleranceBps = intInRange(o.toleranceBps, 'underpayment.toleranceBps', 0, 10_000);
    if (o.onExpiry !== undefined) out.underpayment.onExpiry = oneOf(o.onExpiry, 'underpayment.onExpiry', ['refund', 'accept_partial', 'manual_review'] as const);
  }
  if (p.overpayment !== undefined) {
    const o = objectOf(p.overpayment, 'overpayment');
    onlyKeys(o, 'overpayment.', ['toleranceBps', 'action']);
    out.overpayment = {};
    if (o.toleranceBps !== undefined) out.overpayment.toleranceBps = intInRange(o.toleranceBps, 'overpayment.toleranceBps', 0, 10_000);
    if (o.action !== undefined) out.overpayment.action = oneOf(o.action, 'overpayment.action', ['keep', 'credit', 'refund', 'manual_review'] as const);
  }
  return out;
}

function objectOf(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`policy.${name} must be an object`);
  return v as Record<string, unknown>;
}

/** Merges policy overrides in order (later wins), field by field including the nested underpayment/overpayment groups. */
export function mergePolicyOverrides(...layers: Array<DeepPartial<PaymentPolicy> | undefined>): DeepPartial<PaymentPolicy> {
  const out: DeepPartial<PaymentPolicy> = {};
  for (const layer of layers) {
    if (!layer) continue;
    const { underpayment, overpayment, ...rest } = layer;
    Object.assign(out, rest);
    if (underpayment) out.underpayment = { ...out.underpayment, ...underpayment };
    if (overpayment) out.overpayment = { ...out.overpayment, ...overpayment };
  }
  return out;
}

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
