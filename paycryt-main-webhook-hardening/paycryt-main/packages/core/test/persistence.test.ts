import { describe, expect, it } from 'vitest';
import { ASSETS, LeaseRegistry, LeaseRegistryStore, MemoryStore, PaymentRequestStore, RateSnapshotStore, createPaymentRequest, verifyChain } from '@paycryt/core';
import { makeClock, makeEngine, makeRequest } from './helpers.js';

describe('PaymentRequestStore', () => {
  it('saves, loads and lists payment requests', async () => {
    const store = new PaymentRequestStore(new MemoryStore());
    const { request: a } = await makeRequest();
    const { request: b } = await makeRequest(makeClock(2_000_000_000_000));

    await store.save(a);
    await store.save(b);

    expect(await store.get(a.id)).toEqual(a);
    expect((await store.all()).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    await store.delete(a.id);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.all()).toEqual([b]);
  });

  it('round-trips bigint fields exactly', async () => {
    const store = new PaymentRequestStore(new MemoryStore());
    const { request } = await makeRequest();
    await store.save(request);
    const reloaded = await store.get(request.id);
    expect(typeof reloaded!.amountDue).toBe('bigint');
    expect(reloaded!.amountDue).toBe(request.amountDue);
    expect(reloaded!.fiat.amountMinor).toBe(request.fiat.amountMinor);
  });
});

describe('RateSnapshotStore', () => {
  it('preserves append order, which is chain order', async () => {
    const clock = makeClock();
    const engine = makeEngine(clock.now);
    const store = new RateSnapshotStore(new MemoryStore());

    const s1 = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    await store.append(s1);
    clock.advance(1000);
    const s2 = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    await store.append(s2);

    const loaded = await store.loadAll();
    expect(loaded.map((s) => s.hash)).toEqual([s1.hash, s2.hash]);
    expect(verifyChain(loaded)).toEqual({ ok: true });
  });

  it('a freshly loaded chain can be replayed into a new RateAuditLog / RateEngine', async () => {
    const clock = makeClock();
    const engine = makeEngine(clock.now);
    const store = new RateSnapshotStore(new MemoryStore());
    for (let i = 0; i < 3; i++) {
      const s = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
      await store.append(s);
      clock.advance(1000);
    }

    const loaded = await store.loadAll();
    const fresh = makeEngine(clock.now);
    for (const s of loaded) fresh.log.append(s);
    expect(fresh.log.verify()).toEqual({ ok: true });
    expect(fresh.log.all().map((s) => s.hash)).toEqual(engine.log.all().map((s) => s.hash));
  });
});

describe('LeaseRegistryStore', () => {
  it('returns a fresh registry when nothing was saved', async () => {
    const store = new LeaseRegistryStore(new MemoryStore());
    const registry = await store.load();
    expect(registry.allocate('till-1', 10)).toEqual({ start: 0, end: 10 });
  });

  it('restores allocations so a reloaded registry never reissues an overlapping range', async () => {
    const kv = new MemoryStore();
    const store = new LeaseRegistryStore(kv);
    const original = new LeaseRegistry();
    const till1 = original.allocate('till-1', 100);
    const till2 = original.allocate('till-2', 50);
    await store.save(original);

    const restored = await store.load();
    expect(restored.allocate('till-1', 100)).toEqual(till1); // existing lease returned as-is
    expect(restored.allocate('till-2', 50)).toEqual(till2);
    expect(restored.contains('till-1', till1.start)).toBe(true);
    expect(restored.contains('till-2', till1.start)).toBe(false); // ranges stay disjoint per device

    // A brand-new device gets a range that does not collide with either restored range.
    const till3 = restored.allocate('till-3', 20);
    expect(till3.start).toBeGreaterThanOrEqual(150);
  });

  it('preserves renewed (multi-range) leases across save/load', async () => {
    const kv = new MemoryStore();
    const store = new LeaseRegistryStore(kv);
    const original = new LeaseRegistry();
    const first = original.allocate('till-1', 10);
    const second = original.renew('till-1', 10);
    await store.save(original);

    const restored = await store.load();
    expect(restored.contains('till-1', first.start)).toBe(true);
    expect(restored.contains('till-1', second.start)).toBe(true);
    expect(restored.allocate('till-1', 10)).toEqual(second); // allocate() returns the LATEST range
  });
});

describe('persistence primitives compose end to end', () => {
  it('rebuilds a payable state (requests + rates + leases) after a simulated restart', async () => {
    const clock = makeClock();
    const engine = makeEngine(clock.now);
    const kv = new MemoryStore();
    const payments = new PaymentRequestStore(kv);
    const snapshots = new RateSnapshotStore(kv);
    const leases = new LeaseRegistryStore(kv);

    const registry = new LeaseRegistry();
    const lease = registry.allocate('server', 1000);
    await leases.save(registry);

    const snapshot = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    await snapshots.append(snapshot);

    const request = createPaymentRequest({
      fiat: { currency: 'NGN', amountMinor: 1_500_000n },
      asset: ASSETS.USDT_TRC20,
      address: 'fake:tron:000000',
      addressIndex: lease.start,
      snapshot,
      now: clock.now(),
    });
    await payments.save(request);

    // "restart": fresh in-process objects, same underlying KVStore
    const reloadedRequests = await payments.all();
    const reloadedSnapshots = await snapshots.loadAll();
    const reloadedLeases = await leases.load();

    expect(reloadedRequests).toEqual([request]);
    expect(reloadedSnapshots.map((s) => s.hash)).toEqual([snapshot.hash]);
    expect(reloadedLeases.contains('server', lease.start)).toBe(true);
  });
});
