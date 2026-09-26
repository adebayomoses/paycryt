import { BinanceRateProvider, CoinGeckoRateProvider, EsploraChainAdapter, EvmRpcChainAdapter, TronGridChainAdapter } from '@paycryt/adapters';
import type { ChainAdapter, FetchLike, RateProvider } from '@paycryt/core';

export type Env = Record<string, string | undefined>;

export interface LiveConfig {
  chains: ChainAdapter[];
  rateProviders: RateProvider[];
  minRateSources?: number;
  maxRateDeviationBps?: number;
  /** Human-readable lines describing what was configured, including warnings worth reading before going live. */
  summary: string[];
}

const EVM_RPC_VARS: Record<string, string> = { ethereum: 'ETHEREUM_RPC_URL', base: 'BASE_RPC_URL', bsc: 'BSC_RPC_URL' };
const ALL_CHAINS = ['tron', 'bitcoin', ...Object.keys(EVM_RPC_VARS)];
const RATE_SOURCES = ['coingecko', 'binance'];

function list(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Accepts only http(s) URLs. A typo here should stop the server at startup, not surface as a mystery at 3am. */
function httpUrl(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, got "${value}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL`);
  return value.replace(/\/+$/, '');
}

/**
 * Builds the real chain watchers and exchange-rate sources for a live server from environment variables:
 *
 *   PAYCRYT_CHAINS         required. Comma list of: tron, bitcoin, ethereum, base, bsc
 *   TRONGRID_API_KEY       optional (strongly advised): raises TronGrid's rate limit. TRONGRID_URL to use your own node.
 *   ETHEREUM_RPC_URL, BASE_RPC_URL, BSC_RPC_URL   required for each EVM chain listed. Use a paid tier or your own node.
 *   ESPLORA_URL            optional. Defaults to blockstream.info; point at mempool.space or your own electrs.
 *   PAYCRYT_RATE_SOURCES   comma list of: coingecko (default), binance. COINGECKO_API_KEY / COINGECKO_URL optional.
 *   PAYCRYT_MIN_RATE_SOURCES   how many sources must agree (default 1).
 *   PAYCRYT_MAX_RATE_DEVIATION_BPS   how far a source may sit from the median before it is dropped (default 300 = 3%).
 *
 * Throws with a message naming the exact variable to fix.
 */
export function buildLiveConfig(env: Env, fetchImpl: FetchLike): LiveConfig {
  const summary: string[] = [];

  const chainNames = list(env.PAYCRYT_CHAINS);
  if (chainNames.length === 0) throw new Error(`PAYCRYT_CHAINS is required in live mode. Choose from: ${ALL_CHAINS.join(', ')}`);
  const unknown = chainNames.filter((c) => !ALL_CHAINS.includes(c));
  if (unknown.length) throw new Error(`PAYCRYT_CHAINS has unknown chain(s): ${unknown.join(', ')}. Choose from: ${ALL_CHAINS.join(', ')}`);

  const chains: ChainAdapter[] = [];
  for (const name of chainNames) {
    if (name === 'tron') {
      const baseUrl = env.TRONGRID_URL ? httpUrl('TRONGRID_URL', env.TRONGRID_URL) : undefined;
      chains.push(new TronGridChainAdapter({ fetch: fetchImpl, baseUrl, apiKey: env.TRONGRID_API_KEY || undefined }));
      summary.push(`tron: ${baseUrl ?? 'api.trongrid.io'}${env.TRONGRID_API_KEY ? ' (API key set)' : ''}`);
      if (!env.TRONGRID_API_KEY && !baseUrl) summary.push('WARNING tron: no TRONGRID_API_KEY. The free tier rate-limits (HTTP 429) under polling; set a key or your own node.');
    } else if (name === 'bitcoin') {
      const baseUrl = env.ESPLORA_URL ? httpUrl('ESPLORA_URL', env.ESPLORA_URL) : undefined;
      chains.push(new EsploraChainAdapter({ fetch: fetchImpl, baseUrl }));
      summary.push(`bitcoin: ${baseUrl ?? 'blockstream.info'}`);
    } else {
      const varName = EVM_RPC_VARS[name]!;
      const raw = env[varName];
      if (!raw) throw new Error(`${varName} is required because PAYCRYT_CHAINS includes ${name}. Use a paid RPC tier or your own node; public shared RPCs rate-limit and cap log ranges.`);
      const rpcUrl = httpUrl(varName, raw);
      chains.push(new EvmRpcChainAdapter({ fetch: fetchImpl, rpcUrl, chain: name }));
      summary.push(`${name}: ${new URL(rpcUrl).host}`); // the host only: RPC URLs often embed an API key in the path
    }
  }

  const sourceNames = list(env.PAYCRYT_RATE_SOURCES ?? 'coingecko');
  if (sourceNames.length === 0) throw new Error(`PAYCRYT_RATE_SOURCES is empty. Choose from: ${RATE_SOURCES.join(', ')}`);
  const badSources = sourceNames.filter((s) => !RATE_SOURCES.includes(s));
  if (badSources.length) throw new Error(`PAYCRYT_RATE_SOURCES has unknown source(s): ${badSources.join(', ')}. Choose from: ${RATE_SOURCES.join(', ')}`);

  const rateProviders: RateProvider[] = sourceNames.map((s) =>
    s === 'coingecko'
      ? new CoinGeckoRateProvider(fetchImpl, { apiKey: env.COINGECKO_API_KEY || undefined, baseUrl: env.COINGECKO_URL ? httpUrl('COINGECKO_URL', env.COINGECKO_URL) : undefined })
      : new BinanceRateProvider(fetchImpl),
  );
  summary.push(`rates: ${sourceNames.join(', ')}`);

  let minRateSources: number | undefined;
  if (env.PAYCRYT_MIN_RATE_SOURCES !== undefined && env.PAYCRYT_MIN_RATE_SOURCES !== '') {
    const n = Number(env.PAYCRYT_MIN_RATE_SOURCES);
    if (!Number.isInteger(n) || n < 1 || n > rateProviders.length) {
      throw new Error(`PAYCRYT_MIN_RATE_SOURCES must be an integer from 1 to ${rateProviders.length} (the number of sources configured), got "${env.PAYCRYT_MIN_RATE_SOURCES}"`);
    }
    minRateSources = n;
  }
  let maxRateDeviationBps: number | undefined;
  if (env.PAYCRYT_MAX_RATE_DEVIATION_BPS !== undefined && env.PAYCRYT_MAX_RATE_DEVIATION_BPS !== '') {
    const n = Number(env.PAYCRYT_MAX_RATE_DEVIATION_BPS);
    if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error(`PAYCRYT_MAX_RATE_DEVIATION_BPS must be an integer from 1 to 5000, got "${env.PAYCRYT_MAX_RATE_DEVIATION_BPS}"`);
    maxRateDeviationBps = n;
    summary.push(`rates: sources may sit up to ${n} bps from their median`);
  }
  if (rateProviders.length === 1) {
    summary.push('note rates: a single source means no outlier protection; add another source and set PAYCRYT_MIN_RATE_SOURCES=2 for a cross-check.');
  }

  return { chains, rateProviders, minRateSources, maxRateDeviationBps, summary };
}
