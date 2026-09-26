import { describe, expect, it } from 'vitest';
import { evaluatePayment, mergePolicyOverrides, validatePolicyOverrides, withPolicy, type ChainDeposit } from '@paycryt/core';
import { makeRequest } from './helpers.js';

const USDT = (n: number) => BigInt(Math.round(n * 1e6));
let counter = 0;
const dep = (r: { address: string; asset: { symbol: string } }, amount: bigint, confirmations: number, at: number): ChainDeposit => ({
  txId: `tx${++counter}`,
  address: r.address,
  assetSymbol: r.asset.symbol,
  amount,
  confirmations,
  receivedAt: at,
});

describe('payment policy', () => {
  it('prices NGN 15,000 as 10 USDT', async () => {
    const { request } = await makeRequest();
    expect(request.amountDue).toBe(USDT(10));
  });

  it('exact payment -> paid', async () => {
    const { request, clock } = await makeRequest();
    const e = evaluatePayment(request, [dep(request, USDT(10), 1, clock.now())], clock.now());
    expect(e.status).toBe('paid');
    expect(e.actions).toEqual([]);
  });

  it('unconfirmed payment -> confirming, not paid', async () => {
    const { request, clock } = await makeRequest();
    const e = evaluatePayment(request, [dep(request, USDT(10), 0, clock.now())], clock.now());
    expect(e.status).toBe('confirming');
    expect(e.pending).toBe(USDT(10));
  });

  it('forgives shortfalls within tolerance (0.5% default)', async () => {
    const { request, clock } = await makeRequest();
    const e = evaluatePayment(request, [dep(request, USDT(9.96), 1, clock.now())], clock.now());
    expect(e.status).toBe('paid');
  });

  it('partial payment -> partially_paid and asks for the remainder', async () => {
    const { request, clock } = await makeRequest();
    const e = evaluatePayment(request, [dep(request, USDT(6), 1, clock.now())], clock.now());
    expect(e.status).toBe('partially_paid');
    expect(e.actions).toEqual([{ type: 'request_topup', remaining: USDT(4) }]);
  });

  it('split payments add up', async () => {
    const { request, clock } = await makeRequest();
    const e = evaluatePayment(request, [dep(request, USDT(6), 1, clock.now()), dep(request, USDT(4), 1, clock.now())], clock.now());
    expect(e.status).toBe('paid');
  });

  it('underpaid after expiry + grace -> refund_required by default', async () => {
    const { request, clock } = await makeRequest();
    const deposits = [dep(request, USDT(6), 1, clock.now())];
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    const e = evaluatePayment(request, deposits, clock.now());
    expect(e.status).toBe('refund_required');
    expect(e.actions).toEqual([{ type: 'refund', amount: USDT(6), reason: 'underpaid_expired' }]);
  });

  it('underpaid after expiry can be accepted or sent to manual review', async () => {
    const accept = await makeRequest(undefined, withPolicy({ underpayment: { onExpiry: 'accept_partial' } }));
    const d1 = [dep(accept.request, USDT(6), 1, accept.clock.now())];
    accept.clock.set(accept.request.expiresAt + accept.request.policy.graceMs + 1);
    expect(evaluatePayment(accept.request, d1, accept.clock.now()).status).toBe('paid');

    const review = await makeRequest(undefined, withPolicy({ underpayment: { onExpiry: 'manual_review' } }));
    const d2 = [dep(review.request, USDT(6), 1, review.clock.now())];
    review.clock.set(review.request.expiresAt + review.request.policy.graceMs + 1);
    expect(evaluatePayment(review.request, d2, review.clock.now()).status).toBe('manual_review');
  });

  it('a payment inside the grace window is honoured at the locked rate', async () => {
    const { request, clock } = await makeRequest();
    const at = request.expiresAt + 60_000; // 1 min after expiry, inside the 10 min grace
    clock.set(at);
    const e = evaluatePayment(request, [dep(request, USDT(10), 1, at)], at);
    expect(e.status).toBe('paid');
    expect(e.late).toBe(0n);
  });

  it('a payment after the grace window is refunded, not counted', async () => {
    const { request, clock } = await makeRequest();
    const at = request.expiresAt + request.policy.graceMs + 1;
    clock.set(at);
    const e = evaluatePayment(request, [dep(request, USDT(10), 1, at)], at);
    expect(e.status).toBe('refund_required');
    expect(e.late).toBe(USDT(10));
    expect(e.actions).toEqual([{ type: 'refund', amount: USDT(10), reason: 'late_payment' }]);
  });

  it('never paid, never late -> expired', async () => {
    const { request, clock } = await makeRequest();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    expect(evaluatePayment(request, [], clock.now()).status).toBe('expired');
  });

  it('overpayment within tolerance is kept; beyond it follows the policy', async () => {
    const { request, clock } = await makeRequest();
    expect(evaluatePayment(request, [dep(request, USDT(10.04), 1, clock.now())], clock.now()).status).toBe('paid');

    const credit = evaluatePayment(request, [dep(request, USDT(12), 1, clock.now())], clock.now());
    expect(credit.status).toBe('overpaid');
    expect(credit.excess).toBe(USDT(2));
    expect(credit.actions).toEqual([{ type: 'credit', amount: USDT(2) }]);

    const refund = await makeRequest(undefined, withPolicy({ overpayment: { action: 'refund' } }));
    const e = evaluatePayment(refund.request, [dep(refund.request, USDT(12), 1, refund.clock.now())], refund.clock.now());
    expect(e.actions).toEqual([{ type: 'refund', amount: USDT(2), reason: 'overpaid' }]);
  });

  it('ignores deposits to other addresses or assets', async () => {
    const { request, clock } = await makeRequest();
    const other = { ...dep(request, USDT(10), 1, clock.now()), address: 'someone-else' };
    const wrongAsset = { ...dep(request, USDT(10), 1, clock.now()), assetSymbol: 'USDC' };
    expect(evaluatePayment(request, [other, wrongAsset], clock.now()).status).toBe('awaiting_payment');
  });
});

