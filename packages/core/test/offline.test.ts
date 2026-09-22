import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  FakeChain,
  LeaseExhaustedError,
  LeaseRegistry,
  MemoryStore,
  OfflinePOS,
  PaymentWatcher,
  RateTooStaleError,
  SyncReceiver,
  fromJson,
  toJson,
  verifyChain,
  type PaymentEvent,
  type SyncOp,
  type SyncTransport,
} from '@paycryt/core';
import { makeClock, makeEngine } from './helpers.js';

const NGN_15K = { currency: 'NGN', amountMinor: 1_500_000n };

async function setup(opts: { leaseSize?: number; maxRateAgeMs?: number } = {}) {
  const clock = makeClock();
  const engine = makeEngine(clock.now);
  const chain = new FakeChain('tron', clock.now);
  const watcher = new PaymentWatcher([chain], clock.now);
  const events: PaymentEvent[] = [];
  watcher.on((e) => void events.push(e));

  const leases = new LeaseRegistry();
  const lease = leases.allocate('pos-1', opts.leaseSize ?? 100);
  const receiver = new SyncReceiver({
    deriver: chain,
    leases,
    onAccepted: (r) => watcher.watch(r),
    isKnownSnapshot: (h) => !!engine.log.get(h),
  });
  const pos = new OfflinePOS({
    deviceId: 'pos-1',
    deriver: chain,
    lease,
    store: new MemoryStore(),
    clock: clock.now,
    maxRateAgeMs: opts.maxRateAgeMs,
  });
  await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);
  const transport: SyncTransport = { push: (op) => receiver.apply(fromJson<SyncOp>(toJson(op))) }; // over the "wire"
  return { clock, engine, chain, watcher, events, leases, receiver, pos, transport };
}

describe('offline-first POS', () => {
  it('creates a payment with no network, then syncs and gets paid', async () => {
    const s = await setup();
    const { request, uri } = await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });

    // Offline safety margin (default 150 bps) makes the customer pay a bit more than the plain 10 USDT.
    expect(request.amountDue).toBeGreaterThan(10_000_000n);
    expect(request.amountDue).toBe(10_152_285n); // 15000 / (1500 * 0.985) = 10.1522842..., rounded UP to 6 dp
    expect(request.offline?.deviceId).toBe('pos-1');
    expect(uri).toContain(request.address);

    // The customer pays on-chain while the POS is still offline.
    s.chain.scenarios.exact(request);
    expect(await s.pos.pending()).toHaveLength(1);

    // Connectivity returns.
    const summary = await s.pos.sync(s.transport);
    expect(summary).toEqual({ accepted: 1, duplicates: 0, rejected: 0, remaining: 0 });
    await s.watcher.tick();
    expect(s.events.map((e) => e.type)).toEqual(['payment.confirmed']);
  });

  it('keeps the full rate lineage auditable', async () => {
    const s = await setup();
    const { request } = await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const [op] = await s.pos.pending();
    expect(verifyChain(op!.snapshots)).toEqual({ ok: true });
    expect(op!.snapshots).toHaveLength(2);
    expect(op!.snapshots[1]!.derivedFrom?.hash).toBe(op!.snapshots[0]!.hash);
    expect(op!.snapshots[1]!.hash).toBe(request.rateSnapshotHash);
  });

  it('is idempotent: replaying the same op is a no-op', async () => {
    const s = await setup();
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const [op] = await s.pos.pending();
    expect(await s.transport.push(op!)).toEqual({ status: 'accepted' });
    expect(await s.transport.push(op!)).toEqual({ status: 'duplicate' });
    expect(s.watcher.list()).toHaveLength(1);
  });

  it('keeps unsynced ops queued when the network drops mid-sync, preserving order', async () => {
    const s = await setup();
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });

    let calls = 0;
    const flaky: SyncTransport = {
      push: async (op) => {
        if (++calls === 2) throw new Error('network down');
        return s.transport.push(op);
      },
    };
    const first = await s.pos.sync(flaky);
    expect(first).toMatchObject({ accepted: 1, remaining: 2 });
    const second = await s.pos.sync(s.transport);
    expect(second).toMatchObject({ accepted: 2, remaining: 0 });
    expect(s.watcher.list()).toHaveLength(3);
  });

  it('gives each device its own address range, so devices never collide', async () => {
    const s = await setup();
    const other = s.leases.allocate('pos-2', 100);
    expect(other.start).toBe(100);
    const pos2 = new OfflinePOS({ deviceId: 'pos-2', deriver: s.chain, lease: other, store: new MemoryStore(), clock: s.clock.now });
    await pos2.cacheRates(s.engine, [{ base: 'USDT', quote: 'NGN' }]);
    const a = await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const b = await pos2.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    expect(a.request.address).not.toBe(b.request.address);
  });

  it('refuses to price from a stale cached rate', async () => {
    const s = await setup({ maxRateAgeMs: 60 * 60_000 });
    s.clock.advance(61 * 60_000);
    await expect(s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 })).rejects.toBeInstanceOf(RateTooStaleError);
  });

  it('stops when the address lease runs out', async () => {
    const s = await setup({ leaseSize: 2 });
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    await expect(s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 })).rejects.toBeInstanceOf(LeaseExhaustedError);
  });

  it('refuses to work with no cached rate at all', async () => {
    const clock = makeClock();
    const chain = new FakeChain('tron', clock.now);
    const pos = new OfflinePOS({ deviceId: 'x', deriver: chain, lease: { start: 0, end: 10 }, store: new MemoryStore(), clock: clock.now });
    await expect(pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 })).rejects.toThrow(/No cached rate/);
  });
});

