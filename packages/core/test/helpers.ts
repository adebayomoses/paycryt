import { ASSETS, RateEngine, StaticRateProvider, createPaymentRequest, withPolicy, type PaymentPolicy } from '@paycryt/core';

export const T0 = 1_700_000_000_000;

/** A controllable clock. */
export function makeClock(start = T0) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v), advance: (ms: number) => (t += ms) };
}

export function makeEngine(clock: () => number, opts: { spreadBps?: number; price?: string } = {}) {
  const price = opts.price ?? '1500';
  return new RateEngine({
    providers: [new StaticRateProvider('a', { 'USDT/NGN': price }, clock), new StaticRateProvider('b', { 'USDT/NGN': price }, clock)],
    spreadBps: opts.spreadBps ?? 0,
    now: clock,
  });
}

/** A NGN 15,000 (= 10 USDT at 1500, no spread) payment request. */
export async function makeRequest(clock = makeClock(), policy: PaymentPolicy = withPolicy()) {
  const engine = makeEngine(clock.now);
  const snapshot = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
  const request = createPaymentRequest({
    fiat: { currency: 'NGN', amountMinor: 1_500_000n },
    asset: ASSETS.USDT_TRC20,
    address: 'fake:tron:000001',
    snapshot,
    policy,
    now: clock.now(),
  });
  return { request, clock, engine, snapshot };
}
