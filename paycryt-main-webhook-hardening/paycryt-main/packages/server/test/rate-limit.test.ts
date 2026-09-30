import { describe, expect, it } from 'vitest';
import { RateLimiter } from '@paycryt/server';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('RateLimiter', () => {
  it('allows up to the burst immediately, then refuses', () => {
    const c = clock();
    const rl = new RateLimiter(60, 3, c.now); // 1/sec, burst 3
    expect(rl.take('a')).toEqual({ ok: true });
    expect(rl.take('a')).toEqual({ ok: true });
    expect(rl.take('a')).toEqual({ ok: true });
    const fourth = rl.take('a');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time at the configured rate, and never above the burst cap', () => {
    const c = clock();
    const rl = new RateLimiter(60, 2, c.now); // 1/sec, burst 2
    rl.take('a');
    rl.take('a');
    expect(rl.take('a').ok).toBe(false); // exhausted
    c.advance(500);
    expect(rl.take('a').ok).toBe(false); // half a token isn't a whole one
    c.advance(600); // total 1.1s since the last consumption: one token available
    expect(rl.take('a').ok).toBe(true);
    c.advance(10_000); // long idle: caps at burst, doesn't bank unlimited tokens
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(false); // third in a row still refused: burst is 2, not unbounded
  });

  it('tracks each key independently', () => {
    const rl = new RateLimiter(60, 1);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(false);
    expect(rl.take('b').ok).toBe(true); // a different key has its own bucket
  });

  it('retryAfterMs is roughly how long until the next token, not a constant', () => {
    const c = clock();
    const rl = new RateLimiter(60, 1, c.now); // 1 token per second
    rl.take('a');
    const r = rl.take('a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBeGreaterThanOrEqual(990); // ~1000ms for a full token at 1/sec
  });

  it('sweep drops only buckets untouched for longer than maxAgeMs', () => {
    const c = clock();
    const rl = new RateLimiter(60, 5, c.now);
    rl.take('stale');
    c.advance(10_000);
    rl.take('fresh');
    expect(rl.size).toBe(2);
    rl.sweep(5_000); // stale's last touch is now 10s ago, fresh's is 0s ago
    expect(rl.size).toBe(1);
    expect(rl.take('fresh').ok).toBe(true); // fresh's bucket survived with its state, not reset to full burst
  });

  it('rejects a non-positive rate or burst up front, not on first use', () => {
    expect(() => new RateLimiter(0, 5)).toThrow();
    expect(() => new RateLimiter(60, 0)).toThrow();
    expect(() => new RateLimiter(-1, 5)).toThrow();
  });
});
