import { canonicalJson, sha256Hex } from '../hash.js';
import { rateFromString, rateToString } from '../amount.js';

/**
 * Which way money flows, because the spread always works against the customer:
 *  - CRYPTO_TO_FIAT: customer pays crypto for a fiat-priced bill (or an off-ramp). Effective rate is *below* mid.
 *  - FIAT_TO_CRYPTO: customer buys crypto with fiat (on-ramp). Effective rate is *above* mid.
 */
export type Direction = 'CRYPTO_TO_FIAT' | 'FIAT_TO_CRYPTO';

export interface QuoteRecord {
  source: string;
  /** Fiat per 1 base asset, decimal string. */
  price: string;
  /** Unix ms when the source produced this price. */
  asOf: number;
}

export interface RejectedSource {
  source: string;
  reason: string;
}

export interface SnapshotBody {
  /** Asset symbol, e.g. "USDT". */
  base: string;
  /** Fiat code, e.g. "NGN". */
  quote: string;
  direction: Direction;
  quotes: QuoteRecord[];
  rejected: RejectedSource[];
  aggregation: 'median';
  /** Aggregated market rate, decimal string. */
  mid: string;
  /** Operator margin in basis points, applied against the customer. */
  spreadBps: number;
  /** The rate customers are actually charged, decimal string. */
  effectiveRate: string;
  createdAt: number;
  /** How long a payment request may use this rate. */
  lockedUntil: number;
  /** Hash of the previous snapshot in the log, if any (tamper-evident chain). */
  prevHash?: string;
  /** Set when this snapshot was derived from another one (e.g. offline safety margin). */
  derivedFrom?: { hash: string; reason: string };
}

export interface RateSnapshot extends SnapshotBody {
  /** sha256 over the canonical JSON of the body. Doubles as the snapshot id. */
  hash: string;
}

export function hashSnapshotBody(body: SnapshotBody): string {
  return sha256Hex(canonicalJson(body));
}

export function sealSnapshot(body: SnapshotBody): RateSnapshot {
  return { ...body, hash: hashSnapshotBody(body) };
}

/** True when the snapshot's contents still match its hash. */
export function verifySnapshot(snapshot: RateSnapshot): boolean {
  const { hash, ...body } = snapshot;
  return hashSnapshotBody(body) === hash;
}

/** Verify each snapshot and that every `prevHash` points at its predecessor. */
export function verifyChain(chain: RateSnapshot[]): { ok: true } | { ok: false; index: number; reason: string } {
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i]!;
    if (!verifySnapshot(s)) return { ok: false, index: i, reason: 'hash mismatch (contents were modified)' };
    const expectedPrev = i === 0 ? undefined : chain[i - 1]!.hash;
    if (i > 0 && s.prevHash !== expectedPrev) return { ok: false, index: i, reason: 'broken link to previous snapshot' };
  }
  return { ok: true };
}

/**
 * Apply an extra margin to an existing snapshot without touching the original.
 * The result records what it was derived from, so the audit trail stays complete.
 */
export function deriveSnapshot(
  parent: RateSnapshot,
  opts: { extraSpreadBps: number; reason: string; now: number; lockedUntil?: number; prevHash?: string },
): RateSnapshot {
  const { hash: parentHash, ...parentBody } = parent;
  const mid = rateFromString(parent.mid);
  const spreadBps = parent.spreadBps + opts.extraSpreadBps;
  const effective =
    parent.direction === 'CRYPTO_TO_FIAT'
      ? (mid * BigInt(10_000 - spreadBps)) / 10_000n
      : (mid * BigInt(10_000 + spreadBps)) / 10_000n;
  return sealSnapshot({
    ...parentBody,
    spreadBps,
    effectiveRate: rateToString(effective),
    createdAt: opts.now,
    lockedUntil: opts.lockedUntil ?? parent.lockedUntil,
    prevHash: opts.prevHash,
    derivedFrom: { hash: parentHash, reason: opts.reason },
  });
}
