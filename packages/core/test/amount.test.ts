import { describe, expect, it } from 'vitest';
import { ASSETS, CURRENCIES, fiatToAssetUnits, formatUnits, parseUnits, rateFromString, rateToString } from '@paycryt/core';

describe('amounts', () => {
  it('round-trips decimals without floats', () => {
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
    expect(formatUnits(12_500_000n, 6)).toBe('12.5');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
    expect(formatUnits(0n, 2)).toBe('0');
  });

  it('rejects excess precision and junk', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow();
    expect(() => parseUnits('abc', 6)).toThrow();
  });

  it('prices fiat into asset units, rounding up', () => {
    // NGN 15,000.00 at 1,500 NGN/USDT -> exactly 10 USDT
    expect(fiatToAssetUnits(1_500_000n, CURRENCIES.NGN, ASSETS.USDT_TRC20, rateFromString('1500'))).toBe(10_000_000n);
    // NGN 1.00 at 1,500 NGN/USDT = 0.000666.. USDT -> rounds UP to 0.000667
    expect(fiatToAssetUnits(100n, CURRENCIES.NGN, ASSETS.USDT_TRC20, rateFromString('1500'))).toBe(667n);
  });

  it('keeps rates as strings losslessly', () => {
    expect(rateToString(rateFromString('1500.25'))).toBe('1500.25');
  });
});
