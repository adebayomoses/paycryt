import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@paycryt/core';
import { PaycrytServer } from '@paycryt/server';
import { ApiError, NetworkError, PosDevice, type Sale } from '../pos/src/device.js';

const ADMIN = 'admin_key_0123456789abcdef';
const SITE = 'http://till.test'; // what the device thinks the server is called; `route` decides where it really goes

let servers: PaycrytServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** A server plus a fetch whose destination (and failures) the test controls, standing in for the network. */
async function world(opts: { shared?: MemoryStore } = {}) {
  const serverStore = opts.shared ?? new MemoryStore();
  const start = async () => {
    const s = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store: serverStore });
    servers.push(s);
    return `http://127.0.0.1:${await s.listen(0)}`;
  };
  const net = {
    target: await start() as string | undefined,
    /** Replace the response of matching requests, to model proxies, rate limiting and the like. */
    override: undefined as undefined | ((path: string) => Response | undefined),
    calls: [] as string[],
  };
  const fetchLike: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = url.slice(SITE.length);
    net.calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (!net.target) throw new TypeError('fetch failed'); // connection refused, no route, airplane mode
    const forced = net.override?.(path);
    if (forced) return forced;
    return globalThis.fetch(net.target + path, init);
  };
  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const r = await globalThis.fetch(net.target + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const merchant = async (name = 'Ada Stores') => (await api(ADMIN, 'POST', '/v1/admin/merchants', { name })).body.apiKey as string;
  return { net, fetchLike, api, merchant, restart: async () => { net.target = await start(); } };
}

async function till(w: Awaited<ReturnType<typeof world>>, extra: { clock?: () => number; store?: MemoryStore } = {}) {
  return PosDevice.open({ store: extra.store ?? new MemoryStore(), fetch: w.fetchLike, baseUrl: SITE, clock: extra.clock });
}

describe('pairing', () => {
  it('pairs with a merchant key, learns the shop setup, and caches rates it can sell with', async () => {
    const w = await world();
    const key = await w.merchant();
    const device = await till(w);
    expect(device.paired).toBe(false);
    await device.pair({ apiKey: key, currency: 'NGN', deviceName: 'Front Till' });

    expect(device.paired).toBe(true);
    const cfg = device.deviceConfig!;
    expect(cfg.deviceId).toMatch(/^front-till-[a-z0-9]{1,4}$/);
    expect(cfg.merchant.name).toBe('Ada Stores');
    expect(cfg.sandbox).toBe(true);
    expect(cfg.chains.sort()).toEqual(['base', 'bitcoin', 'bsc', 'ethereum', 'tron']);
    // Sandbox prices exist for USDT, USDC and BTC in NGN but not ETH, so ETH is offered by the server's chains
    // yet cannot be priced, and the till must not offer it as something to sell.
    expect(device.sellableKeys().sort()).toEqual(['BTC', 'USDC_BASE', 'USDT_BEP20', 'USDT_ERC20', 'USDT_TRC20']);
    expect(device.candidateKeys()).toContain('ETH');
  });

  it('is remembered across a restart of the app (same store)', async () => {
    const w = await world();
    const store = new MemoryStore();
    const first = await till(w, { store });
    await first.pair({ apiKey: await w.merchant(), currency: 'NGN' });
    const reopened = await PosDevice.open({ store, fetch: w.fetchLike, baseUrl: SITE });
    expect(reopened.paired).toBe(true);
    expect(reopened.deviceConfig!.deviceId).toBe(first.deviceConfig!.deviceId);
  });

  it('refuses a wrong key and refuses the operator key, with messages a cashier can act on', async () => {
    const w = await world();
    const device = await till(w);
    await expect(device.pair({ apiKey: 'pk_nope', currency: 'NGN' })).rejects.toBeInstanceOf(ApiError);
    await expect(device.pair({ apiKey: ADMIN, currency: 'NGN' })).rejects.toThrow(/operator key/);
    await expect(device.pair({ apiKey: '  ', currency: 'NGN' })).rejects.toThrow(/API key/);
    expect(device.paired).toBe(false);
  });

  it('gets a fresh device id each time, so a re-paired till can never be handed back an old address range', async () => {
    const w = await world();
    const key = await w.merchant();
    const a = await till(w);
    const b = await till(w);
    await a.pair({ apiKey: key, currency: 'NGN', deviceName: 'till' });
    await b.pair({ apiKey: key, currency: 'NGN', deviceName: 'till' });
    expect(a.deviceConfig!.deviceId).not.toBe(b.deviceConfig!.deviceId);
    expect(a.deviceConfig!.leases[0]).not.toEqual(b.deviceConfig!.leases[0]); // disjoint ranges
  });
});

