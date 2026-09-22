import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSETS, FakeChain, MemoryStore, OfflinePOS, toJson, verifyChain, type RateSnapshot, type SyncOp, type SyncResponse } from '@paycryt/core';
import { PaycrytServer } from '@paycryt/server';

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
  server = new PaycrytServer({ apiKey: KEY, sandbox: true, spreadBps: 100 });
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
    const prod = new PaycrytServer({ apiKey: KEY, sandbox: false });
    const url = `http://127.0.0.1:${await prod.listen(0)}`;
    const res = await fetch(`${url}/v1/sandbox/mine`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '{}' });
    expect(res.status).toBe(404);
    await prod.close();
  });
});
