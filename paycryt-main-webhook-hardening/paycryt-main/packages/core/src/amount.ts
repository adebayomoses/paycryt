/**
 * Money is never a float in Paycryt. Crypto and fiat amounts are bigint minor units,
 * rates are bigint scaled by 10^RATE_DECIMALS.
 */

export const RATE_DECIMALS = 18;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

export interface Asset {
  symbol: string;
  chain: string;
  decimals: number;
  /** Token contract address, when the asset is not the chain's native coin. */
  contract?: string;
}

export interface Currency {
  code: string;
  decimals: number;
}

export const CURRENCIES = {
  NGN: { code: 'NGN', decimals: 2 },
  GHS: { code: 'GHS', decimals: 2 },
  KES: { code: 'KES', decimals: 2 },
  USD: { code: 'USD', decimals: 2 },
} as const satisfies Record<string, Currency>;

export const ASSETS = {
  USDT_TRC20: { symbol: 'USDT', chain: 'tron', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  USDT_ERC20: { symbol: 'USDT', chain: 'ethereum', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  USDT_BEP20: { symbol: 'USDT', chain: 'bsc', decimals: 18, contract: '0x55d398326f99059fF775485246999027B3197955' },
  USDC_BASE: { symbol: 'USDC', chain: 'base', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  BTC: { symbol: 'BTC', chain: 'bitcoin', decimals: 8 },
  ETH: { symbol: 'ETH', chain: 'ethereum', decimals: 18 },
} as const satisfies Record<string, Asset>;

/** Parse a decimal string ("12.5") into base units. Rejects more precision than `decimals`. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid decimal amount: "${value}"`);
  const [, neg, whole, frac = ''] = m;
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`);
  const units = BigInt(whole! + frac.padEnd(decimals, '0'));
  return neg ? -units : units;
}

/** Format base units as a decimal string with trailing zeros trimmed. */
export function formatUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = (neg ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Convert a JSON number from a third-party API into a scaled rate without exponent surprises. */
export function rateFromNumber(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid rate: ${n}`);
  return parseUnits(n.toFixed(12), RATE_DECIMALS);
}

export function rateFromString(s: string): bigint {
  return parseUnits(s, RATE_DECIMALS);
}

export function rateToString(rate: bigint): string {
  return formatUnits(rate, RATE_DECIMALS);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function medianBigint(values: bigint[]): bigint {
  if (values.length === 0) throw new Error('median of empty list');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/**
 * How much of `asset` covers `fiatMinor` at `rate` (fiat units per 1 asset, scaled 1e18).
 * Rounds up, so the merchant is never short by a rounding error.
 */
export function fiatToAssetUnits(fiatMinor: bigint, currency: Currency, asset: Asset, rate: bigint): bigint {
  return ceilDiv(fiatMinor * 10n ** BigInt(asset.decimals) * RATE_SCALE, rate * 10n ** BigInt(currency.decimals));
}

/** Fiat value (minor units, rounded down) of `units` of `asset` at `rate`. */
export function assetUnitsToFiat(units: bigint, currency: Currency, asset: Asset, rate: bigint): bigint {
  return (units * rate * 10n ** BigInt(currency.decimals)) / (10n ** BigInt(asset.decimals) * RATE_SCALE);
}

export const bps = (amount: bigint, basisPoints: number): bigint => (amount * BigInt(basisPoints)) / 10_000n;
