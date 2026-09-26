import { CURRENCIES, type Asset, type Currency, fiatToAssetUnits, rateFromString } from '../amount.js';
import { randomId } from '../hash.js';
import type { RateSnapshot } from '../rates/snapshot.js';
import { DEFAULT_POLICY, type PaymentPolicy } from './policy.js';
import type { PaymentRequest } from './types.js';

export interface CreatePaymentRequestInput {
  id?: string;
  fiat: { currency: string; amountMinor: bigint };
  asset: Asset;
  address: string;
  addressIndex?: number;
  /** Must be a CRYPTO_TO_FIAT snapshot for `asset.symbol` / `fiat.currency`. */
  snapshot: RateSnapshot;
  policy?: PaymentPolicy;
  now: number;
  offline?: PaymentRequest['offline'];
  metadata?: Record<string, string>;
  merchantId?: string;
  baselineTxIds?: string[];
}

export function createPaymentRequest(input: CreatePaymentRequestInput): PaymentRequest {
  const { snapshot, fiat, asset } = input;
  if (snapshot.base !== asset.symbol || snapshot.quote !== fiat.currency) {
    throw new Error(`Rate snapshot is for ${snapshot.base}/${snapshot.quote}, not ${asset.symbol}/${fiat.currency}`);
  }
  if (snapshot.direction !== 'CRYPTO_TO_FIAT') throw new Error('Payment requests need a CRYPTO_TO_FIAT snapshot');
  if (fiat.amountMinor <= 0n) throw new Error('Fiat amount must be positive');
  if (input.now > snapshot.lockedUntil) throw new Error('Rate snapshot has expired; fetch a fresh one');

  const currency: Currency | undefined = (CURRENCIES as Record<string, Currency>)[fiat.currency];
  if (!currency) throw new Error(`Unsupported currency: ${fiat.currency}`);

  const policy = input.policy ?? DEFAULT_POLICY;
  return {
    id: input.id ?? randomId('pay'),
    fiat,
    asset,
    address: input.address,
    addressIndex: input.addressIndex,
    amountDue: fiatToAssetUnits(fiat.amountMinor, currency, asset, rateFromString(snapshot.effectiveRate)),
    rateSnapshotHash: snapshot.hash,
    effectiveRate: snapshot.effectiveRate,
    createdAt: input.now,
    expiresAt: input.now + policy.expiryMs,
    policy,
    offline: input.offline,
    metadata: input.metadata,
    merchantId: input.merchantId,
    baselineTxIds: input.baselineTxIds,
  };
}

/** Compact string suitable for a QR code. Wallet apps that know the scheme can prefill amount and address. */
export function paymentUri(request: PaymentRequest): string {
  const params = new URLSearchParams({
    asset: request.asset.symbol,
    chain: request.asset.chain,
    amount: request.amountDue.toString(),
    ref: request.id,
  });
  return `paycryt:${request.address}?${params.toString()}`;
}
