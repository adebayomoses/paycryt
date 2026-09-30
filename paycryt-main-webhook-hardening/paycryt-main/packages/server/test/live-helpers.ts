import { FakeChain, StaticRateProvider } from '@paycryt/core';

const CHAINS = ['tron', 'ethereum', 'bsc', 'base', 'bitcoin'];
const PRICES = { 'USDT/NGN': '1500', 'USDC/NGN': '1500', 'BTC/NGN': '150000000' };

/**
 * Stand-ins for the real adapters and exchange feeds, so live-mode behaviour can be tested without a network.
 * `FakeChain` implements the same `ChainAdapter` interface as the Tron/EVM/Bitcoin watchers, and the tests
 * hold a reference to it so they can simulate a customer paying.
 */
export function liveOptions(overrides: { chains?: FakeChain[]; prices?: Record<string, string> } = {}) {
  const chains = overrides.chains ?? CHAINS.map((c) => new FakeChain(c));
  const prices = overrides.prices ?? PRICES;
  return {
    sandbox: false as const,
    chains,
    rateProviders: [new StaticRateProvider('feed-a', prices), new StaticRateProvider('feed-b', prices)],
    pollIntervalMs: 20,
  };
}
