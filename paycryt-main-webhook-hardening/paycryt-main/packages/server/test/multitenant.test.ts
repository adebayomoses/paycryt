import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSETS, FakeChain, MemoryStore, OfflinePOS, toJson, verifyWebhook, type RateSnapshot, type SyncOp, type SyncResponse } from '@paycryt/core';
import { PaycrytServer } from '@paycryt/server';

const ADMIN = 'admin_key';
let server: PaycrytServer;
let base: string;

async function call(key: string | undefined, method: string, path: string, body?: unknown, url = base) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function newMerchant(name: string, extra: Record<string, unknown> = {}, url = base) {
  const r = await call(ADMIN, 'POST', '/v1/admin/merchants', { name, ...extra }, url);
  expect(r.status).toBe(201);
  return { id: r.body.merchant.id as string, key: r.body.apiKey as string, webhookSecret: r.body.webhookSecret as string | undefined };
}

const PAY = { amount: '15000', currency: 'NGN', asset: 'USDT_TRC20' };

beforeEach(async () => {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, spreadBps: 100 });
  base = `http://127.0.0.1:${await server.listen(0)}`;
});
afterEach(() => server.close());

describe('merchant management', () => {
  it('creates a merchant, returns the key once, and never lists secrets', async () => {
    const created = await call(ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada Stores', webhookUrl: 'https://ada.example/hook' });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^pk_[0-9a-f]{64}$/);
    expect(created.body.webhookSecret).toMatch(/^whsec_/);
    expect(created.body.merchant).not.toHaveProperty('keyHash');
    expect(created.body.merchant).not.toHaveProperty('webhookSecret');

    const list = await call(ADMIN, 'GET', '/v1/admin/merchants');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.apiKey);
    expect(JSON.stringify(list.body)).not.toContain(created.body.webhookSecret);
    expect(list.body[0].hasWebhookSecret).toBe(true);

    const one = await call(ADMIN, 'GET', `/v1/admin/merchants/${created.body.merchant.id}`);
    expect(one.body.name).toBe('Ada Stores');
  });

  it('a merchant key identifies itself via /v1/me, and the admin key is the admin', async () => {
    const a = await newMerchant('Ada');
    const me = await call(a.key, 'GET', '/v1/me');
    expect(me.body).toMatchObject({ role: 'merchant', merchant: { id: a.id, name: 'Ada' } });
    expect((await call(ADMIN, 'GET', '/v1/me')).body).toEqual({ role: 'admin' });
  });

  it('rejects missing, unknown and malformed keys with 401', async () => {
    expect((await call(undefined, 'GET', '/v1/payments')).status).toBe(401);
    expect((await call('pk_' + '0'.repeat(64), 'GET', '/v1/payments')).status).toBe(401);
    expect((await call('garbage', 'GET', '/v1/payments')).status).toBe(401);
  });

  it('merchant keys cannot use admin endpoints', async () => {
    const a = await newMerchant('Ada');
    expect((await call(a.key, 'GET', '/v1/admin/merchants')).status).toBe(403);
    expect((await call(a.key, 'POST', '/v1/admin/merchants', { name: 'Sneaky' })).status).toBe(403);
    expect((await call(a.key, 'POST', `/v1/admin/merchants/${a.id}/rotate-key`)).status).toBe(403);
    expect((await call(a.key, 'POST', `/v1/admin/merchants/${a.id}/disable`)).status).toBe(403);
  });

  it('validates merchant input', async () => {
    const bad = (body: unknown) => call(ADMIN, 'POST', '/v1/admin/merchants', body);
    expect((await bad({})).status).toBe(400);
    expect((await bad({ name: 'x', webhookUrl: 'not a url' })).status).toBe(400);
    expect((await bad({ name: 'x', webhookUrl: 'ftp://x.example' })).status).toBe(400);
    expect((await bad({ name: 'x', surprise: 1 })).body.error).toContain('Unknown field');
    expect((await bad({ name: 'x', spreadBps: -3 })).status).toBe(400);
    expect((await bad({ name: 'x', policy: { expiry: 5 } })).body.error).toContain('Unknown policy field');
    expect((await bad({ name: 'x', webhookUrl: 'https://x.example', webhookSecret: 'short' })).status).toBe(400);
  });

  it('rotating a key kills the old one at once; disabling blocks a merchant but re-enabling restores them', async () => {
    const a = await newMerchant('Ada');
    const rotated = await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/rotate-key`);
    expect(rotated.status).toBe(200);
    expect((await call(a.key, 'GET', '/v1/payments')).status).toBe(401);
    expect((await call(rotated.body.apiKey, 'GET', '/v1/payments')).status).toBe(200);

    expect((await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/disable`)).body.disabled).toBe(true);
    expect((await call(rotated.body.apiKey, 'GET', '/v1/payments')).status).toBe(401);
    await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/enable`);
    expect((await call(rotated.body.apiKey, 'GET', '/v1/payments')).status).toBe(200);

    expect((await call(ADMIN, 'POST', '/v1/admin/merchants/mch_deadbeef/rotate-key')).status).toBe(404);
    expect((await call(ADMIN, 'GET', '/v1/admin/merchants/mch_deadbeef')).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("one merchant cannot see, probe or pay another's payments", async () => {
    const a = await newMerchant('Ada');
    const b = await newMerchant('Bola');
    const pay = (await call(a.key, 'POST', '/v1/payments', PAY)).body;
    expect(pay.merchantId).toBe(a.id);

    expect((await call(a.key, 'GET', `/v1/payments/${pay.id}`)).status).toBe(200);
    // B gets exactly what an unknown id gets, so ids can't be probed.
    const probe = await call(b.key, 'GET', `/v1/payments/${pay.id}`);
    const missing = await call(b.key, 'GET', '/v1/payments/pay_doesnotexist');
    expect(probe.status).toBe(404);
    expect(probe.body).toEqual(missing.body);

    expect((await call(b.key, 'GET', '/v1/payments')).body).toEqual([]);
    expect((await call(a.key, 'GET', '/v1/payments')).body).toHaveLength(1);
    expect((await call(ADMIN, 'GET', '/v1/payments')).body).toHaveLength(1); // the operator sees everything

    // B cannot use the sandbox to pay (or otherwise poke) A's payment.
    expect((await call(b.key, 'POST', '/v1/sandbox/deposit', { paymentId: pay.id, scenario: 'exact' })).status).toBe(404);
    expect((await call(a.key, 'GET', `/v1/payments/${pay.id}`)).body.status).toBe('awaiting_payment');
  });

  it('events and payouts are scoped to their owner', async () => {
    const a = await newMerchant('Ada');
    const b = await newMerchant('Bola');
    const pa = (await call(a.key, 'POST', '/v1/payments', PAY)).body;
    const pb = (await call(b.key, 'POST', '/v1/payments', PAY)).body;
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: pa.id, scenario: 'exact' });
    await call(b.key, 'POST', '/v1/sandbox/deposit', { paymentId: pb.id, scenario: 'exact' });

    const eventsA = (await call(a.key, 'GET', '/v1/events')).body;
    const eventsB = (await call(b.key, 'GET', '/v1/events')).body;
    expect(eventsA.map((e: any) => e.paymentId)).toEqual([pa.id]);
    expect(eventsB.map((e: any) => e.paymentId)).toEqual([pb.id]);
    expect((await call(ADMIN, 'GET', '/v1/events')).body).toHaveLength(2);

    const payoutsA = (await call(a.key, 'GET', '/v1/payouts')).body;
    expect(payoutsA).toHaveLength(1);
    expect(payoutsA[0].reference).toBe(`settle_${pa.id}`);
    expect((await call(ADMIN, 'GET', '/v1/payouts')).body).toHaveLength(2);
  });

  it('a merchant can run the sandbox for their own payments but not change the shared clock, chain or market', async () => {
    const a = await newMerchant('Ada');
    const pay = (await call(a.key, 'POST', '/v1/payments', PAY)).body;
    expect((await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: pay.id, scenario: 'exact' })).status).toBe(200);
    expect((await call(a.key, 'POST', '/v1/sandbox/time', { advanceMs: 1000 })).status).toBe(403);
    expect((await call(a.key, 'POST', '/v1/sandbox/mine', { blocks: 1 })).status).toBe(403);
    expect((await call(a.key, 'POST', '/v1/sandbox/rates', { pair: 'USDT/NGN', price: '1' })).status).toBe(403);
    expect((await call(ADMIN, 'POST', '/v1/sandbox/time', { advanceMs: 1000 })).status).toBe(200);
  });

  it('the shared rate audit trail is readable by merchants and stays verifiable', async () => {
    const a = await newMerchant('Ada');
    await call(a.key, 'POST', '/v1/payments', PAY);
    const audit = await call(a.key, 'GET', '/v1/audit/rates');
    expect(audit.body.verification).toEqual({ ok: true });
  });
});

describe('per-merchant settings', () => {
  it("applies the merchant's policy defaults and merges a per-request override field by field", async () => {
    const a = await newMerchant('Ada', { policy: { expiryMs: 120_000, underpayment: { toleranceBps: 1000 } } });
    const before = Date.now();
    const pay = (await call(a.key, 'POST', '/v1/payments', PAY)).body;
    expect(pay.expiresAt - before).toBeGreaterThan(110_000);
    expect(pay.expiresAt - before).toBeLessThan(130_000);

    // 95% is inside the merchant's 10% tolerance, so it counts as paid...
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: pay.id, scenario: 'underpay', percent: 95 });
    expect((await call(a.key, 'GET', `/v1/payments/${pay.id}`)).body.status).toBe('paid');

    // ...while a request that overrides only the tolerance keeps the rest of the merchant's policy.
    const strict = (await call(a.key, 'POST', '/v1/payments', { ...PAY, policy: { underpayment: { toleranceBps: 0 } } })).body;
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: strict.id, scenario: 'underpay', percent: 95 });
    expect((await call(a.key, 'GET', `/v1/payments/${strict.id}`)).body.status).toBe('partially_paid');
    expect(strict.expiresAt - before).toBeLessThan(130_000); // still the merchant's 2 minute expiry
  });

  it('rejects an invalid per-request policy instead of silently ignoring it', async () => {
    const a = await newMerchant('Ada');
    const r = await call(a.key, 'POST', '/v1/payments', { ...PAY, policy: { expiry: 5 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Unknown policy field');
    expect((await call(a.key, 'POST', '/v1/payments', { ...PAY, policy: { expiryMs: -1 } })).status).toBe(400);
    expect((await call(a.key, 'POST', '/v1/payments', { ...PAY, metadata: { k: 5 } })).status).toBe(400);
  });

  it("charges each merchant their own spread", async () => {
    const cheap = await newMerchant('Cheap', { spreadBps: 0 });
    const pricey = await newMerchant('Pricey', { spreadBps: 500 });
    const a = (await call(cheap.key, 'POST', '/v1/payments', PAY)).body;
    const b = (await call(pricey.key, 'POST', '/v1/payments', PAY)).body;
    const dflt = (await call(ADMIN, 'POST', '/v1/payments', PAY)).body; // server default is 100 bps
    expect(BigInt(a.amountDue)).toBeLessThan(BigInt(dflt.amountDue));
    expect(BigInt(dflt.amountDue)).toBeLessThan(BigInt(b.amountDue));
  });
});

describe('webhooks are routed per merchant with their own secret', () => {
  let receivers: Array<{ server: Server; url: string; got: Array<{ body: string; signature: string }> }> = [];

  async function receiver() {
    const got: Array<{ body: string; signature: string }> = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push({ body: Buffer.concat(chunks).toString('utf8'), signature: String(req.headers['paycryt-signature']) });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const entry = { server: s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}/hook`, got };
    receivers.push(entry);
    return entry;
  }
  afterEach(async () => {
    await Promise.all(receivers.map((r) => new Promise((res) => r.server.close(res))));
    receivers = [];
  });

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("sends each event only to its merchant's endpoint, signed with that merchant's secret", async () => {
    const ra = await receiver();
    const rb = await receiver();
    const a = await newMerchant('Ada', { webhookUrl: ra.url });
    const b = await newMerchant('Bola', { webhookUrl: rb.url });
    expect(a.webhookSecret).not.toBe(b.webhookSecret);

    const pa = (await call(a.key, 'POST', '/v1/payments', PAY)).body;
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: pa.id, scenario: 'exact' });
    await until(() => ra.got.length > 0);

    expect(ra.got).toHaveLength(1);
    expect(JSON.parse(ra.got[0]!.body)).toMatchObject({ type: 'payment.confirmed', paymentId: pa.id });
    expect(verifyWebhook(a.webhookSecret!, ra.got[0]!.body, ra.got[0]!.signature)).toBe(true);
    expect(verifyWebhook(b.webhookSecret!, ra.got[0]!.body, ra.got[0]!.signature)).toBe(false); // B's secret can't validate A's events
    await new Promise((r) => setTimeout(r, 150));
    expect(rb.got).toHaveLength(0); // Bola never hears about Ada's payment
  });

  it('a merchant without a webhook simply gets none, and a disabled merchant is not called', async () => {
    const r = await receiver();
    const quiet = await newMerchant('Quiet');
    const loud = await newMerchant('Loud', { webhookUrl: r.url });
    const p = (await call(quiet.key, 'POST', '/v1/payments', PAY)).body;
    await call(quiet.key, 'POST', '/v1/sandbox/deposit', { paymentId: p.id, scenario: 'exact' });

    const p2 = (await call(loud.key, 'POST', '/v1/payments', PAY)).body;
    await call(ADMIN, 'POST', `/v1/admin/merchants/${loud.id}/disable`);
    await call(ADMIN, 'POST', '/v1/sandbox/deposit', { paymentId: p2.id, scenario: 'exact' });
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toHaveLength(0);
  });
});

