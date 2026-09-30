import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@paycryt/core';
import { TronGridChainAdapter } from '@paycryt/adapters';

const ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // any valid-looking address; not a real deposit target in these tests
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

interface Call {
  url: string;
  headers?: Record<string, string>;
}

/** Fake fetch keyed by whether the URL asks for confirmed or unconfirmed transfers, using the real TronGrid response shape. */
function mockTronGrid(opts: { confirmed?: unknown[]; unconfirmed?: unknown[]; failConfirmed?: number; malformed?: boolean }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    if (url.includes('only_confirmed=true') && opts.failConfirmed) {
      return { ok: false, status: opts.failConfirmed, json: async () => ({}), text: async () => '' };
    }
    if (opts.malformed) return { ok: true, status: 200, json: async () => ({ success: false, error: 'invalid address' }), text: async () => '' };
    const data = url.includes('only_confirmed=true') ? (opts.confirmed ?? []) : (opts.unconfirmed ?? []);
    return { ok: true, status: 200, json: async () => ({ success: true, data }), text: async () => '' };
  };
  return { fetch, calls };
}

// Real record captured live from https://api.trongrid.io/v1/accounts/.../transactions/trc20 (2026-09-22).
const REAL_TRANSFER = {
  transaction_id: 'ecd042f6700b9294a340e22510301bbc5c4b7bf8de88b06ae012e6409465252b',
  token_info: { symbol: 'USDT', address: USDT_CONTRACT, decimals: 6, name: 'Tether USD' },
  block_timestamp: 1790043621000,
  from: 'TVJDXdgkgq348XGqwBCjfYJYQ6CNU21SCz',
  to: ADDRESS,
  type: 'Transfer',
  value: '705642',
};

