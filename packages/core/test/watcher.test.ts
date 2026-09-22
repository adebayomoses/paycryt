import { describe, expect, it } from 'vitest';
import { FakeChain, PaymentWatcher, type PaymentEvent } from '@paycryt/core';
import { makeRequest } from './helpers.js';

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