describe('policy override validation and merging', () => {
  it('accepts a valid override and returns it typed', () => {
    const p = validatePolicyOverrides({ expiryMs: 60_000, underpayment: { toleranceBps: 100, onExpiry: 'manual_review' }, latePayment: 'manual_review' });
    expect(p).toEqual({ expiryMs: 60_000, underpayment: { toleranceBps: 100, onExpiry: 'manual_review' }, latePayment: 'manual_review' });
    expect(validatePolicyOverrides(undefined)).toEqual({});
    expect(validatePolicyOverrides(null)).toEqual({});
  });

  it('rejects unknown fields, so a typo cannot be silently ignored', () => {
    expect(() => validatePolicyOverrides({ expiry: 1000 })).toThrow(/Unknown policy field "expiry"/);
    expect(() => validatePolicyOverrides({ underpayment: { tolerance: 5 } })).toThrow(/Unknown policy field "underpayment.tolerance"/);
  });

  it('rejects out-of-range, wrong-typed and non-integer values', () => {
    expect(() => validatePolicyOverrides({ expiryMs: -5 })).toThrow(/expiryMs/);
    expect(() => validatePolicyOverrides({ expiryMs: 5 })).toThrow(/expiryMs/); // below the 1s minimum
    expect(() => validatePolicyOverrides({ expiryMs: '900000' })).toThrow(/expiryMs/);
    expect(() => validatePolicyOverrides({ graceMs: 1.5 })).toThrow(/graceMs/);
    expect(() => validatePolicyOverrides({ minConfirmations: 5_000 })).toThrow(/minConfirmations/);
    expect(() => validatePolicyOverrides({ overpayment: { toleranceBps: 20_000 } })).toThrow(/toleranceBps/);
    expect(() => validatePolicyOverrides({ latePayment: 'ignore' })).toThrow(/latePayment/);
    expect(() => validatePolicyOverrides({ overpayment: { action: 'donate' } })).toThrow(/overpayment.action/);
    expect(() => validatePolicyOverrides('nope')).toThrow(/must be an object/);
    expect(() => validatePolicyOverrides([])).toThrow(/must be an object/);
    expect(() => validatePolicyOverrides({ underpayment: 5 })).toThrow(/underpayment must be an object/);
  });

  it('merges layers field by field, including the nested groups, later layers winning', () => {
    const merged = mergePolicyOverrides(
      { expiryMs: 60_000, underpayment: { toleranceBps: 100, onExpiry: 'manual_review' } },
      undefined,
      { underpayment: { toleranceBps: 25 }, graceMs: 5_000 },
    );
    expect(merged).toEqual({ expiryMs: 60_000, graceMs: 5_000, underpayment: { toleranceBps: 25, onExpiry: 'manual_review' } });
    // ...and the result feeds withPolicy without losing the untouched nested default
    expect(withPolicy(merged).overpayment).toEqual({ toleranceBps: 50, action: 'credit' });
  });
});

