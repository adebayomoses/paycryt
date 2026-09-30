import { describe, expect, it } from 'vitest';
import { BinanceRateProvider, CoinGeckoRateProvider, EsploraChainAdapter, EvmRpcChainAdapter, TronGridChainAdapter } from '@paycryt/adapters';
import type { FetchLike } from '@paycryt/core';
import { buildLiveConfig } from '@paycryt/server';

/** Records every request, and answers just enough for each adapter to complete a check of an empty address. */
function recorder() {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const ok = (json: unknown, text = '') => ({ ok: true, status: 200, json: async () => json, text: async () => text });
    if (url.includes('/blocks/tip/height')) return ok(1, '900000');
    if (url.includes('/address/') && url.endsWith('/txs')) return ok([]);
    if (init?.body && url.includes('rpc')) {
      const body = JSON.parse(init.body);
      return ok({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_blockNumber' ? '0x100' : [] });
    }
    return ok({ success: true, data: [] });
  };
  return { fetch, calls };
}

const build = (env: Record<string, string>) => buildLiveConfig(env, recorder().fetch);
const ETH = 'https://eth-mainnet.rpc.example/v2/SECRET_API_KEY_IN_PATH';

describe('buildLiveConfig validates everything at startup, naming the variable to fix', () => {
  it('requires PAYCRYT_CHAINS and rejects unknown chains', () => {
    expect(() => build({})).toThrow(/PAYCRYT_CHAINS is required/);
    expect(() => build({ PAYCRYT_CHAINS: ' , ' })).toThrow(/PAYCRYT_CHAINS is required/);
    expect(() => build({ PAYCRYT_CHAINS: 'tron,solana' })).toThrow(/unknown chain\(s\): solana/);
  });

  it('requires an RPC URL for each EVM chain, and says which one', () => {
    expect(() => build({ PAYCRYT_CHAINS: 'ethereum' })).toThrow(/ETHEREUM_RPC_URL is required/);
    expect(() => build({ PAYCRYT_CHAINS: 'tron,base' })).toThrow(/BASE_RPC_URL is required/);
    expect(() => build({ PAYCRYT_CHAINS: 'bsc' })).toThrow(/BSC_RPC_URL is required/);
  });

  it('rejects malformed and non-http URLs', () => {
    expect(() => build({ PAYCRYT_CHAINS: 'ethereum', ETHEREUM_RPC_URL: 'not a url' })).toThrow(/ETHEREUM_RPC_URL must be a valid URL/);
    expect(() => build({ PAYCRYT_CHAINS: 'ethereum', ETHEREUM_RPC_URL: 'ftp://x.example' })).toThrow(/http\(s\)/);
    expect(() => build({ PAYCRYT_CHAINS: 'tron', TRONGRID_URL: 'javascript:alert(1)' })).toThrow(/TRONGRID_URL/);
    expect(() => build({ PAYCRYT_CHAINS: 'bitcoin', ESPLORA_URL: 'nope' })).toThrow(/ESPLORA_URL/);
  });

  it('validates rate sources and the minimum', () => {
    const base = { PAYCRYT_CHAINS: 'bitcoin' };
    expect(() => build({ ...base, PAYCRYT_RATE_SOURCES: 'kraken' })).toThrow(/unknown source\(s\): kraken/);
    expect(() => build({ ...base, PAYCRYT_RATE_SOURCES: ',' })).toThrow(/PAYCRYT_RATE_SOURCES is empty/);
    expect(() => build({ ...base, PAYCRYT_MIN_RATE_SOURCES: '2' })).toThrow(/from 1 to 1/); // only coingecko configured
    expect(() => build({ ...base, PAYCRYT_RATE_SOURCES: 'coingecko,binance', PAYCRYT_MIN_RATE_SOURCES: '0' })).toThrow(/PAYCRYT_MIN_RATE_SOURCES/);
    expect(() => build({ ...base, PAYCRYT_RATE_SOURCES: 'coingecko,binance', PAYCRYT_MIN_RATE_SOURCES: 'two' })).toThrow(/PAYCRYT_MIN_RATE_SOURCES/);
    for (const bad of ['0', '5001', '3.5', 'lots']) {
      expect(() => build({ ...base, PAYCRYT_MAX_RATE_DEVIATION_BPS: bad })).toThrow(/PAYCRYT_MAX_RATE_DEVIATION_BPS/);
    }
    expect(build({ ...base, PAYCRYT_MAX_RATE_DEVIATION_BPS: '1500' }).maxRateDeviationBps).toBe(1500);
    expect(build(base).maxRateDeviationBps).toBeUndefined();
  });
});

describe('buildLiveConfig builds the real adapters', () => {
  it('creates one adapter per requested chain, deduplicated and case-insensitive', () => {
    const cfg = build({ PAYCRYT_CHAINS: 'Tron, bitcoin ,tron,ethereum', ETHEREUM_RPC_URL: ETH });
    expect(cfg.chains.map((c) => c.chain)).toEqual(['tron', 'bitcoin', 'ethereum']);
    expect(cfg.chains[0]).toBeInstanceOf(TronGridChainAdapter);
    expect(cfg.chains[1]).toBeInstanceOf(EsploraChainAdapter);
    expect(cfg.chains[2]).toBeInstanceOf(EvmRpcChainAdapter);
  });

  it('defaults to CoinGecko and accepts Binance alongside it', () => {
    expect(build({ PAYCRYT_CHAINS: 'bitcoin' }).rateProviders.map((p) => p.name)).toEqual(['coingecko']);
    const two = build({ PAYCRYT_CHAINS: 'bitcoin', PAYCRYT_RATE_SOURCES: 'coingecko,binance', PAYCRYT_MIN_RATE_SOURCES: '2' });
    expect(two.rateProviders[0]).toBeInstanceOf(CoinGeckoRateProvider);
    expect(two.rateProviders[1]).toBeInstanceOf(BinanceRateProvider);
    expect(two.minRateSources).toBe(2);
  });

  it('actually wires the settings through to the requests each adapter makes', async () => {
    const { fetch, calls } = recorder();
    const cfg = buildLiveConfig(
      {
        PAYCRYT_CHAINS: 'tron,bitcoin,ethereum',
        TRONGRID_API_KEY: 'tg-key',
        TRONGRID_URL: 'https://tron.internal.example/',
        ESPLORA_URL: 'https://esplora.internal.example/api/',
        ETHEREUM_RPC_URL: 'https://rpc.internal.example/eth',
      },
      fetch,
    );
    const [tron, btc, eth] = cfg.chains;
    await tron!.getDeposits('TXYZ', 'USDT');
    await btc!.getDeposits('bc1qexample', 'BTC').catch(() => undefined);
    await eth!.getDeposits('0x0000000000000000000000000000000000000001', 'USDT');

    const tronCalls = calls.filter((c) => c.url.startsWith('https://tron.internal.example'));
    expect(tronCalls.length).toBeGreaterThan(0); // trailing slash trimmed, custom node used
    expect(tronCalls.every((c) => c.headers?.['TRON-PRO-API-KEY'] === 'tg-key')).toBe(true);
    expect(calls.some((c) => c.url.startsWith('https://esplora.internal.example/api/'))).toBe(true);
    expect(calls.some((c) => c.url === 'https://rpc.internal.example/eth' && c.method === 'POST')).toBe(true);
    expect(calls.every((c) => !c.url.includes('api.trongrid.io') && !c.url.includes('blockstream.info'))).toBe(true); // nothing leaked to defaults
  });

  it('never prints an RPC URL, which usually carries an API key, only its host', () => {
    const cfg = build({ PAYCRYT_CHAINS: 'ethereum', ETHEREUM_RPC_URL: ETH });
    const printed = cfg.summary.join('\n');
    expect(printed).toContain('eth-mainnet.rpc.example');
    expect(printed).not.toContain('SECRET_API_KEY_IN_PATH');
  });

  it('warns about the things that bite in production', () => {
    const noKey = build({ PAYCRYT_CHAINS: 'tron' }).summary.join('\n');
    expect(noKey).toContain('WARNING tron: no TRONGRID_API_KEY');
    expect(noKey).toContain('single source means no outlier protection');

    const fine = build({ PAYCRYT_CHAINS: 'tron', TRONGRID_API_KEY: 'k', PAYCRYT_RATE_SOURCES: 'coingecko,binance' }).summary.join('\n');
    expect(fine).not.toContain('WARNING');
    expect(fine).not.toContain('single source');
    expect(build({ PAYCRYT_CHAINS: 'tron', TRONGRID_URL: 'https://mynode.example' }).summary.join('\n')).not.toContain('WARNING tron');
  });
});