describe('selling and syncing', () => {
  async function paired(opts: { leaseSize?: number; clock?: () => number } = {}) {
    const w = await world();
    const key = await w.merchant();
    const device = await till(w, { clock: opts.clock });
    await device.pair({ apiKey: key, currency: 'NGN', leaseSize: opts.leaseSize });
    return { w, key, device };
  }

  it('sells while the server is unreachable, marks the price as offline, then syncs everything when it is back', async () => {
    const { w, key, device } = await paired();

    const online = await device.sell({ amount: '15000', assetKey: 'USDT_TRC20' });
    expect(online.pricedOffline).toBe(false);

    // The network drops. Nothing about selling may depend on it.
    w.net.target = undefined;
    expect(await device.probe()).toBe(false);
    expect(device.online).toBe(false);
    const offline = [
      await device.sell({ amount: '15000', assetKey: 'USDT_TRC20', note: 'order 1' }),
      await device.sell({ amount: '500.50', assetKey: 'BTC' }),
      await device.sell({ amount: '2000', assetKey: 'USDC_BASE' }),
    ];
    expect(offline.every((s) => s.pricedOffline && s.status === 'queued')).toBe(true);
    // The same basket costs the customer more offline: the safety margin for price movement the till cannot see.
    expect(offline[0]!.amountDue).toBeGreaterThan(online.amountDue);
    expect(new Set([online, ...offline].map((s) => s.address)).size).toBe(4); // never the same address twice

    const dropped = await device.sync();
    expect(dropped).toMatchObject({ attempted: false, remaining: 4 });

    // Back online: the queue drains, and the server now knows about every sale.
    await w.restart();
    expect(await device.probe()).toBe(true);
    const report = await device.sync();
    expect(report).toMatchObject({ attempted: true, accepted: 4, rejected: 0, remaining: 0 });
    const serverSees = (await w.api(key, 'GET', '/v1/payments')).body as any[];
    expect(serverSees.map((p) => p.id).sort()).toEqual([online, ...offline].map((s) => s.id).sort());
    const sales = await device.sales();
    expect(sales.every((s) => s.status === 'synced' && s.serverStatus === 'awaiting_payment')).toBe(true);
  });

  it('shows a sale as paid once the customer has paid, without the cashier doing anything but syncing', async () => {
    const { w, key, device } = await paired();
    const sale = await device.sell({ amount: '4200', assetKey: 'USDT_TRC20' });
    await device.sync();
    await w.api(key, 'POST', '/v1/sandbox/deposit', { paymentId: sale.id, scenario: 'exact' });
    await device.sync();
    const [updated] = (await device.sales()).filter((s: Sale) => s.id === sale.id);
    expect(updated).toMatchObject({ status: 'synced', serverStatus: 'paid' });
    expect(updated!.received).toBe(sale.amountDue);
  });

  it('is idempotent: a sync interrupted after the server accepted a sale cannot double-count it', async () => {
    const { w, key, device } = await paired();
    await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    // The server accepts the sale but the response is lost on the way back.
    w.net.override = (path) => {
      if (path !== '/v1/sync') return undefined;
      throw new TypeError('fetch failed');
    };
    const real = w.fetchLike;
    // First attempt: really reaches the server, then the answer is lost.
    const lostAnswer: typeof fetch = async (input, init) => {
      const res = await globalThis.fetch(w.net.target! + String(input).slice(SITE.length), init);
      if (String(input).endsWith('/v1/sync')) throw new TypeError('connection reset');
      return res;
    };
    const flaky = await PosDevice.open({ store: (device as any).store, fetch: lostAnswer, baseUrl: SITE });
    await flaky.sync().catch(() => undefined);
    w.net.override = undefined;
    expect(((await w.api(key, 'GET', '/v1/payments')).body as any[]).length).toBe(1); // server did get it

    const report = await device.sync(); // the till retries the same sale
    expect(report.remaining).toBe(0);
    expect(((await w.api(key, 'GET', '/v1/payments')).body as any[]).length).toBe(1); // still exactly one payment
    void real;
  });

  it('keeps a sale queued when the server answers with something that is not a sync result (rate limit, outage)', async () => {
    const { w, device } = await paired();
    const sale = await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    w.net.override = (path) => (path === '/v1/sync' ? new Response(JSON.stringify({ error: 'Rate limit exceeded. Retry after 30s.' }), { status: 429, headers: { 'content-type': 'application/json' } }) : undefined);
    // The sale must stay queued, AND the cashier must be told why it is stuck.
    expect(await device.sync()).toMatchObject({ attempted: true, accepted: 0, rejected: 0, remaining: 1 });
    expect(device.error).toMatch(/Rate limit exceeded/);
    expect((await device.status()).queued).toBe(1);
    expect((await device.status()).lastError).toMatch(/Rate limit/);
    expect((await device.sales()).find((s) => s.id === sale.id)!.status).toBe('queued');

    w.net.override = (path) => (path === '/v1/sync' ? new Response('<html>Bad gateway</html>', { status: 502 }) : undefined);
    expect(await device.sync()).toMatchObject({ accepted: 0, remaining: 1 });
    expect(device.error).toMatch(/502/);
    expect((await device.status()).queued).toBe(1);

    w.net.override = undefined;
    expect(await device.sync()).toMatchObject({ accepted: 1, remaining: 0 });
  });

  it('works in "offline mode" even when the server is perfectly reachable, and sends nothing until it is switched off', async () => {
    const { w, device } = await paired();
    await device.setForceOffline(true);
    expect(device.online).toBe(false);
    const callsBefore = w.net.calls.length;
    const sale = await device.sell({ amount: '3000', assetKey: 'USDT_TRC20' });
    expect(sale.pricedOffline).toBe(true);
    expect(await device.sync()).toMatchObject({ attempted: false });
    expect(w.net.calls.length).toBe(callsBefore); // not a single request left the device
    await device.setForceOffline(false);
    expect(await device.sync()).toMatchObject({ accepted: 1 });
  });

  it('shows what the server refused, instead of dropping it', async () => {
    const { w, key, device } = await paired();
    const sale = await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    // Another merchant key cannot sync this device's sales: the server answers 403 with a rejection.
    const other = await w.merchant('Someone Else');
    (device as any).config.apiKey = other;
    const report = await device.sync();
    expect(report.rejected).toBe(1);
    const rejected = await device.rejectedSales();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe(sale.id);
    expect(rejected[0]!.reason).toMatch(/not registered/);
    void key;
  });
});