describe('funds that were at the address before the request existed', () => {
  const USDT = (n: number) => BigInt(Math.round(n * 1e6));
  const HOUR = 3_600_000;

  it('a deposit long before the request was created never pays it (an imported wallet with history)', async () => {
    const { request, clock } = await makeRequest();
    const old = dep(request, USDT(10), 500, request.createdAt - 24 * HOUR); // a day-old payment to a reused address
    const e = evaluatePayment(request, [old], clock.now());
    expect(e.status).toBe('awaiting_payment');
    expect(e.received).toBe(0n);
    expect(e.late).toBe(0n); // and it is not misread as a late payment to refund either
  });

  it('tolerates block timestamps that run a little behind the wall clock, so a real payment is not dropped', async () => {
    const { request, clock } = await makeRequest();
    const skewed = dep(request, USDT(10), 1, request.createdAt - 30 * 60_000); // stamped 30 min "early", well inside the 3h default
    expect(evaluatePayment(request, [skewed], clock.now()).status).toBe('paid');
    const tooOld = dep(request, USDT(10), 1, request.createdAt - 4 * HOUR);
    expect(evaluatePayment(request, [tooOld], clock.now()).status).toBe('awaiting_payment');
  });

  it('the tolerance is a policy setting, including zero', async () => {
    const strict = await makeRequest(undefined, withPolicy({ backdateToleranceMs: 0 }));
    const oneSecondBefore = dep(strict.request, USDT(10), 1, strict.request.createdAt - 1_000);
    expect(evaluatePayment(strict.request, [oneSecondBefore], strict.clock.now()).status).toBe('awaiting_payment');

    const loose = await makeRequest(undefined, withPolicy({ backdateToleranceMs: 48 * HOUR }));
    const dayBefore = dep(loose.request, USDT(10), 1, loose.request.createdAt - 24 * HOUR);
    expect(evaluatePayment(loose.request, [dayBefore], loose.clock.now()).status).toBe('paid');
  });

  it('baselineTxIds ignore exactly the deposits already present, however recent, and nothing else', async () => {
    const { request, clock } = await makeRequest();
    const already = dep(request, USDT(10), 1, request.createdAt - 60_000); // one minute before: inside the tolerance, so only the baseline can exclude it
    const withBaseline = { ...request, baselineTxIds: [already.txId] };
    expect(evaluatePayment(withBaseline, [already], clock.now()).status).toBe('awaiting_payment');

    const real = dep(request, USDT(10), 1, clock.now());
    const both = evaluatePayment(withBaseline, [already, real], clock.now());
    expect(both.status).toBe('paid');
    expect(both.received).toBe(USDT(10)); // only the new one counted, not 20
  });

  it('validates the new policy field', () => {
    expect(validatePolicyOverrides({ backdateToleranceMs: 60_000 })).toEqual({ backdateToleranceMs: 60_000 });
    expect(() => validatePolicyOverrides({ backdateToleranceMs: -1 })).toThrow(/backdateToleranceMs/);
    expect(() => validatePolicyOverrides({ backdateToleranceMs: 30 * 24 * HOUR })).toThrow(/backdateToleranceMs/);
  });
});
