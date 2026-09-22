import { describe, expect, it } from 'vitest';
import { evaluatePayment, withPolicy, type ChainDeposit } from '@paycryt/core';
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
