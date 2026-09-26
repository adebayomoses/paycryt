import { describe, expect, it } from 'vitest';
import { RateEngine, StaticRateProvider, deriveSnapshot, verifyChain, verifySnapshot } from '@paycryt/core';

const T0 = 1_700_000_000_000;
const clock = () => T0;
const src = (name: string, price: string) => new StaticRateProvider(name, { 'USDT/NGN': price }, clock);

describe('rate engine', () => {
  it('two sources that disagree are both refused, and the error shows the real quotes', async () => {
    // Real-world case: CoinGecko ~1326 and Binance ~1518 NGN per USDT. With two sources the median is the midpoint,
    // so both sit the same distance from it. Guessing which is right would short-change someone, so it fails closed.
    const e = new RateEngine({ providers: [src('coingecko', '1326.17'), src('binance', '1518.4')], now: clock });
    const err = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' }).then(() => null, (x: Error) => x);
    expect(err?.message).toMatch(/Only 0 agreeing/);
    expect(err?.message).toContain('coingecko 1326.17');
    expect(err?.message).toContain('binance 1518.4');
    expect(err?.message).toContain('within 300 bps');
    expect(e.log.all()).toHaveLength(0); // nothing was quoted to anyone
  });

  it('the operator can widen the tolerance knowingly, and then the median is used', async () => {
    const e = new RateEngine({ providers: [src('a', '1326.17'), src('b', '1518.4')], maxDeviationBps: 1000, now: clock });
    const s = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.quotes).toHaveLength(2);
    expect(s.rejected).toHaveLength(0);
  });

  it('takes the median of agreeing sources', async () => {
    const e = new RateEngine({ providers: [src('a', '1498'), src('b', '1500'), src('c', '1502')], now: clock });
    const s = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.mid).toBe('1500');
    expect(s.quotes).toHaveLength(3);
  });

  it('rejects outliers and records why', async () => {
    const e = new RateEngine({ providers: [src('a', '1500'), src('b', '1502'), src('bad', '1800')], now: clock });
    const s = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.quotes.map((q) => q.source).sort()).toEqual(['a', 'b']);
    expect(s.rejected[0]).toMatchObject({ source: 'bad' });
    expect(s.rejected[0]!.reason).toContain('outlier');
  });

  it('survives a failing provider but enforces minSources', async () => {
    const broken = { name: 'down', getRate: async () => { throw new Error('timeout'); } };
    const ok = new RateEngine({ providers: [src('a', '1500'), broken], now: clock });
    const s = await ok.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.rejected).toEqual([{ source: 'down', reason: 'timeout' }]);

    const strict = new RateEngine({ providers: [src('a', '1500'), broken], minSources: 2, now: clock });
    await expect(strict.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' })).rejects.toThrow(/need 2/);
  });

  it('applies the spread against the customer in both directions', async () => {
    const e = new RateEngine({ providers: [src('a', '1500')], spreadBps: 100, now: clock });
    const pay = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    const buy = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'FIAT_TO_CRYPTO' });
    expect(pay.effectiveRate).toBe('1485'); // customer pays crypto: fewer naira per coin
    expect(buy.effectiveRate).toBe('1515'); // customer buys crypto: more naira per coin
  });

  it('chains snapshots and detects tampering', async () => {
    const e = new RateEngine({ providers: [src('a', '1500')], now: clock });
    const s1 = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    const s2 = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s2.prevHash).toBe(s1.hash);
    expect(e.log.verify()).toEqual({ ok: true });

    const forged = { ...s1, effectiveRate: '1000' };
    expect(verifySnapshot(forged)).toBe(false);
    expect(verifyChain([forged, s2])).toMatchObject({ ok: false, index: 0 });
    expect(verifyChain([s2, s1])).toMatchObject({ ok: false });
  });

  it('derives a snapshot with extra margin and keeps lineage', async () => {
    const e = new RateEngine({ providers: [src('a', '1500')], now: clock });
    const s = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    const d = deriveSnapshot(s, { extraSpreadBps: 200, reason: 'offline', now: T0 + 1, prevHash: s.hash });
    expect(d.effectiveRate).toBe('1470');
    expect(d.derivedFrom).toEqual({ hash: s.hash, reason: 'offline' });
    expect(verifyChain([s, d])).toEqual({ ok: true });
  });

  it('ignores stale quotes', async () => {
    const old = new StaticRateProvider('old', { 'USDT/NGN': '1500' }, () => T0 - 10 * 60_000);
    const e = new RateEngine({ providers: [old, src('fresh', '1501')], now: clock });
    const s = await e.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.rejected[0]!.reason).toContain('stale');
  });
});
