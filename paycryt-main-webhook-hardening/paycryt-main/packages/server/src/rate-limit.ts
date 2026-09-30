/**
 * A per-key token bucket, in memory only. Abuse protection resetting on restart is fine — it doesn't need
 * to survive one, unlike payments or the rate audit trail.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    if (perMinute <= 0) throw new Error('perMinute must be positive');
    if (burst <= 0) throw new Error('burst must be positive');
  }

  /**
   * Consumes one token for `key` if one is available; refills at `perMinute`, capped at `burst`. When
   * exhausted, the bucket state is still updated (so the next call's refill math is correct) but nothing
   * is consumed.
   */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const prev = this.buckets.get(key);
    const elapsedMs = prev ? Math.max(0, t - prev.last) : 0;
    const refilled = prev ? Math.min(this.burst, prev.tokens + (elapsedMs / 60_000) * this.perMinute) : this.burst;
    if (refilled >= 1) {
      this.buckets.set(key, { tokens: refilled - 1, last: t });
      return { ok: true };
    }
    this.buckets.set(key, { tokens: refilled, last: t });
    const missing = 1 - refilled;
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil((missing / this.perMinute) * 60_000)) };
  }

  /** Number of keys currently tracked. Exposed for tests; also what `sweep` bounds over a long-running process. */
  get size(): number {
    return this.buckets.size;
  }

  /** Drops buckets untouched for `maxAgeMs`, so a long-running server doesn't accumulate one entry per caller forever. */
  sweep(maxAgeMs: number): void {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (t - b.last > maxAgeMs) this.buckets.delete(key);
    }
  }
}
