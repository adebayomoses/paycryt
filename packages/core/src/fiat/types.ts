/**
 * Local fiat rails, as interfaces. Paycryt never holds your fiat: you bring your own
 * Paystack / Flutterwave / bank / mobile-money account and plug it in via an adapter.
 */

export type Destination =
  | { type: 'bank'; bankCode: string; accountNumber: string; accountName?: string }
  | {
      type: 'mobile_money';
      /** Operator code as the provider expects it, e.g. "MTN", "MPS" (M-Pesa Kenya), "VODAFONE". */
      operator: string;
      /** MSISDN in international format, e.g. "233240000000". */
      phone: string;
      accountName?: string;
    };

export interface PayoutRequest {
  /** Your idempotency key. Re-sending the same reference must never pay twice. */
  reference: string;
  currency: string;
  amountMinor: bigint;
  destination: Destination;
  narration?: string;
}

export type PayoutStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface PayoutResult {
  reference: string;
  status: PayoutStatus;
  /** The provider's own id for this transfer. Needed by some providers for status checks. */
  providerRef?: string;
  failureReason?: string;
}

/** Off-ramp: send fiat to a bank account or mobile-money wallet. */
export interface SettlementProvider {
  readonly name: string;
  payout(request: PayoutRequest): Promise<PayoutResult>;
  getPayout(reference: string, providerRef?: string): Promise<PayoutResult>;
}

export interface CollectionRequest {
  reference: string;
  currency: string;
  amountMinor: bigint;
  email: string;
  /** Mobile-money charge details. */
  mobileMoney?: { operator: string; phone: string };
}

export type CollectionStatus = 'pending_customer_action' | 'succeeded' | 'failed';

export interface CollectionResult {
  reference: string;
  status: CollectionStatus;
  /** e.g. "Approve the prompt on your phone". */
  instruction?: string;
  providerRef?: string;
  failureReason?: string;
}

/** On-ramp: collect fiat from a customer (mobile-money prompt, card, bank transfer). */
export interface CollectionProvider {
  readonly name: string;
  collect(request: CollectionRequest): Promise<CollectionResult>;
  getCollection(reference: string, providerRef?: string): Promise<CollectionResult>;
}

/** Minimal `fetch` shape so adapters can be tested without a network and run on any runtime. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** Sandbox provider: succeeds instantly (or fails on demand) and never contacts anyone. Idempotent by reference. */
export class MockSettlementProvider implements SettlementProvider {
  readonly name = 'mock';
  readonly payouts = new Map<string, PayoutResult & { request: PayoutRequest }>();

  constructor(private readonly opts: { failReferences?: Set<string> } = {}) {}

  async payout(request: PayoutRequest): Promise<PayoutResult> {
    const existing = this.payouts.get(request.reference);
    if (existing) return stripRequest(existing);
    const failed = this.opts.failReferences?.has(request.reference);
    const result: PayoutResult = failed
      ? { reference: request.reference, status: 'failed', failureReason: 'mock failure' }
      : { reference: request.reference, status: 'succeeded', providerRef: `mock_${this.payouts.size + 1}` };
    this.payouts.set(request.reference, { ...result, request });
    return result;
  }

  async getPayout(reference: string): Promise<PayoutResult> {
    const p = this.payouts.get(reference);
    if (!p) return { reference, status: 'failed', failureReason: 'unknown reference' };
    return stripRequest(p);
  }
}

const stripRequest = ({ request: _r, ...rest }: PayoutResult & { request: PayoutRequest }): PayoutResult => rest;