describe('address leases', () => {
  it('renews by itself when online, and the renewed addresses are accepted by the server', async () => {
    const w = await world();
    const key = await w.merchant();
    const device = await till(w);
    await device.pair({ apiKey: key, currency: 'NGN', leaseSize: 2 });
    const sales: Sale[] = [];
    for (let i = 0; i < 5; i++) sales.push(await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' }));
    expect(device.deviceConfig!.leases.length).toBeGreaterThan(1); // it asked for more
    expect(new Set(sales.map((s) => s.address)).size).toBe(5);
    // The part that matters: the server, which checks every address against the device's leases, took all five.
    expect(await device.sync()).toMatchObject({ accepted: 5, rejected: 0 });
  });

  it('tells the cashier plainly when it runs out of addresses with no connection', async () => {
    const w = await world();
    const device = await till(w);
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN', leaseSize: 1 });
    w.net.target = undefined;
    await device.probe();
    await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    await expect(device.sell({ amount: '1000', assetKey: 'USDT_TRC20' })).rejects.toThrow(/Connect to the internet/);
  });

  it('refresh() tops the lease up before it runs dry', async () => {
    const w = await world();
    const device = await till(w);
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN', leaseSize: 5 });
    expect(device.deviceConfig!.leases).toHaveLength(1);
    await device.refresh();
    expect(device.deviceConfig!.leases).toHaveLength(2);
  });
});

describe('rates', () => {
  it('refuses to sell on a rate that is too old, and says what to do', async () => {
    let now = Date.now();
    const w = await world();
    const device = await till(w, { clock: () => now });
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN' });
    w.net.target = undefined;
    await device.probe();
    await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' }); // fine now
    now += 7 * 3_600_000; // a working day later, still no connection
    await expect(device.sell({ amount: '1000', assetKey: 'USDT_TRC20' })).rejects.toThrow(/too old/);
    expect(device.rateIsStale('USDT/NGN')).toBe(true);
  });

  it('rejects a tampered rate snapshot from the server rather than selling on it', async () => {
    const w = await world();
    const key = await w.merchant();
    const device = await till(w);
    w.net.override = (path) => {
      if (!path.startsWith('/v1/rates/')) return undefined;
      return new Response(JSON.stringify({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT', quotes: [], rejected: [], aggregation: 'median', mid: '1', spreadBps: 0, effectiveRate: '1', createdAt: Date.now(), lockedUntil: Date.now() + 1000, hash: 'f'.repeat(64) }), { status: 200 });
    };
    await device.pair({ apiKey: key, currency: 'NGN' });
    expect(device.sellableKeys()).toEqual([]); // nothing priceable: every snapshot failed its integrity check
    await expect(device.sell({ amount: '1000', assetKey: 'USDT_TRC20' })).rejects.toThrow(/integrity check/);
  });
});

describe('safety rails', () => {
  it('rejects bad amounts before anything is created', async () => {
    const w = await world();
    const device = await till(w);
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN' });
    for (const amount of ['', 'abc', '-5', '0', '0.00', '12.345', '1e3']) {
      await expect(device.sell({ amount, assetKey: 'USDT_TRC20' }), amount).rejects.toThrow(/amount/i);
    }
    expect(await device.sales()).toHaveLength(0);
  });

  it('refuses to forget a device that holds sales no server has seen, unless explicitly told to discard them', async () => {
    const w = await world();
    const device = await till(w);
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN' });
    w.net.target = undefined;
    await device.probe();
    await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    await expect(device.forget()).rejects.toThrow(/not reached the server/);
    expect(device.paired).toBe(true);
    await device.forget({ discardUnsynced: true });
    expect(device.paired).toBe(false);
    expect(await device.sales()).toHaveLength(0);
  });

  it('forgets cleanly once everything is synced, leaving nothing behind', async () => {
    const w = await world();
    const store = new MemoryStore();
    const device = await till(w, { store });
    await device.pair({ apiKey: await w.merchant(), currency: 'NGN' });
    await device.sell({ amount: '1000', assetKey: 'USDT_TRC20' });
    await device.sync();
    await device.forget();
    expect(await store.keys('')).toEqual([]); // the API key is gone from the device too
  });

  it('distinguishes "cannot reach the server" from "the server said no"', async () => {
    const w = await world();
    const device = await till(w);
    w.net.target = undefined;
    await expect(device.pair({ apiKey: 'pk_x', currency: 'NGN' })).rejects.toBeInstanceOf(NetworkError);
  });
});
