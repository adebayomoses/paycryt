import type { Asset, Currency } from '../amount.js';
import type { PaymentPolicy } from './policy.js';

/** A deposit as seen on-chain (or on the fake chain). */
export interface ChainDeposit {
  txId: string;
  address: string;
  assetSymbol: string;
  /** Base units of the asset. */
  amount: bigint;
  confirmations: number;
  /** Unix ms. */
  receivedAt: number;
}

export interface PaymentRequest {
  id: string;
  fiat: { currency: string; amountMinor: bigint };
  asset: Asset;
  /** Deposit address for this request. */
  address: string;
  /** Derivation index the address came from, when HD-derived. */
  addressIndex?: number;
  /** Crypto amount due, base units, computed from the locked rate snapshot. */
  amountDue: bigint;
  /** Hash of the RateSnapshot this amount was priced with. Look it up in the audit log. */
  rateSnapshotHash: string;
  /** Effective rate the customer was charged, decimal string (fiat per 1 asset). */
  effectiveRate: string;
  createdAt: number;
  expiresAt: number;
  policy: PaymentPolicy;
  /** Set when created by an offline POS device. */
  offline?: { deviceId: string; createdOfflineAt: number };
  metadata?: Record<string, string>;
  /** The merchant (tenant) this payment belongs to, when the server is multi-tenant. */
  merchantId?: string;
  /**
   * Transaction ids already at `address` when it was issued. They are ignored, so old funds on a reused or
   * imported address can never pay this request. Only capturable for online requests, before the address
   * is shown to a customer; an offline device can't know it, and relies on `policy.backdateToleranceMs`.
   */
  baselineTxIds?: string[];
}

export type CurrencyLike = Currency;