describe('offline devices belong to one merchant', () => {
  async function pos(deviceId: string, key: string) {
    const lease = (await call(key, 'POST', '/v1/leases', { deviceId, size: 20 })).body;
    const rate = (await call(key, 'GET', '/v1/rates/USDT-NGN')).body as RateSnapshot;
    const p = new OfflinePOS({ deviceId, deriver: new FakeChain('sandbox'), lease, store: new MemoryStore() });
    await p.cacheSnapshot(rate);
    return p;
  }
  const NGN_15K = { currency: 'NGN', amountMinor: 1_500_000n };

  it("a merchant cannot lease, renew or sync another merchant's device", async () => {
    const a = await newMerchant('Ada');
    const b = await newMerchant('Bola');
    const till = await pos('till-a', a.key);
    await till.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });

    expect((await call(b.key, 'POST', '/v1/leases', { deviceId: 'till-a' })).status).toBe(403);
    expect((await call(b.key, 'POST', '/v1/leases/renew', { deviceId: 'till-a' })).status).toBe(403);

    const [op] = await till.pending();
    const stolen = await call(b.key, 'POST', '/v1/sync', toJson(op!));
    expect(stolen.status).toBe(403);
    expect(stolen.body.reason).toContain('not registered to your merchant');
    expect((await call(b.key, 'GET', '/v1/payments')).body).toEqual([]);
  });

  it("a synced payment belongs to the device's merchant, whatever the device claims", async () => {
    const a = await newMerchant('Ada');
    const b = await newMerchant('Bola');
    const till = await pos('till-a', a.key);
    const { request } = await till.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });

    const summary = await till.sync({
      push: async (op: SyncOp) => {
        op.request.merchantId = b.id; // a hostile device tries to book the payment to someone else
        return (await call(a.key, 'POST', '/v1/sync', toJson(op))).body as SyncResponse;
      },
    });
    expect(summary).toMatchObject({ accepted: 1, remaining: 0 });

    const mine = (await call(a.key, 'GET', `/v1/payments/${request.id}`)).body;
    expect(mine.merchantId).toBe(a.id);
    expect((await call(b.key, 'GET', `/v1/payments/${request.id}`)).status).toBe(404);

    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: request.id, scenario: 'exact' });
    expect((await call(a.key, 'GET', `/v1/payments/${request.id}`)).body.status).toBe('paid');
  });

  it('a device the operator registered cannot be claimed by a merchant', async () => {
    const a = await newMerchant('Ada');
    await call(ADMIN, 'POST', '/v1/leases', { deviceId: 'ops-till', size: 10 });
    expect((await call(a.key, 'POST', '/v1/leases', { deviceId: 'ops-till' })).status).toBe(403);
  });

  it('validates device ids and lease sizes', async () => {
    const a = await newMerchant('Ada');
    expect((await call(a.key, 'POST', '/v1/leases', { deviceId: '../etc/passwd' })).status).toBe(400);
    expect((await call(a.key, 'POST', '/v1/leases', {})).status).toBe(400);
    expect((await call(a.key, 'POST', '/v1/leases', { deviceId: 'ok', size: 10_000_000 })).status).toBe(400);
    expect((await call(a.key, 'POST', '/v1/leases', { deviceId: 'ok', size: 0 })).status).toBe(400);
  });
});