describe('sync receiver distrusts devices', () => {
  async function tamper(mutate: (op: SyncOp) => void) {
    const s = await setup();
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const [stored] = await s.pos.pending();
    const op = fromJson<SyncOp>(toJson(stored));
    mutate(op);
    return s.receiver.apply(op);
  }

  it('rejects a device that under-charges the customer', async () => {
    const res = await tamper((op) => (op.request.amountDue = 5_000_000n));
    expect(res).toMatchObject({ status: 'rejected' });
    expect((res as { reason: string }).reason).toContain('amount due should be');
  });

  it('rejects an address outside the device lease or not derived from the xpub', async () => {
    const outside = await tamper((op) => {
      op.addressIndex = 5000;
      op.request.addressIndex = 5000;
    });
    expect((outside as { reason: string }).reason).toContain('outside');

    const forged = await tamper((op) => (op.request.address = 'attacker-address'));
    expect((forged as { reason: string }).reason).toContain('does not derive');
  });

  it('rejects an edited rate (hash mismatch)', async () => {
    const res = await tamper((op) => {
      op.snapshots[1]!.effectiveRate = '1000';
      op.request.effectiveRate = '1000';
    });
    expect((res as { reason: string }).reason).toContain('audit trail invalid');
  });

  it('rejects rates the server never issued', async () => {
    const s = await setup();
    await s.pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const [stored] = await s.pos.pending();
    const foreignEngine = makeEngine(s.clock.now, { price: '3000' });
    const foreign = new SyncReceiver({
      deriver: s.chain,
      leases: s.leases,
      onAccepted: () => {},
      isKnownSnapshot: (h) => !!foreignEngine.log.get(h),
    });
    const res = await foreign.apply(stored!);
    expect((res as { reason: string }).reason).toContain('not issued by this server');
  });

  it('rejects an excessive offline margin', async () => {
    const s = await setup();
    const greedy = new OfflinePOS({
      deviceId: 'pos-1',
      deriver: s.chain,
      lease: { start: 0, end: 100 },
      store: new MemoryStore(),
      clock: s.clock.now,
      offlineSpreadBps: 2000,
    });
    await greedy.cacheRates(s.engine, [{ base: 'USDT', quote: 'NGN' }]);
    await greedy.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
    const summary = await greedy.sync(s.transport);
    expect(summary.rejected).toBe(1);
    const dead = await greedy.rejected();
    expect(dead[0]!.reason).toContain('offline margin');
  });
});
