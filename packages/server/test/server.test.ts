import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSETS, FakeChain, MemoryStore, OfflinePOS, toJson, verifyChain, type KVStore, type RateSnapshot, type SyncOp, type SyncResponse } from '@paycryt/core';
import { SqliteStore } from '@paycryt/adapters';
import { PaycrytServer } from '@paycryt/server';
import { liveOptions } from './live-helpers.js';

let server: PaycrytServer;
let base: string;
const KEY = 'test_key';

async function api(method: string, path: string, body?: unknown, key = KEY) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(async () => {
  server = await PaycrytServer.create({ apiKey: KEY, sandbox: true, spreadBps: 100 });
  base = `http://127.0.0.1:${await server.listen(0)}`;
});
afterEach(() => server.close());

describe('reference server + sandbox', () => {
  it('requires the API key', async () => {
    expect((await api('GET', '/v1/payments', undefined, 'nope')).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('runs a payment end to end on the fake chain, with settlement', async () => {
    const created = await api('POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('awaiting_payment');
    const id = created.body.id;

    await api('POST', '/v1/sandbox/deposit', { paymentId: id, scenario: 'exact' });
    const paid = await api('GET', `/v1/payments/${id}`);
    expect(paid.body.status).toBe('paid');

    const events = await api('GET', '/v1/events');
    expect(events.body.map((e: any) => e.type)).toEqual(['payment.confirmed']);
    const payouts = await api('GET', '/v1/payouts');
    expect(payouts.body).toHaveLength(1);
    expect(payouts.body[0].request.amountMinor).toBe('1500000');
  });

  it('handles underpayment, top-up and unconfirmed deposits', async () => {
    const { body } = await api('POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    await api('POST', '/v1/sandbox/deposit', { paymentId: body.id, scenario: 'underpay', percent: 60 });
    let p = (await api('GET', `/v1/payments/${body.id}`)).body;
    expect(p.status).toBe('partially_paid');
    expect(p.actions[0].type).toBe('request_topup');

    await api('POST', '/v1/sandbox/deposit', { paymentId: body.id, scenario: 'underpay', percent: 40 });
    p = (await api('GET', `/v1/payments/${body.id}`)).body;
    expect(p.status).toBe('paid');
  });

  it('expires payments via sandbox time travel', async () => {
    const { body } = await api('POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    await api('POST', '/v1/sandbox/time', { advanceMs: 60 * 60_000 });
    expect((await api('GET', `/v1/payments/${body.id}`)).body.status).toBe('expired');
  });

  it('serves a verifiable rate audit trail and pins each payment to its snapshot', async () => {
    const { body } = await api('POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    const snap = (await api('GET', `/v1/audit/rates/${body.rateSnapshotHash}`)).body as RateSnapshot;
    expect(snap.quotes).toHaveLength(2);
    const audit = (await api('GET', '/v1/audit/rates')).body;
    expect(audit.verification).toEqual({ ok: true });
    expect(verifyChain(audit.snapshots)).toEqual({ ok: true });
  });

  it('rejects bad input clearly', async () => {
    expect((await api('POST', '/v1/payments', { amount: '1', currency: 'XXX', asset: 'USDT_TRC20' })).status).toBe(400);
    expect((await api('POST', '/v1/payments', { amount: '1', currency: 'NGN', asset: 'DOGE' })).body.error).toContain('Unknown asset');
  });

  it('offline POS: lease + rates over HTTP, create offline, sync, get paid', async () => {
    const lease = (await api('POST', '/v1/leases', { deviceId: 'till-1', size: 50 })).body;
    const rate = (await api('GET', '/v1/rates/USDT-NGN')).body as RateSnapshot;

    const pos = new OfflinePOS({ deviceId: 'till-1', deriver: new FakeChain('sandbox'), lease, store: new MemoryStore() });
    await pos.cacheSnapshot(rate);

    // --- no network from here ---
    const { request } = await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 1_500_000n }, asset: ASSETS.USDT_TRC20 });
    // (the customer pays on-chain; in the sandbox we cannot simulate that until the server knows the request)

    const summary = await pos.sync({
      push: async (op: SyncOp) => (await api('POST', '/v1/sync', toJson(op))).body as SyncResponse,
    });
    expect(summary).toMatchObject({ accepted: 1, remaining: 0 });

    await api('POST', '/v1/sandbox/deposit', { paymentId: request.id, scenario: 'exact' });
    const paid = (await api('GET', `/v1/payments/${request.id}`)).body;
    expect(paid.status).toBe('paid');
    expect(paid.offline.deviceId).toBe('till-1');
  });

  it('sandbox can be disabled', async () => {
    const prod = await PaycrytServer.create({ apiKey: KEY, ...liveOptions() });
    const url = `http://127.0.0.1:${await prod.listen(0)}`;
    const res = await fetch(`${url}/v1/sandbox/mine`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '{}' });
    expect(res.status).toBe(404);
    await prod.close();
  });
});

describe('persistence: survives a restart when a store is configured', () => {
  async function boot(store: KVStore) {
    const s = await PaycrytServer.create({ apiKey: KEY, sandbox: true, spreadBps: 100, store });
    const url = `http://127.0.0.1:${await s.listen(0)}`;
    return { server: s, url };
  }
  const call = (url: string, method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(
      async (res) => ({ status: res.status, body: (await res.json()) as any }),
    );

  it('reloads an in-flight payment, its rate snapshot and its lease after a restart (MemoryStore)', async () => {
    const store = new MemoryStore();
    const first = await boot(store);

    const created = await call(first.url, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    expect(created.status).toBe(201);
    const lease = await call(first.url, 'POST', '/v1/leases', { deviceId: 'till-9', size: 10 });
    expect(lease.body).toEqual({ start: 1_000_000, end: 1_000_010 }); // right after the server's own 1,000,000-slot range
    await first.server.close();

    // "restart": a brand-new server instance, same underlying store, nothing carried over in memory.
    const second = await boot(store);

    const reloaded = await call(second.url, 'GET', `/v1/payments/${created.body.id}`);
    expect(reloaded.body).toMatchObject({ id: created.body.id, status: 'awaiting_payment', address: created.body.address, amountDue: created.body.amountDue });

    const snap = await call(second.url, 'GET', `/v1/audit/rates/${created.body.rateSnapshotHash}`);
    expect(snap.status).toBe(200);
    const audit = await call(second.url, 'GET', '/v1/audit/rates');
    expect(audit.body.verification).toEqual({ ok: true });

    // The lease survived too: a fresh allocation for the same device returns the SAME range, not a new one.
    const leaseAgain = await call(second.url, 'POST', '/v1/leases', { deviceId: 'till-9', size: 10 });
    expect(leaseAgain.body).toEqual(lease.body);
    // And a brand-new device is not handed an overlapping range.
    const newDeviceLease = await call(second.url, 'POST', '/v1/leases', { deviceId: 'till-new', size: 10 });
    expect(newDeviceLease.body.start).toBeGreaterThanOrEqual(1_000_010);

    // The reloaded payment can still be paid and settled after the restart.
    await call(second.url, 'POST', '/v1/sandbox/deposit', { paymentId: created.body.id, scenario: 'exact' });
    const paid = await call(second.url, 'GET', `/v1/payments/${created.body.id}`);
    expect(paid.body.status).toBe('paid');

    await first.server.close();
    await second.server.close();
  });

  it('does not reissue an already-used server address index after a restart', async () => {
    const store = new MemoryStore();
    const first = await boot(store);
    const a = await call(first.url, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    await first.server.close();

    const second = await boot(store);
    const b = await call(second.url, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    expect(b.body.address).not.toBe(a.body.address);
    await second.server.close();
  });

  it('runs fully in-memory as before when no store is configured (no behaviour change)', async () => {
    const noStore = await PaycrytServer.create({ apiKey: KEY, sandbox: true });
    const u = `http://127.0.0.1:${await noStore.listen(0)}`;
    const created = await call(u, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
    expect(created.status).toBe(201);
    await noStore.close();
  });

  it('survives a real restart against a real SQLite file, not just MemoryStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paycryt-server-sqlite-'));
    const path = join(dir, 'paycryt.sqlite');
    try {
      const dbA = new SqliteStore(path);
      const first = await boot(dbA);
      const created = await call(first.url, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' });
      await first.server.close();
      dbA.close();

      const dbB = new SqliteStore(path); // a genuinely separate SqliteStore instance over the same file
      const second = await boot(dbB);
      const reloaded = await call(second.url, 'GET', `/v1/payments/${created.body.id}`);
      expect(reloaded.body.status).toBe('awaiting_payment');
      expect(reloaded.body.amountDue).toBe(created.body.amountDue);
      await second.server.close();
      dbB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
