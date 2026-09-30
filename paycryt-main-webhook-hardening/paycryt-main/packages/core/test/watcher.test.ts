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

describe('one failure never stops the rest of the tick', () => {
  /** A chain whose lookups fail for chosen addresses, like a rate-limited or unreachable node. */
  class FlakyChain extends FakeChain {
    failing = new Set<string>();
    override async getDeposits(address: string, assetSymbol: string) {
      if (this.failing.has(address)) throw new Error(`HTTP 429 for ${address}`);
      return super.getDeposits(address, assetSymbol);
    }
  }

  async function twoPayments() {
    const clock = makeClock();
    const a = (await makeRequest(clock)).request;
    const b = { ...(await makeRequest(clock)).request, id: 'pay_second', address: 'fake:tron:000002' };
    const chain = new FlakyChain('tron', clock.now);
    const watcher = new PaymentWatcher([chain], clock.now);
    const seen: PaymentEvent[] = [];
    const errors: Array<{ message: string; paymentId: string; stage: string }> = [];
    watcher.on((e) => void seen.push(e));
    watcher.onError((err, ctx) => void errors.push({ message: (err as Error).message, ...ctx }));
    watcher.watch(a);
    watcher.watch(b);
    return { a, b, chain, watcher, seen, errors, clock };
  }

  it('a failing address does not starve the payments after it, and the failure is reported', async () => {
    const { a, b, chain, watcher, seen, errors } = await twoPayments();
    chain.failing.add(a.address); // the FIRST payment's lookup fails...
    chain.scenarios.exact(b); // ...while the second was really paid

    const events = await watcher.tick(); // must not throw
    expect(events.map((e) => e.paymentId)).toEqual([b.id]); // the second payment still confirmed
    expect(seen).toHaveLength(1);
    expect(errors).toEqual([{ message: `HTTP 429 for ${a.address}`, paymentId: a.id, stage: 'chain' }]);
    expect(watcher.get(a.id)!.lastError?.message).toContain('429');
    expect(watcher.get(a.id)!.status).toBe('awaiting_payment'); // last known state kept, not corrupted
  });

  it('retries the failed payment next tick and clears the error once it recovers', async () => {
    const { a, chain, watcher, seen } = await twoPayments();
    chain.failing.add(a.address);
    chain.scenarios.exact(a);
    await watcher.tick();
    expect(watcher.get(a.id)!.lastError).toBeDefined();
    expect(seen).toHaveLength(0);

    chain.failing.delete(a.address); // the node comes back
    await watcher.tick();
    expect(watcher.get(a.id)!.lastError).toBeUndefined();
    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed']);
  });

  it('a throwing event handler does not block other handlers or later events', async () => {
    const { a, b, chain, watcher, seen, errors } = await twoPayments();
    watcher.on(() => {
      throw new Error('handler blew up');
    });
    const second: PaymentEvent[] = [];
    watcher.on((e) => void second.push(e)); // registered after the broken one
    chain.scenarios.exact(a);
    chain.scenarios.exact(b);

    await watcher.tick();
    expect(seen.map((e) => e.paymentId).sort()).toEqual([a.id, b.id].sort());
    expect(second).toHaveLength(2);
    expect(errors.filter((e) => e.stage === 'handler')).toHaveLength(2);
    expect(errors[0]!.message).toBe('handler blew up');
  });

  it('a throwing error handler cannot break the watcher either', async () => {
    const { a, chain, watcher } = await twoPayments();
    watcher.onError(() => {
      throw new Error('error handler blew up');
    });
    chain.failing.add(a.address);
    await expect(watcher.tick()).resolves.toEqual([]);
  });
});

