import { describe, expect, it } from 'vitest';
import { FakeChain, PaymentWatcher, withPolicy, type PaymentEvent } from '@paycryt/core';
import { makeClock, makeRequest } from './helpers.js';

async function setup() {
  const { request, clock } = await makeRequest();
  const chain = new FakeChain('tron', clock.now);
  const watcher = new PaymentWatcher([chain], clock.now);
  const seen: PaymentEvent[] = [];
  watcher.on((e) => void seen.push(e));
  watcher.watch(request);
  return { request, clock, chain, watcher, seen };
}

describe('payment watcher + fake chain', () => {
  it('emits detected then confirmed as the fake chain mines', async () => {
    const { request, chain, watcher, seen } = await setup();
    chain.scenarios.unconfirmed(request);
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.detected']);
    chain.mine();
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.detected', 'payment.confirmed']);
  });

  it('does not emit twice for an unchanged state', async () => {
    const { request, chain, watcher, seen } = await setup();
    chain.scenarios.exact(request);
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(seen).toHaveLength(1);
  });

  it('handles underpay, top-up, overpay and late scenarios', async () => {
    const a = await setup();
    a.chain.scenarios.underpay(a.request, 60);
    await a.watcher.tick();
    expect(a.seen.at(-1)!.type).toBe('payment.partially_paid');
    a.chain.scenarios.underpay(a.request, 40);
    await a.watcher.tick();
    expect(a.seen.at(-1)!.type).toBe('payment.confirmed');

    const b = await setup();
    b.chain.scenarios.overpay(b.request, 130);
    await b.watcher.tick();
    expect(b.seen.at(-1)).toMatchObject({ type: 'payment.overpaid' });

    const c = await setup();
    c.chain.scenarios.late(c.request, c.request.policy.graceMs + 1000);
    c.clock.set(c.request.expiresAt + c.request.policy.graceMs + 2000);
    await c.watcher.tick();
    expect(c.seen.at(-1)!.type).toBe('payment.refund_required');
  });

  it('emits expired when nothing arrives', async () => {
    const { request, clock, watcher, seen } = await setup();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.expired']);
  });

  it('split scenario confirms once the parts add up', async () => {
    const { request, chain, watcher, seen } = await setup();
    chain.scenarios.split(request, 3);
    await watcher.tick();
    expect(seen.at(-1)!.type).toBe('payment.confirmed');
  });
});

describe('late-watch window (catching deposits after finalization)', () => {
  const LATE_WATCH_MS = 60_000;

  async function setupWithLateWatch(overrides: Parameters<typeof withPolicy>[0] = {}) {
    const clock = makeClock();
    const { request } = await makeRequest(clock, withPolicy({ lateWatchMs: LATE_WATCH_MS, ...overrides }));
    const chain = new FakeChain('tron', clock.now);
    const watcher = new PaymentWatcher([chain], clock.now);
    const seen: PaymentEvent[] = [];
    watcher.on((e) => void seen.push(e));
    watcher.watch(request);
    return { request, clock, chain, watcher, seen };
  }

  it('records finalizedAt the moment a payment first goes final, and never after', async () => {
    const { request, clock, watcher } = await setupWithLateWatch();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick(); // -> expired
    const firstFinalizedAt = watcher.get(request.id)!.finalizedAt;
    expect(firstFinalizedAt).toBe(clock.now());

    clock.advance(1000);
    await watcher.tick(); // still expired, nothing new
    expect(watcher.get(request.id)!.finalizedAt).toBe(firstFinalizedAt); // unchanged, not bumped
  });

  it('catches a deposit that lands after the payment already expired, within the late-watch window', async () => {
    const { request, clock, chain, watcher, seen } = await setupWithLateWatch();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.expired']);

    // A customer pays well after the deadline, but still inside the 60s late-watch window.
    clock.advance(30_000);
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: request.amountDue, confirmations: 1, at: clock.now() });
    await watcher.tick();

    expect(seen.map((e) => e.type)).toEqual(['payment.expired', 'payment.refund_required']);
    const last = seen.at(-1)!;
    expect(last.evaluation.late).toBe(request.amountDue);
    expect(last.evaluation.actions).toContainEqual({ type: 'refund', amount: request.amountDue, reason: 'late_payment' });
  });

  it('stops polling once the late-watch window has fully elapsed, missing anything after that', async () => {
    const { request, clock, chain, watcher, seen } = await setupWithLateWatch();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick(); // -> expired, finalizedAt recorded here

    clock.advance(LATE_WATCH_MS + 1); // just past the late-watch window
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: request.amountDue, confirmations: 1, at: clock.now() });
    await watcher.tick();

    expect(seen.map((e) => e.type)).toEqual(['payment.expired']); // no second event: the deposit was never looked for
  });

  it('emits again when more stray funds arrive on an already refund_required payment (status unchanged, late amount grew)', async () => {
    const { request, clock, chain, watcher, seen } = await setupWithLateWatch();
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick();

    clock.advance(10_000);
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: 1_000_000n, confirmations: 1, at: clock.now() });
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.expired', 'payment.refund_required']);

    clock.advance(10_000);
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: 2_000_000n, confirmations: 1, at: clock.now() });
    await watcher.tick();
    // Still refund_required (status unchanged) — but a THIRD event fires because more late money showed up.
    expect(seen.map((e) => e.type)).toEqual(['payment.expired', 'payment.refund_required', 'payment.refund_required']);
    expect(seen.at(-1)!.evaluation.late).toBe(3_000_000n);
  });

  it('notices a stray deposit even after the payment already reached paid, without changing its status', async () => {
    // finalizedAt lands near "now" (paid immediately), but "late" requires passing expiresAt+graceMs (~25min
    // out) — so this test needs a late-watch window comfortably longer than that, unlike the others above.
    const { request, clock, chain, watcher, seen } = await setupWithLateWatch({ lateWatchMs: 30 * 60_000 });
    chain.scenarios.exact(request);
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed']);

    clock.set(request.expiresAt + request.policy.graceMs + 10_000); // well past cutoff, still within late-watch
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: 500_000n, confirmations: 1, at: clock.now() });
    await watcher.tick();

    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed', 'payment.confirmed']); // status stays 'paid'
    const last = seen.at(-1)!;
    expect(last.status).toBe('paid');
    expect(last.evaluation.late).toBe(500_000n);
    expect(last.evaluation.actions).toContainEqual({ type: 'refund', amount: 500_000n, reason: 'late_payment' });
  });

  it('respects a custom (shorter) lateWatchMs from the policy', async () => {
    const { request, clock, chain, watcher, seen } = await setupWithLateWatch({ lateWatchMs: 5_000 });
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick();

    clock.advance(5_001); // just past this payment's own shorter window
    chain.simulateDeposit({ address: request.address, assetSymbol: request.asset.symbol, amount: request.amountDue, confirmations: 1, at: clock.now() });
    await watcher.tick();
    expect(seen.map((e) => e.type)).toEqual(['payment.expired']); // missed: window already closed
  });
});
