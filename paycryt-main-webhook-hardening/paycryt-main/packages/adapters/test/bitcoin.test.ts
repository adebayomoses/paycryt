import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@paycryt/core';
import { EsploraChainAdapter } from '@paycryt/adapters';

const ADDRESS = 'bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te';
const OTHER_ADDRESS = 'bc1qp533522veg9uyhpx3sva9vqrnfzmt262n4lsuq';
const TIP_HEIGHT = 968106; // live tip height at verification time (2026-09-22)

// Shaped exactly like the live response from https://blockstream.info/api/address/:address/txs (verified live,
// including the "several outputs to the same address in one tx must be summed" case — real addresses do this).
function confirmedTx(overrides: Partial<{ txid: string; blockHeight: number; blockTime: number; sats: number[] }> = {}) {
  const sats = overrides.sats ?? [50_000];
  return {
    txid: overrides.txid ?? 'a'.repeat(64),
    vout: sats.map((value) => ({ scriptpubkey_address: ADDRESS, value })),
    status: { confirmed: true, block_height: overrides.blockHeight ?? 968_100, block_time: overrides.blockTime ?? 1_790_040_985 },
  };
}
function unconfirmedTx(txid: string, sats = 50_000) {
  return { txid, vout: [{ scriptpubkey_address: ADDRESS, value: sats }], status: { confirmed: false } };
}

function mockEsplora(txs: unknown[], opts: { tipHeight?: number; failTip?: number; failTxs?: number } = {}) {
  const fetch: FetchLike = async (url) => {
    if (url.includes('/blocks/tip/height')) {
      if (opts.failTip) return { ok: false, status: opts.failTip, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, text: async () => String(opts.tipHeight ?? TIP_HEIGHT), json: async () => opts.tipHeight ?? TIP_HEIGHT };
    }
    if (url.includes('/txs')) {
      if (opts.failTxs) return { ok: false, status: opts.failTxs, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => txs, text: async () => JSON.stringify(txs) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return fetch;
}

describe('EsploraChainAdapter', () => {
  it('parses a confirmed deposit with real block-based confirmations', async () => {
    const fetch = mockEsplora([confirmedTx({ txid: 'b'.repeat(64), blockHeight: 968_100, sats: [50_000] })]);
    const adapter = new EsploraChainAdapter({ fetch });
    const deposits = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(deposits).toEqual([
      { txId: 'b'.repeat(64), address: ADDRESS, assetSymbol: 'BTC', amount: 50_000n, confirmations: TIP_HEIGHT - 968_100 + 1, receivedAt: 1_790_040_985_000 },
    ]);
  });

  it('sums several outputs to the same address in one transaction', async () => {
    const fetch = mockEsplora([confirmedTx({ txid: 'c'.repeat(64), sats: [546, 546, 546, 8_362] })]);
    const adapter = new EsploraChainAdapter({ fetch });
    const deposits = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.amount).toBe(10_000n);
  });

  it('ignores outputs paid to a different address', async () => {
    const tx = { txid: 'd'.repeat(64), vout: [{ scriptpubkey_address: OTHER_ADDRESS, value: 1_000 }], status: { confirmed: true, block_height: 968_100, block_time: 1_790_040_985 } };
    const fetch = mockEsplora([tx]);
    const deposits = await new EsploraChainAdapter({ fetch }).getDeposits(ADDRESS, 'BTC');
    expect(deposits).toEqual([]);
  });

  it('reports an unconfirmed deposit at 0 confirmations, estimating receivedAt as first-seen', async () => {
    let now = 1_000_000;
    const fetch = mockEsplora([unconfirmedTx('e'.repeat(64))]);
    const adapter = new EsploraChainAdapter({ fetch, clock: () => now });
    const deposits = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(deposits).toEqual([{ txId: 'e'.repeat(64), address: ADDRESS, assetSymbol: 'BTC', amount: 50_000n, confirmations: 0, receivedAt: 1_000_000 }]);
  });

  it('keeps the same first-seen estimate across polls while still unconfirmed, instead of drifting forward', async () => {
    let now = 1_000_000;
    const fetch = mockEsplora([unconfirmedTx('f'.repeat(64))]);
    const adapter = new EsploraChainAdapter({ fetch, clock: () => now });
    const first = await adapter.getDeposits(ADDRESS, 'BTC');
    now = 5_000_000; // time passes, still unconfirmed
    const second = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(first[0]!.receivedAt).toBe(1_000_000);
    expect(second[0]!.receivedAt).toBe(1_000_000); // not 5,000,000 — the estimate doesn't drift
  });

  it('switches to the real on-chain timestamp once a previously-unconfirmed deposit confirms', async () => {
    let now = 1_000_000;
    const txid = 'g'.repeat(64);
    let confirmed = false;
    const fetch: FetchLike = async (url) => {
      if (url.includes('tip/height')) return { ok: true, status: 200, text: async () => String(TIP_HEIGHT), json: async () => TIP_HEIGHT };
      const tx = confirmed ? confirmedTx({ txid, blockHeight: 968_100, blockTime: 1_790_040_985, sats: [50_000] }) : unconfirmedTx(txid);
      return { ok: true, status: 200, json: async () => [tx], text: async () => '' };
    };
    const adapter = new EsploraChainAdapter({ fetch, clock: () => now });
    const before = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(before[0]).toMatchObject({ confirmations: 0, receivedAt: 1_000_000 });

    confirmed = true;
    now = 9_999_999; // irrelevant now that it's confirmed
    const after = await adapter.getDeposits(ADDRESS, 'BTC');
    expect(after[0]).toMatchObject({ confirmations: TIP_HEIGHT - 968_100 + 1, receivedAt: 1_790_040_985_000 });
  });

  it('rejects any asset symbol other than BTC', async () => {
    const fetch = mockEsplora([]);
    await expect(new EsploraChainAdapter({ fetch }).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/only watches BTC/);
  });

  it('surfaces HTTP errors from either endpoint instead of swallowing them', async () => {
    const tipFail = mockEsplora([], { failTip: 503 });
    await expect(new EsploraChainAdapter({ fetch: tipFail }).getDeposits(ADDRESS, 'BTC')).rejects.toThrow(/tip-height.*503/);

    const txsFail = mockEsplora([], { failTxs: 500 });
    await expect(new EsploraChainAdapter({ fetch: txsFail }).getDeposits(ADDRESS, 'BTC')).rejects.toThrow(/address-history.*500/);
  });

  it('supports a custom baseUrl for self-hosted Esplora / mempool.space instances', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      seen.push(url);
      if (url.includes('tip/height')) return { ok: true, status: 200, text: async () => String(TIP_HEIGHT), json: async () => TIP_HEIGHT };
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    await new EsploraChainAdapter({ fetch, baseUrl: 'https://my-esplora.example.com/api' }).getDeposits(ADDRESS, 'BTC');
    expect(seen.every((u) => u.startsWith('https://my-esplora.example.com/api'))).toBe(true);
  });
});