describe('ticks are serialised and can check payments in parallel', () => {
  /** A chain with slow lookups that records how many are in flight at once. */
  class SlowChain extends FakeChain {
    inFlight = 0;
    maxInFlight = 0;
    perAddress = new Map<string, number>();
    maxPerAddress = 0;
    lookups = 0;
    constructor(private readonly delayMs: number, clock: () => number) {
      super('tron', clock);
    }
    override async getDeposits(address: string, assetSymbol: string) {
      this.lookups++;
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const same = (this.perAddress.get(address) ?? 0) + 1;
      this.perAddress.set(address, same);
      this.maxPerAddress = Math.max(this.maxPerAddress, same);
      await new Promise((r) => setTimeout(r, this.delayMs));
      const out = await super.getDeposits(address, assetSymbol);
      this.inFlight--;
      this.perAddress.set(address, same - 1);
      return out;
    }
  }

  async function many(n: number, options?: { concurrency?: number }, delayMs = 15) {
    const clock = makeClock();
    const chain = new SlowChain(delayMs, clock.now);
    const watcher = new PaymentWatcher([chain], clock.now, options);
    const seen: PaymentEvent[] = [];
    watcher.on((e) => void seen.push(e));
    const requests = [];
    for (let i = 0; i < n; i++) {
      const { request } = await makeRequest(clock);
      const r = { ...request, id: `pay_${i}`, address: `fake:tron:${String(i).padStart(6, '0')}` };
      watcher.watch(r);
      requests.push(r);
    }
    return { clock, chain, watcher, seen, requests };
  }

  it('overlapping ticks never check the same payment at the same time', async () => {
    const { chain, watcher, seen, requests } = await many(3);
    chain.scenarios.exact(requests[0]!);
    // A timer firing faster than the chain answers: five ticks launched back to back.
    const results = await Promise.all([watcher.tick(), watcher.tick(), watcher.tick(), watcher.tick(), watcher.tick()]);
    expect(chain.maxPerAddress).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed']);
    expect(results.flat()).toHaveLength(1); // only one of the ticks reports it
  });

  it('an older, slower lookup cannot overwrite a newer result with a stale view', async () => {
    // The first lookup starts BEFORE the deposit and is slow; the second starts after it and is fast. Unserialised,
    // the fast one settles the payment and then the slow, stale one drags it back to awaiting_payment.
    const clock = makeClock();
    const { request } = await makeRequest(clock);
    let call = 0;
    class Reordered extends FakeChain {
      override async getDeposits(address: string, symbol: string) {
        const mine = ++call;
        const snapshotAtStart = await super.getDeposits(address, symbol); // what the chain looked like when this lookup began
        await new Promise((r) => setTimeout(r, mine === 1 ? 80 : 5));
        return snapshotAtStart;
      }
    }
    const chain = new Reordered('tron', clock.now);
    const watcher = new PaymentWatcher([chain], clock.now);
    const seen: PaymentEvent[] = [];
    watcher.on((e) => void seen.push(e));
    watcher.watch(request);

    const stale = watcher.tick(); // begins now: sees no deposit, returns after 80ms
    await new Promise((r) => setTimeout(r, 10));
    chain.scenarios.exact(request); // the customer pays while that lookup is in flight
    const fresh = watcher.tick(); // begins after the payment: would return after 5ms
    await Promise.all([stale, fresh]);

    expect(watcher.get(request.id)!.status).toBe('paid'); // never regressed
    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed']);
  });

  it('a tick that starts after a change sees that change, even while another tick is running', async () => {
    const { chain, watcher, seen, requests } = await many(1);
    const first = watcher.tick(); // already running...
    chain.scenarios.exact(requests[0]!); // ...when the deposit lands
    const second = watcher.tick(); // queued behind it
    await Promise.all([first, second]);
    expect(seen.map((e) => e.type)).toEqual(['payment.confirmed']);
  });

  it('runs one lookup at a time by default (deterministic), and up to the limit when asked', async () => {
    const serial = await many(6);
    await serial.watcher.tick();
    expect(serial.chain.maxInFlight).toBe(1);

    const parallel = await many(6, { concurrency: 3 });
    await parallel.watcher.tick();
    expect(parallel.chain.maxInFlight).toBe(3); // three at once, never more: proves the limit without depending on wall-clock time
    expect(parallel.chain.lookups).toBe(6);
  });

  it('parallel checking still isolates a failure and still reports every result', async () => {
    const { chain, watcher, seen, requests } = await many(4, { concurrency: 4 });
    const original = chain.getDeposits.bind(chain);
    chain.getDeposits = async (address, symbol) => {
      if (address === requests[1]!.address) throw new Error('HTTP 429');
      return original(address, symbol);
    };
    for (const i of [0, 2, 3]) chain.scenarios.exact(requests[i]!);
    const errors: string[] = [];
    watcher.onError((e) => void errors.push((e as Error).message));
    await watcher.tick();
    expect(seen.map((e) => e.paymentId).sort()).toEqual(['pay_0', 'pay_2', 'pay_3']);
    expect(errors).toEqual(['HTTP 429']);
  });

  it('a tick that throws internally does not wedge the queue for later ticks', async () => {
    const { chain, watcher, seen, requests } = await many(1);
    watcher.on(() => {
      throw new Error('handler exploded');
    });
    chain.scenarios.exact(requests[0]!);
    await expect(watcher.tick()).resolves.toBeDefined(); // handler errors are isolated
    await expect(watcher.tick()).resolves.toEqual([]); // and the next tick runs normally
    expect(seen).toHaveLength(1);
  });
});
