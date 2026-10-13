import { describe, expect, it } from 'vitest';
import { ASSETS, FakeChain, LeaseExhaustedError, LeaseRegistry, MemoryStore, OfflinePOS, RateEngine, StaticRateProvider, SyncReceiver, type SyncOp, type SyncResponse } from '@paycryt/core';

const T0 = 1_700_000_000_000;

async function till(opts: { lease: { start: number; end: number }; store?: MemoryStore }) {
  const store = opts.store ?? new MemoryStore();
  const chain = new FakeChain('tron', () => T0);
  const engine = new RateEngine({ providers: [new StaticRateProvider('x', { 'USDT/NGN': '1500' }, () => T0)], now: () => T0 });
  const pos = new OfflinePOS({ deviceId: 'till-1', deriver: chain, lease: opts.lease, store, clock: () => T0 });
  await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);
  const sell = () => pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 150_000n }, asset: ASSETS.USDT_TRC20 });
  return { pos, store, sell };
}

describe('a till that renews its address lease', () => {
  it('moves on to the NEW range instead of continuing from the old cursor', async () => {
    const first = await till({ lease: { start: 0, end: 2 } });
    expect((await first.sell()).request.addressIndex).toBe(0);
    expect((await first.sell()).request.addressIndex).toBe(1);
    await expect(first.sell()).rejects.toBeInstanceOf(LeaseExhaustedError); // exhausted: time to renew

    // The server's LeaseRegistry.renew() hands out a DISJOINT range (other devices took 2..9 meanwhile).
    const renewed = await till({ lease: { start: 10, end: 12 }, store: first.store });
    const sale = await renewed.sell();
    // Before the fix this was index 2: outside every lease the device holds, so the server refused the sale
    // after the customer had already paid an address nobody was watching.
    expect(sale.request.addressIndex).toBe(10);
    expect((await renewed.sell()).request.addressIndex).toBe(11);
    await expect(renewed.sell()).rejects.toBeInstanceOf(LeaseExhaustedError);
  });

  it('never goes backwards: a stale cursor ahead of the lease start is kept', async () => {
    const t = await till({ lease: { start: 0, end: 100 } });
    for (let i = 0; i < 5; i++) await t.sell();
    const again = await till({ lease: { start: 0, end: 100 }, store: t.store }); // same lease, device restarted
    expect((await again.sell()).request.addressIndex).toBe(5); // continues, never reuses 0..4
  });
});

describe('a sale made while ONLINE from a cached rate', () => {
  it('is accepted by the server, however long after the rate was cached it is made', async () => {
    let now = T0;
    const chain = new FakeChain('tron', () => now);
    const engine = new RateEngine({ providers: [new StaticRateProvider('x', { 'USDT/NGN': '1500' }, () => now)], now: () => now });
    const leases = new LeaseRegistry();
    const lease = leases.allocate('till-1', 50);
    const receiver = new SyncReceiver({ deriver: chain, leases, onAccepted: () => {}, isKnownSnapshot: (h) => !!engine.log.get(h) });
    const pos = new OfflinePOS({ deviceId: 'till-1', deriver: chain, lease, store: new MemoryStore(), clock: () => now, isOnline: () => true });
    await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);

    for (const minutesLater of [0, 1, 7, 14, 16, 90]) {
      now = T0 + minutesLater * 60_000;
      const { request } = await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 150_000n }, asset: ASSETS.USDT_TRC20 });
      const [op] = (await pos.pending()).filter((o) => o.request.id === request.id);
      // Before the fix, anything after minute 0 was refused with "request outlives the rate it was priced with":
      // the request lived 15 min from now, the cached rate's lock ended 15 min after it was fetched.
      expect(await receiver.apply(op!), `sale made ${minutesLater} min after the rate was cached`).toEqual({ status: 'accepted' });
      expect(request.expiresAt).toBeGreaterThan(now); // and the customer still gets a usable payment window
    }
  });
});

describe('knowing when to renew', () => {
  it('reports the addresses left, counting down across sales and resetting on a new lease', async () => {
    const t = await till({ lease: { start: 0, end: 3 } });
    expect(await t.pos.leaseRemaining()).toBe(3);
    await t.sell();
    expect(await t.pos.leaseRemaining()).toBe(2);
    await t.sell();
    await t.sell();
    expect(await t.pos.leaseRemaining()).toBe(0);
    const renewed = await till({ lease: { start: 50, end: 60 }, store: t.store });
    expect(await renewed.pos.leaseRemaining()).toBe(10); // the old cursor does not eat into the new lease
  });
});

describe('syncing against a server that answers oddly', () => {
  async function queued() {
    const t = await till({ lease: { start: 0, end: 10 } });
    await t.sell();
    return t;
  }

  it('keeps the sale queued when the answer is not a recognised sync result (e.g. a 429 body)', async () => {
    const t = await queued();
    const summary = await t.pos.sync({ push: async () => ({ error: 'Rate limit exceeded' }) as unknown as SyncResponse });
    expect(summary.remaining).toBe(1);
    expect(await t.pos.pending()).toHaveLength(1); // before the fix this sale was silently deleted
    expect(await t.pos.rejected()).toHaveLength(0);
  });

  it('keeps the sale queued when the transport throws, and delivers it on the next try', async () => {
    const t = await queued();
    expect((await t.pos.sync({ push: async () => { throw new Error('offline'); } })).remaining).toBe(1);
    const seen: SyncOp[] = [];
    const ok = await t.pos.sync({ push: async (op) => (seen.push(op), { status: 'accepted' as const }) });
    expect(ok).toMatchObject({ accepted: 1, remaining: 0 });
    expect(seen).toHaveLength(1);
  });

  it('records a refusal so the cashier can see it, rather than dropping it', async () => {
    const t = await queued();
    const r = await t.pos.sync({ push: async () => ({ status: 'rejected' as const, reason: 'address index 7 is outside this device\'s lease' }) });
    expect(r).toMatchObject({ rejected: 1, remaining: 0 });
    expect((await t.pos.rejected())[0]!.reason).toContain('outside this device');
  });
});
