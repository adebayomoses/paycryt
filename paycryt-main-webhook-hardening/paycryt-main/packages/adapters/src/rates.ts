import { type FetchLike, type RateProvider, rateFromNumber } from '@paycryt/core';

/** CoinGecko coin ids for the symbols Paycryt supports out of the box. Extend via the constructor. */
const DEFAULT_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  SOL: 'solana',
  TRX: 'tron',
};

/** Free public CoinGecko endpoint (rate-limited). Pass `apiKey` for a demo/pro key. */
export class CoinGeckoRateProvider implements RateProvider {
  readonly name = 'coingecko';

  constructor(
    private readonly fetch: FetchLike,
    private readonly opts: { ids?: Record<string, string>; baseUrl?: string; apiKey?: string; clock?: () => number } = {},
  ) {}

  async getRate(base: string, quote: string) {
    const id = { ...DEFAULT_IDS, ...this.opts.ids }[base];
    if (!id) throw new Error(`CoinGecko: unknown asset ${base}`);
    const vs = quote.toLowerCase();
    const url = `${this.opts.baseUrl ?? 'https://api.coingecko.com/api/v3'}/simple/price?ids=${id}&vs_currencies=${vs}&include_last_updated_at=true`;
    const res = await this.fetch(url, { headers: this.opts.apiKey ? { 'x-cg-demo-api-key': this.opts.apiKey } : {} });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const json = await res.json();
    const price = json?.[id]?.[vs];
    if (typeof price !== 'number') throw new Error(`CoinGecko: no ${base}/${quote} price`);
    const updated = json[id].last_updated_at;
    return { price: rateFromNumber(price), asOf: typeof updated === 'number' ? updated * 1000 : (this.opts.clock ?? Date.now)() };
  }
}

/**
 * Binance public spot ticker (no API key). Only works for pairs Binance lists, e.g. USDT/NGN, BTC/USDT.
 * Uses the symbol `${base}${quote}`.
 */
export class BinanceRateProvider implements RateProvider {
  readonly name = 'binance';

  constructor(
    private readonly fetch: FetchLike,
    private readonly opts: { baseUrl?: string; clock?: () => number } = {},
  ) {}

  async getRate(base: string, quote: string) {
    const res = await this.fetch(`${this.opts.baseUrl ?? 'https://api.binance.com'}/api/v3/ticker/price?symbol=${base}${quote}`);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const json = await res.json();
    const price = Number(json?.price);
    if (!Number.isFinite(price)) throw new Error(`Binance: no ${base}${quote} price`);
    return { price: rateFromNumber(price), asOf: (this.opts.clock ?? Date.now)() };
  }
}

/**
 * The street / parallel-market rate is often what customers actually care about, and there is no official API for it.
 * Give this provider any async function: scrape a P2P board, read a Google Sheet, call your own service, or return a
 * number an operator types into an admin screen.
 */
export class ParallelMarketRateProvider implements RateProvider {
  constructor(
    readonly name: string,
    private readonly source: (base: string, quote: string) => Promise<number | { price: number; asOf?: number }>,
    private readonly clock: () => number = Date.now,
  ) {}

  async getRate(base: string, quote: string) {
    const r = await this.source(base, quote);
    const { price, asOf } = typeof r === 'number' ? { price: r, asOf: undefined } : r;
    return { price: rateFromNumber(price), asOf: asOf ?? this.clock() };
  }
}
