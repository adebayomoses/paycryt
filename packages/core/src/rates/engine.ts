import { medianBigint, rateFromString, rateToString } from '../amount.js';
import {
  type Direction,
  type QuoteRecord,
  type RateSnapshot,
  type RejectedSource,
  sealSnapshot,
  verifyChain,
} from './snapshot.js';

/** A source of market prices. Implement this to plug in an exchange, a P2P feed or a parallel-market scraper. */
export interface RateProvider {
  readonly name: string;
  /** Price of 1 `base` in `quote`, scaled by 1e18. Throw if the pair is unsupported. */
  getRate(base: string, quote: string): Promise<{ price: bigint; asOf: number }>;
}

/** Append-only, hash-chained record of every rate handed to a customer. */
export class RateAuditLog {
  private readonly entries: RateSnapshot[] = [];

  head(): string | undefined {
    return this.entries.at(-1)?.hash;
  }

  append(snapshot: RateSnapshot): void {
    this.entries.push(snapshot);
  }

  get(hash: string): RateSnapshot | undefined {
    return this.entries.find((s) => s.hash === hash);
  }

  all(): readonly RateSnapshot[] {
    return this.entries;
  }

  verify(): ReturnType<typeof verifyChain> {
    return verifyChain(this.entries);
  }
}

export interface RateEngineOptions {
  providers: RateProvider[];
  /** Cached provider quotes are reused for this long. Default 30s. */
  quoteTtlMs?: number;
  /** A payment request may keep using a snapshot's rate for this long. Default 15 min. */
  lockMs?: number;
  /** Quotes further than this from the median are dropped as outliers. Default 300 bps (3%). */
  maxDeviationBps?: number;
  /** Minimum number of agreeing sources required. Default 1. */
  minSources?: number;
  /** Default margin against the customer. Default 0. */
  spreadBps?: number;
  /** Quotes older than this are ignored even if cached. Default 5 min. */
  maxQuoteAgeMs?: number;
  log?: RateAuditLog;
  now?: () => number;
}

export interface SnapshotRequest {
  base: string;
  quote: string;
  direction: Direction;
  spreadBps?: number;
}

export class RateEngine {
  readonly log: RateAuditLog;
  private readonly cache = new Map<string, { quote: QuoteRecord; price: bigint; fetchedAt: number }>();
  private readonly o: Required<Omit<RateEngineOptions, 'log' | 'now'>>;
  private readonly now: () => number;

  constructor(options: RateEngineOptions) {
    if (options.providers.length === 0) throw new Error('RateEngine needs at least one provider');
    this.o = {
      providers: options.providers,
      quoteTtlMs: options.quoteTtlMs ?? 30_000,
      lockMs: options.lockMs ?? 15 * 60_000,
      maxDeviationBps: options.maxDeviationBps ?? 300,
      minSources: options.minSources ?? 1,
      spreadBps: options.spreadBps ?? 0,
      maxQuoteAgeMs: options.maxQuoteAgeMs ?? 5 * 60_000,
    };
    this.log = options.log ?? new RateAuditLog();
    this.now = options.now ?? Date.now;
  }

  /** Fetch (or reuse cached) quotes, drop outliers, and record a sealed snapshot in the audit log. */
  async getSnapshot(req: SnapshotRequest): Promise<RateSnapshot> {
    const rejected: RejectedSource[] = [];
    const fetched = await Promise.all(this.o.providers.map((p) => this.quoteFrom(p, req, rejected)));
    const candidates = fetched.filter((q): q is { quote: QuoteRecord; price: bigint } => q !== null);
    if (candidates.length === 0) {
      throw new Error(`No rate available for ${req.base}/${req.quote}: ${rejected.map((r) => `${r.source} (${r.reason})`).join('; ')}`);
    }

    const roughMid = medianBigint(candidates.map((c) => c.price));
    const accepted = candidates.filter((c) => {
      const deviation = (absDiff(c.price, roughMid) * 10_000n) / roughMid;
      if (deviation > BigInt(this.o.maxDeviationBps)) {
        rejected.push({ source: c.quote.source, reason: `outlier: ${deviation} bps from median` });
        return false;
      }
      return true;
    });
    if (accepted.length < this.o.minSources) {
      // Say what the sources actually quoted. "0 agreeing" alone hides the real story, e.g. two sources 14% apart.
      const quoted = candidates.map((c) => `${c.quote.source} ${rateToString(c.price)}`).join(', ');
      throw new Error(
        `Only ${accepted.length} agreeing rate source(s) for ${req.base}/${req.quote}, need ${this.o.minSources}. Quotes: ${quoted}; sources must be within ${this.o.maxDeviationBps} bps of their median`,
      );
    }

    const mid = medianBigint(accepted.map((c) => c.price));
    const spreadBps = req.spreadBps ?? this.o.spreadBps;
    const effective =
      req.direction === 'CRYPTO_TO_FIAT'
        ? (mid * BigInt(10_000 - spreadBps)) / 10_000n
        : (mid * BigInt(10_000 + spreadBps)) / 10_000n;

    const createdAt = this.now();
    // Hash-chain link and append happen synchronously so concurrent callers cannot fork the chain.
    const snapshot = sealSnapshot({
      base: req.base,
      quote: req.quote,
      direction: req.direction,
      quotes: accepted.map((c) => c.quote),
      rejected,
      aggregation: 'median',
      mid: rateToString(mid),
      spreadBps,
      effectiveRate: rateToString(effective),
      createdAt,
      lockedUntil: createdAt + this.o.lockMs,
      prevHash: this.log.head(),
    });
    this.log.append(snapshot);
    return snapshot;
  }

  private async quoteFrom(p: RateProvider, req: SnapshotRequest, rejected: RejectedSource[]) {
    const key = `${p.name}:${req.base}/${req.quote}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.fetchedAt < this.o.quoteTtlMs) return { quote: hit.quote, price: hit.price };
    try {
      const { price, asOf } = await p.getRate(req.base, req.quote);
      if (price <= 0n) throw new Error('non-positive price');
      if (now - asOf > this.o.maxQuoteAgeMs) throw new Error(`stale quote (${Math.round((now - asOf) / 1000)}s old)`);
      const quote: QuoteRecord = { source: p.name, price: rateToString(price), asOf };
      this.cache.set(key, { quote, price, fetchedAt: now });
      return { quote, price };
    } catch (err) {
      rejected.push({ source: p.name, reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

/** A provider that returns fixed prices. Handy for tests, the sandbox, and manually maintained parallel-market rates. */
export class StaticRateProvider implements RateProvider {
  constructor(
    readonly name: string,
    private readonly prices: Record<string, string>,
    private readonly clock: () => number = Date.now,
  ) {}

  setPrice(pair: string, price: string): void {
    this.prices[pair] = price;
  }

  async getRate(base: string, quote: string) {
    const p = this.prices[`${base}/${quote}`];
    if (!p) throw new Error(`no price for ${base}/${quote}`);
    return { price: rateFromString(p), asOf: this.clock() };
  }
}