describe('multi-tenant state survives a restart', () => {
  it('keeps merchants, their keys, payment ownership and device ownership', async () => {
    const store = new MemoryStore();
    const first = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store });
    const url1 = `http://127.0.0.1:${await first.listen(0)}`;
    const a = await newMerchant('Ada', { policy: { expiryMs: 120_000 } }, url1);
    const pay = (await call(a.key, 'POST', '/v1/payments', PAY, url1)).body;
    await call(a.key, 'POST', '/v1/leases', { deviceId: 'till-a', size: 10 }, url1);
    await first.close();

    const second = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store });
    const url2 = `http://127.0.0.1:${await second.listen(0)}`;
    try {
      expect((await call(a.key, 'GET', '/v1/me', undefined, url2)).body.merchant.name).toBe('Ada'); // the same key still works
      const reloaded = await call(a.key, 'GET', `/v1/payments/${pay.id}`, undefined, url2);
      expect(reloaded.body).toMatchObject({ id: pay.id, merchantId: a.id });

      const b = await newMerchant('Bola', {}, url2);
      expect((await call(b.key, 'GET', `/v1/payments/${pay.id}`, undefined, url2)).status).toBe(404); // isolation holds after reload
      expect((await call(b.key, 'POST', '/v1/leases', { deviceId: 'till-a' }, url2)).status).toBe(403); // so does device ownership
    } finally {
      await second.close();
    }
  });

  it('never writes a merchant API key into the store in plaintext', async () => {
    const store = new MemoryStore();
    const s = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store });
    const url = `http://127.0.0.1:${await s.listen(0)}`;
    try {
      const a = await newMerchant('Ada', {}, url);
      const dump: string[] = [];
      for (const k of await store.keys('')) dump.push(k, JSON.stringify(await store.get(k)));
      expect(dump.join('\n')).not.toContain(a.key);
    } finally {
      await s.close();
    }
  });
});