describe('TronGridChainAdapter', () => {
  it('reports a solidified transfer at the configured confirmation weight', async () => {
    const { fetch, calls } = mockTronGrid({ confirmed: [REAL_TRANSFER] });
    const adapter = new TronGridChainAdapter({ fetch });
    const deposits = await adapter.getDeposits(ADDRESS, 'USDT');
    expect(deposits).toEqual([{ txId: REAL_TRANSFER.transaction_id, address: ADDRESS, assetSymbol: 'USDT', amount: 705_642n, confirmations: 20, receivedAt: 1790043621000 }]);
    expect(calls.some((c) => c.url.includes('contract_address=' + USDT_CONTRACT))).toBe(true);
    expect(calls.some((c) => c.url.includes('only_to=true'))).toBe(true);
  });

  it('reports an unconfirmed transfer with 0 confirmations, using a custom weight when solidified', async () => {
    const unconfirmedTx = { ...REAL_TRANSFER, transaction_id: 'pending1' };
    const { fetch } = mockTronGrid({ unconfirmed: [unconfirmedTx] });
    const adapter = new TronGridChainAdapter({ fetch, confirmedWeight: 5 });
    const deposits = await adapter.getDeposits(ADDRESS, 'USDT');
    expect(deposits).toEqual([{ txId: 'pending1', address: ADDRESS, assetSymbol: 'USDT', amount: 705_642n, confirmations: 0, receivedAt: 1790043621000 }]);
  });

  it('lets a solidified copy override the unconfirmed one for the same tx', async () => {
    const { fetch } = mockTronGrid({ confirmed: [REAL_TRANSFER], unconfirmed: [REAL_TRANSFER] });
    const adapter = new TronGridChainAdapter({ fetch });
    const deposits = await adapter.getDeposits(ADDRESS, 'USDT');
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.confirmations).toBe(20);
  });

  it('merges several distinct deposits (a split payment)', async () => {
    const a = { ...REAL_TRANSFER, transaction_id: 'tx_a', value: '100000' };
    const b = { ...REAL_TRANSFER, transaction_id: 'tx_b', value: '200000' };
    const { fetch } = mockTronGrid({ confirmed: [a], unconfirmed: [b] });
    const adapter = new TronGridChainAdapter({ fetch });
    const deposits = await adapter.getDeposits(ADDRESS, 'USDT');
    expect(deposits.map((d) => d.txId).sort()).toEqual(['tx_a', 'tx_b']);
    expect(deposits.reduce((sum, d) => sum + d.amount, 0n)).toBe(300_000n);
  });

  it('sends the TRON-PRO-API-KEY header when an API key is configured', async () => {
    const { fetch, calls } = mockTronGrid({ confirmed: [] });
    await new TronGridChainAdapter({ fetch, apiKey: 'my-key' }).getDeposits(ADDRESS, 'USDT');
    expect(calls.every((c) => c.headers?.['TRON-PRO-API-KEY'] === 'my-key')).toBe(true);
  });

  it('rejects an asset with no configured contract', async () => {
    const { fetch } = mockTronGrid({});
    await expect(new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'DOGE')).rejects.toThrow(/no TRC20 contract configured/);
  });

  it('surfaces HTTP and API errors instead of swallowing them', async () => {
    const httpFail = mockTronGrid({ failConfirmed: 500 });
    await expect(new TronGridChainAdapter({ fetch: httpFail.fetch }).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/HTTP 500/);

    const apiFail = mockTronGrid({ malformed: true });
    await expect(new TronGridChainAdapter({ fetch: apiFail.fetch }).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/invalid address/);
  });

  it('accepts a custom contract map for other TRC20 tokens', async () => {
    const other = { ...REAL_TRANSFER, transaction_id: 'tx_usdc', token_info: { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6, name: 'USD Coin' } };
    const { fetch, calls } = mockTronGrid({ confirmed: [other] });
    const adapter = new TronGridChainAdapter({ fetch, contracts: { USDC: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8' } });
    const deposits = await adapter.getDeposits(ADDRESS, 'USDC');
    expect(deposits).toHaveLength(1);
    expect(calls[0]!.url).toContain('TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Real block-based confirmations. Numbers below were captured from the live TronGrid API (2026-09-25): chain
// tip 86,558,576, a solidified USDT transfer in block 86,557,415, and the solidified height 19 blocks behind.
// ---------------------------------------------------------------------------------------------------------
const LIVE_TIP = 86_558_576;
const LIVE_TX_BLOCK = 86_557_415;

interface Mock2Opts {
  confirmed?: unknown[];
  unconfirmed?: unknown[];
  tip?: number;
  blocks?: Record<string, number>;
  failTip?: boolean;
  failInfoFor?: string[];
}

function mockTron2(o: Mock2Opts) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method, headers: init?.headers, body });
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
    if (url.endsWith('/wallet/getnowblock')) {
      if (o.failTip) return { ok: false, status: 429, json: async () => ({}), text: async () => '' };
      return ok(o.tip === undefined ? {} : { block_header: { raw_data: { number: o.tip } } });
    }
    if (url.endsWith('/wallet/gettransactioninfobyid')) {
      if (o.failInfoFor?.includes(body.value)) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      const block = o.blocks?.[body.value];
      return ok(block === undefined ? {} : { id: body.value, blockNumber: block }); // {} means not in a block yet
    }
    const list = url.includes('only_confirmed=true') ? (o.confirmed ?? []) : (o.unconfirmed ?? []);
    return ok({ success: true, data: list });
  };
  const infoCalls = () => calls.filter((c) => c.url.endsWith('/wallet/gettransactioninfobyid'));
  const tipCalls = () => calls.filter((c) => c.url.endsWith('/wallet/getnowblock'));
  return { fetch, calls, infoCalls, tipCalls };
}

const tx = (id: string, value = '1000000') => ({ ...REAL_TRANSFER, transaction_id: id, value });

describe('TronGridChainAdapter: real confirmations', () => {
  it('reports tip - block + 1 for a solidified transfer, as captured live', async () => {
    const t = tx('a'.repeat(64));
    const { fetch } = mockTron2({ confirmed: [t], tip: LIVE_TIP, blocks: { [t.transaction_id]: LIVE_TX_BLOCK } });
    const [d] = await new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT');
    expect(d!.confirmations).toBe(LIVE_TIP - LIVE_TX_BLOCK + 1);
    expect(d!.confirmations).toBe(1162);
  });

  it('gives an unconfirmed transfer already in a block its real, small count, and 0 if it is not in a block yet', async () => {
    const inBlock = tx('b'.repeat(64));
    const inMempool = tx('c'.repeat(64));
    const { fetch } = mockTron2({ unconfirmed: [inBlock, inMempool], tip: LIVE_TIP, blocks: { [inBlock.transaction_id]: LIVE_TIP - 4 } });
    const deposits = await new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT');
    const by = Object.fromEntries(deposits.map((d) => [d.txId, d.confirmations]));
    expect(by[inBlock.transaction_id]).toBe(5); // 4 blocks after its own, still short of solidified
    expect(by[inMempool.transaction_id]).toBe(0);
  });

  it('a policy needing more confirmations than a young transfer has correctly does not accept it yet', async () => {
    const t = tx('d'.repeat(64));
    const { fetch } = mockTron2({ unconfirmed: [t], tip: LIVE_TIP, blocks: { [t.transaction_id]: LIVE_TIP - 9 } });
    const [d] = await new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT');
    expect(d!.confirmations).toBe(10); // a policy asking for 12 waits
  });

  it('falls back safely when the tip cannot be read: solidified keeps the weight, unconfirmed stays 0', async () => {
    const s = tx('e'.repeat(64));
    const u = tx('f'.repeat(64));
    const { fetch } = mockTron2({ confirmed: [s], unconfirmed: [u], failTip: true, blocks: { [s.transaction_id]: LIVE_TX_BLOCK, [u.transaction_id]: LIVE_TIP } });
    const deposits = await new TronGridChainAdapter({ fetch, confirmedWeight: 33 }).getDeposits(ADDRESS, 'USDT');
    const by = Object.fromEntries(deposits.map((d) => [d.txId, d.confirmations]));
    expect(by[s.transaction_id]).toBe(33);
    expect(by[u.transaction_id]).toBe(0);
  });

  it('a failed block lookup for one transfer falls back for that one only, without failing the check', async () => {
    const good = tx('1'.repeat(64));
    const bad = tx('2'.repeat(64));
    const { fetch } = mockTron2({
      confirmed: [good, bad],
      tip: LIVE_TIP,
      blocks: { [good.transaction_id]: LIVE_TX_BLOCK, [bad.transaction_id]: LIVE_TX_BLOCK },
      failInfoFor: [bad.transaction_id],
    });
    const deposits = await new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT');
    const by = Object.fromEntries(deposits.map((d) => [d.txId, d.confirmations]));
    expect(by[good.transaction_id]).toBe(1162);
    expect(by[bad.transaction_id]).toBe(20); // the default fallback weight
  });

  it('never reports a solidified transfer below 1, even if the node is behind the transfer', async () => {
    const t = tx('3'.repeat(64));
    const { fetch } = mockTron2({ confirmed: [t], tip: LIVE_TX_BLOCK - 2, blocks: { [t.transaction_id]: LIVE_TX_BLOCK } });
    const [d] = await new TronGridChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT');
    expect(d!.confirmations).toBe(1);
  });

  it('makes no tip or block calls when there is nothing to report', async () => {
    const m = mockTron2({});
    expect(await new TronGridChainAdapter({ fetch: m.fetch }).getDeposits(ADDRESS, 'USDT')).toEqual([]);
    expect(m.tipCalls()).toHaveLength(0);
    expect(m.infoCalls()).toHaveLength(0);
    expect(m.calls).toHaveLength(2); // just the confirmed and unconfirmed lists
  });

  it('looks each solidified block up once and remembers it, but never caches an unconfirmed one', async () => {
    const s = tx('4'.repeat(64));
    const u = tx('5'.repeat(64));
    const m = mockTron2({ confirmed: [s], unconfirmed: [u], tip: LIVE_TIP, blocks: { [s.transaction_id]: LIVE_TX_BLOCK, [u.transaction_id]: LIVE_TIP - 1 } });
    const adapter = new TronGridChainAdapter({ fetch: m.fetch });
    await adapter.getDeposits(ADDRESS, 'USDT');
    await adapter.getDeposits(ADDRESS, 'USDT');
    const looked = m.infoCalls().map((c) => c.body.value);
    expect(looked.filter((id) => id === s.transaction_id)).toHaveLength(1); // solidified: once
    expect(looked.filter((id) => id === u.transaction_id)).toHaveLength(2); // unconfirmed: fresh every time, it can still reorg
  });

  it('reuses the chain tip within the cache window and refreshes it after', async () => {
    let now = 1_000_000;
    const t = tx('6'.repeat(64));
    const m = mockTron2({ confirmed: [t], tip: LIVE_TIP, blocks: { [t.transaction_id]: LIVE_TX_BLOCK } });
    const adapter = new TronGridChainAdapter({ fetch: m.fetch, clock: () => now, tipCacheMs: 3000 });
    await adapter.getDeposits(ADDRESS, 'USDT');
    now += 2_000;
    await adapter.getDeposits(ADDRESS, 'USDT');
    expect(m.tipCalls()).toHaveLength(1);
    now += 2_000; // 4s since the first read: stale
    await adapter.getDeposits(ADDRESS, 'USDT');
    expect(m.tipCalls()).toHaveLength(2);
  });

  it('forgets the oldest remembered blocks once the cache is full', async () => {
    const [a, b, c] = ['7', '8', '9'].map((ch) => tx(ch.repeat(64)));
    const blocks = { [a!.transaction_id]: 1, [b!.transaction_id]: 2, [c!.transaction_id]: 3 };
    const m = mockTron2({ confirmed: [a, b, c], tip: LIVE_TIP, blocks });
    const adapter = new TronGridChainAdapter({ fetch: m.fetch, blockCacheSize: 2 });
    await adapter.getDeposits(ADDRESS, 'USDT');
    expect(m.infoCalls()).toHaveLength(3);
    await adapter.getDeposits(ADDRESS, 'USDT');
    expect(m.infoCalls()).toHaveLength(4); // only the evicted one was looked up again
  });

  it('posts the txid to gettransactioninfobyid and sends the API key on every call', async () => {
    const t = tx('0'.repeat(64));
    const m = mockTron2({ confirmed: [t], tip: LIVE_TIP, blocks: { [t.transaction_id]: LIVE_TX_BLOCK } });
    await new TronGridChainAdapter({ fetch: m.fetch, apiKey: 'k1' }).getDeposits(ADDRESS, 'USDT');
    const info = m.infoCalls()[0]!;
    expect(info.method).toBe('POST');
    expect(info.body).toEqual({ value: t.transaction_id });
    expect(m.calls.every((c) => c.headers?.['TRON-PRO-API-KEY'] === 'k1')).toBe(true);
  });
});
