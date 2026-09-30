import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSETS,
  EvmXpubDeriver,
  FakeChain,
  MemoryStore,
  OfflinePOS,
  StaticRateProvider,
  evmAccountXpub,
  toJson,
  type RateSnapshot,
  type SyncOp,
  type SyncResponse,
} from '@paycryt/core';
import { PaycrytServer } from '@paycryt/server';
import { liveOptions } from './live-helpers.js';

const DEV = 'test test test test test test test test test test test junk';
const XPUB = evmAccountXpub(DEV);
const evm = new EvmXpubDeriver(XPUB);
const ADMIN = 'admin_key';
const PAY = { amount: '15000', currency: 'NGN', asset: 'USDT_ERC20' };

const running: PaycrytServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function boot(extra: Record<string, unknown> = {}, opts: Parameters<typeof liveOptions>[0] = {}) {
  const live = liveOptions(opts);
  const server = await PaycrytServer.create({ apiKey: ADMIN, ...live, ...extra } as never);
  running.push(server);
  const url = `http://127.0.0.1:${await server.listen(0)}`;
  const chain = (name: string) => live.chains.find((c) => c.chain === name)!;
  return { server, url, chain, live };
}

async function call(url: string, key: string | undefined, method: string, path: string, body?: unknown) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function merchant(url: string, wallets: Record<string, string> | null = { evm: XPUB }) {
  const r = await call(url, ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada', ...(wallets ? { wallets } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.merchant.id as string, key: r.body.apiKey as string };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

describe('a live server refuses to run on made-up chains or prices', () => {
  const bad = (cfg: Record<string, unknown>) => PaycrytServer.create({ apiKey: ADMIN, ...cfg } as never);

  it('needs real chains and real rate sources', async () => {
    await expect(bad({ sandbox: false })).rejects.toThrow(/Live mode .* needs `chains`.*`rateProviders`/);
    await expect(bad({})).rejects.toThrow(/Live mode/); // sandbox is opt-in, so leaving it out is live
    const { chains, rateProviders } = liveOptions();
    await expect(bad({ sandbox: false, chains })).rejects.toThrow(/Live mode/);
    await expect(bad({ sandbox: false, rateProviders })).rejects.toThrow(/Live mode/);
    await expect(bad({ sandbox: false, chains: [], rateProviders })).rejects.toThrow(/Live mode/);
  });

  it('does not let the sandbox be mixed with real chains or rates', async () => {
    const { chains, rateProviders } = liveOptions();
    await expect(bad({ sandbox: true, chains })).rejects.toThrow(/Sandbox mode uses its own fake chains/);
    await expect(bad({ sandbox: true, rateProviders })).rejects.toThrow(/Sandbox mode uses its own fake chains/);
  });

  it('rejects two adapters for the same chain', async () => {
    const { rateProviders } = liveOptions();
    await expect(bad({ sandbox: false, rateProviders, chains: [new FakeChain('tron'), new FakeChain('tron')] })).rejects.toThrow(/Two chain adapters/);
  });

  it('reports itself as live, and the simulator does not exist', async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/health`).then((r) => r.json())) as any).toMatchObject({ ok: true, sandbox: false, mode: 'live' });
    expect((await call(url, ADMIN, 'POST', '/v1/sandbox/time', { advanceMs: 1 })).status).toBe(404);
    expect((await call(url, ADMIN, 'POST', '/v1/sandbox/deposit', { paymentId: 'x' })).status).toBe(404);
  });

  it('only accepts payments on the chains it was given', async () => {
    const { url } = await boot({}, { chains: [new FakeChain('ethereum')] });
    const m = await merchant(url, { evm: XPUB });
    expect((await call(url, m.key, 'POST', '/v1/payments', PAY)).status).toBe(201);
    const other = await call(url, m.key, 'POST', '/v1/payments', { ...PAY, asset: 'USDT_BEP20' }); // bsc: no adapter configured
    expect(other.status).toBe(400);
    expect(other.body.error).toContain('No chain adapter for bsc');
  });
});

describe('a live payment is created on a real address and detected by polling alone', () => {
  it('derives the merchant address, then settles when the chain shows the deposit (no manual ticks)', async () => {
    const { url, chain } = await boot();
    const m = await merchant(url);
    const p = (await call(url, m.key, 'POST', '/v1/payments', PAY)).body;
    expect(p.address).toBe(evm.derive(0));
    expect(p.status).toBe('awaiting_payment');

    // The customer pays on the (fake) chain. Nothing calls tick(): only the server's own timer can notice.
    chain('ethereum').scenarios.exact({ ...p, amountDue: BigInt(p.amountDue), asset: ASSETS.USDT_ERC20 } as never);
    expect(await until(async () => (await call(url, m.key, 'GET', `/v1/payments/${p.id}`)).body.status === 'paid')).toBe(true);

    const events = (await call(url, m.key, 'GET', '/v1/events')).body;
    expect(events.map((e: any) => e.type)).toEqual(['payment.confirmed']);
  });

  it('the admin key cannot create live payments, since it has no wallet to pay into', async () => {
    const { url } = await boot();
    const r = await call(url, ADMIN, 'POST', '/v1/payments', PAY);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('merchant API key');
  });

  it('a merchant with no wallet for the chain cannot take live payments', async () => {
    const { url } = await boot();
    const bare = await merchant(url, null);
    expect((await call(url, bare.key, 'POST', '/v1/payments', PAY)).status).toBe(400);
  });

  it('is served by the injected rate sources, and the audit trail names them', async () => {
    const cheap = await boot({ spreadBps: 0 }, { prices: { 'USDT/NGN': '1000' } });
    const dear = await boot({ spreadBps: 0 }, { prices: { 'USDT/NGN': '2000' } });
    const a = await merchant(cheap.url);
    const b = await merchant(dear.url);
    const pa = (await call(cheap.url, a.key, 'POST', '/v1/payments', PAY)).body;
    const pb = (await call(dear.url, b.key, 'POST', '/v1/payments', PAY)).body;
    expect(BigInt(pa.amountDue)).toBe(15_000_000n); // NGN 15,000 at 1,000 = 15 USDT
    expect(BigInt(pb.amountDue)).toBe(7_500_000n);
    const snap = (await call(cheap.url, a.key, 'GET', `/v1/audit/rates/${pa.rateSnapshotHash}`)).body as RateSnapshot;
    expect(snap.quotes.map((q) => q.source).sort()).toEqual(['feed-a', 'feed-b']);
  });
});

describe('when the outside world misbehaves', () => {
  it('answers 503, not a crash or a made-up price, when no exchange rate can be produced', async () => {
    const down = { name: 'down', getRate: async () => { throw new Error('HTTP 503 from the exchange'); } };
    const live = liveOptions();
    const { url } = await boot({ rateProviders: [down] }, { chains: live.chains });
    const m = await merchant(url);
    const r = await call(url, m.key, 'POST', '/v1/payments', PAY);
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('No exchange rate available');
    expect((await call(url, m.key, 'GET', '/v1/rates/USDT-NGN')).status).toBe(503);
    expect((await call(url, m.key, 'GET', '/v1/payments')).body).toEqual([]); // nothing half-created
  });

  it('refuses to price from two sources that disagree, saying what they quoted, unless the operator widens the tolerance', async () => {
    const live = liveOptions();
    const feeds = [new StaticRateProvider('coingecko', { 'USDT/NGN': '1326.17' }), new StaticRateProvider('binance', { 'USDT/NGN': '1518.4' })];
    const strict = await boot({ rateProviders: feeds }, { chains: live.chains });
    const a = await merchant(strict.url);
    const refused = await call(strict.url, a.key, 'POST', '/v1/payments', PAY);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toContain('coingecko 1326.17');
    expect(refused.body.error).toContain('binance 1518.4');

    const loose = await boot({ rateProviders: feeds, maxRateDeviationBps: 1000 }, { chains: liveOptions().chains });
    const b = await merchant(loose.url);
    expect((await call(loose.url, b.key, 'POST', '/v1/payments', PAY)).status).toBe(201);
  });

  it('answers 503 and hands out no address if it cannot check whether the address is unused', async () => {
    class Down extends FakeChain {
      override async getDeposits(): Promise<never> {
        throw new Error('HTTP 429');
      }
    }
    const { url } = await boot({}, { chains: [new Down('ethereum')] });
    const m = await merchant(url);
    const r = await call(url, m.key, 'POST', '/v1/payments', PAY);
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('Could not confirm that the deposit address is unused');
    expect((await call(url, m.key, 'GET', '/v1/payments')).body).toEqual([]);
  });

  it('one chain failing does not stop payments on another, and the operator can see it', async () => {
    class Flaky extends FakeChain {
      fail = false;
      override async getDeposits(a: string, s: string) {
        if (this.fail) throw new Error('HTTP 429 from TronGrid');
        return super.getDeposits(a, s);
      }
    }
    const tron = new Flaky('tron');
    const eth = new FakeChain('ethereum');
    const { url } = await boot({}, { chains: [tron, eth] });
    const m = await merchant(url, { evm: XPUB, tron: (await import('@paycryt/core')).tronAccountXpub(DEV) });

    const onTron = (await call(url, m.key, 'POST', '/v1/payments', { ...PAY, asset: 'USDT_TRC20' })).body;
    const onEth = (await call(url, m.key, 'POST', '/v1/payments', PAY)).body;
    tron.fail = true; // TronGrid starts rate-limiting us
    eth.scenarios.exact({ ...onEth, amountDue: BigInt(onEth.amountDue), asset: ASSETS.USDT_ERC20 } as never);

    expect(await until(async () => (await call(url, m.key, 'GET', `/v1/payments/${onEth.id}`)).body.status === 'paid')).toBe(true); // Ethereum unaffected
    const status = (await call(url, ADMIN, 'GET', '/v1/status')).body;
    expect(status.chainErrors.map((e: any) => e.paymentId)).toEqual([onTron.id]);
    expect(status.chainErrors[0]).toMatchObject({ chain: 'tron' });
    expect(status.chainErrors[0].message).toContain('429');

    tron.fail = false; // recovered
    expect(await until(async () => (await call(url, ADMIN, 'GET', '/v1/status')).body.chainErrors.length === 0)).toBe(true);
  });

  it('slow chain lookups never pile up: polls do not overlap even when the chain is slower than the poll interval', async () => {
    class Slow extends FakeChain {
      inFlight = 0;
      maxInFlight = 0;
      override async getDeposits(a: string, s: string) {
        this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
        await new Promise((r) => setTimeout(r, 70)); // 3.5x slower than the 20ms poll interval
        this.inFlight--;
        return super.getDeposits(a, s);
      }
    }
    const eth = new Slow('ethereum');
    const { url } = await boot({}, { chains: [eth] });
    const m = await merchant(url);
    const p = (await call(url, m.key, 'POST', '/v1/payments', PAY)).body;
    eth.scenarios.exact({ ...p, amountDue: BigInt(p.amountDue), asset: ASSETS.USDT_ERC20 } as never);
    expect(await until(async () => (await call(url, m.key, 'GET', `/v1/payments/${p.id}`)).body.status === 'paid')).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // many more polls happen
    expect(eth.maxInFlight).toBe(1); // never two lookups of the slow chain at once, however fast the timer fires
    expect((await call(url, m.key, 'GET', '/v1/events')).body).toHaveLength(1);
  });
});

describe('funds that were already on the address never pay a new request', () => {
  const dep = (chain: FakeChain, address: string, at = Date.now()) =>
    chain.simulateDeposit({ address, assetSymbol: 'USDT', amount: 20_000_000n, confirmations: 50, at });

  it('skips addresses that already have funds, so an imported wallet with history is safe', async () => {
    const eth = new FakeChain('ethereum');
    dep(eth, evm.derive(0), Date.now() - 30 * 86_400_000);
    dep(eth, evm.derive(1), Date.now() - 60_000); // even a very recent deposit
    const { url } = await boot({}, { chains: [eth] });
    const m = await merchant(url);
    const p = (await call(url, m.key, 'POST', '/v1/payments', PAY)).body;
    expect(p.address).toBe(evm.derive(2)); // the first two are used, so it moves on
    expect(p.status).toBe('awaiting_payment'); // not paid by someone else's old money
    await new Promise((r) => setTimeout(r, 120));
    expect((await call(url, m.key, 'GET', `/v1/payments/${p.id}`)).body.status).toBe('awaiting_payment');
  });

  it('gives up with a clear error when a whole run of addresses is used', async () => {
    const eth = new FakeChain('ethereum');
    for (let i = 0; i < 20; i++) dep(eth, evm.derive(i));
    const { url } = await boot({}, { chains: [eth] });
    const m = await merchant(url);
    const r = await call(url, m.key, 'POST', '/v1/payments', PAY);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('already have funds');
  });

  it('an offline request cannot be paid by old funds either, but a real payment to it still counts', async () => {
    const eth = new FakeChain('ethereum');
    const { url } = await boot({}, { chains: [eth] });
    const m = await merchant(url);
    const lease = (await call(url, m.key, 'POST', '/v1/leases', { deviceId: 'till-a', size: 20 })).body;
    const rate = (await call(url, m.key, 'GET', '/v1/rates/USDT-NGN')).body as RateSnapshot;
    const pos = new OfflinePOS({ deviceId: 'till-a', deriver: evm, lease, store: new MemoryStore() });
    await pos.cacheSnapshot(rate);
    const { request } = await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 1_500_000n }, asset: ASSETS.USDT_ERC20 });

    dep(eth, request.address, Date.now() - 30 * 86_400_000); // a month-old payment to this (reused) address
    const summary = await pos.sync({ push: async (op: SyncOp) => (await call(url, m.key, 'POST', '/v1/sync', toJson(op))).body as SyncResponse });
    expect(summary.accepted).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect((await call(url, m.key, 'GET', `/v1/payments/${request.id}`)).body.status).toBe('awaiting_payment'); // old money ignored

    eth.scenarios.exact(request); // the customer actually pays
    expect(await until(async () => (await call(url, m.key, 'GET', `/v1/payments/${request.id}`)).body.status === 'paid')).toBe(true);
  });

  it('admin-owned devices cannot sneak fake addresses into a live server', async () => {
    const { url } = await boot();
    const lease = (await call(url, ADMIN, 'POST', '/v1/leases', { deviceId: 'ops-till', size: 10 })).body;
    const rate = (await call(url, ADMIN, 'GET', '/v1/rates/USDT-NGN')).body as RateSnapshot;
    const pos = new OfflinePOS({ deviceId: 'ops-till', deriver: new FakeChain('sandbox'), lease, store: new MemoryStore() });
    await pos.cacheSnapshot(rate);
    await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 1_500_000n }, asset: ASSETS.USDT_ERC20 });
    const summary = await pos.sync({ push: async (op: SyncOp) => (await call(url, ADMIN, 'POST', '/v1/sync', toJson(op))).body as SyncResponse });
    expect(summary.rejected).toBe(1);
    expect((await pos.rejected())[0]!.reason).toContain('no wallet is configured');
  });
});

describe('operator status', () => {
  it('is admin-only and reports mode, chains, rate sources, poll health and payment counts', async () => {
    const { url } = await boot();
    const m = await merchant(url);
    await call(url, m.key, 'POST', '/v1/payments', PAY);
    expect((await call(url, m.key, 'GET', '/v1/status')).status).toBe(403);
    expect((await call(url, undefined, 'GET', '/v1/status')).status).toBe(401);

    expect(await until(async () => (await call(url, ADMIN, 'GET', '/v1/status')).body.lastPoll !== null)).toBe(true);
    const s = (await call(url, ADMIN, 'GET', '/v1/status')).body;
    expect(s).toMatchObject({ mode: 'live', pollIntervalMs: 20, payments: { total: 1, byStatus: { awaiting_payment: 1 } }, chainErrors: [] });
    expect(s.chains.sort()).toEqual(['base', 'bitcoin', 'bsc', 'ethereum', 'tron']);
    expect(s.rateSources).toEqual(['feed-a', 'feed-b']);
    expect(s.lastPoll.tookMs).toBeGreaterThanOrEqual(0);
  });
});

describe('a live server restarts without losing track of money', () => {
  it('reloads open payments and still notices the customer paying afterwards', async () => {
    const store = new MemoryStore();
    const eth = new FakeChain('ethereum'); // stands in for the blockchain, which outlives our process
    const first = await boot({ store }, { chains: [eth] });
    const m = await merchant(first.url);
    const p = (await call(first.url, m.key, 'POST', '/v1/payments', PAY)).body;
    await first.server.close();

    // The customer pays while our server is down.
    eth.scenarios.exact({ ...p, amountDue: BigInt(p.amountDue), asset: ASSETS.USDT_ERC20 } as never);

    const second = await boot({ store }, { chains: [eth] });
    expect(await until(async () => (await call(second.url, m.key, 'GET', `/v1/payments/${p.id}`)).body.status === 'paid')).toBe(true);
    // and the next payment does not reuse the first one's address
    const next = (await call(second.url, m.key, 'POST', '/v1/payments', PAY)).body;
    expect(next.address).toBe(evm.derive(1));
  });
});
