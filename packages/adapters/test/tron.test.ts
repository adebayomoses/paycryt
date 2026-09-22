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
