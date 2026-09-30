import {
  type CollectionProvider,
  type CollectionRequest,
  type CollectionResult,
  type Destination,
  type FetchLike,
  type PayoutRequest,
  type PayoutResult,
  type SettlementProvider,
} from '@paycryt/core';

/**
 * Paystack adapter: bank (NUBAN) and mobile-money payouts, plus mobile-money collection.
 *
 * EXPERIMENTAL. Written against Paystack's public docs and covered by mocked-HTTP tests only.
 * Test with Paystack's test keys and read their current docs before moving real money.
 */
export class PaystackAdapter implements SettlementProvider, CollectionProvider {
  readonly name = 'paystack';
  private readonly baseUrl: string;

  constructor(
    private readonly secretKey: string,
    private readonly fetch: FetchLike,
    opts: { baseUrl?: string } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? 'https://api.paystack.co';
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    const recipient = await this.call('POST', '/transferrecipient', recipientBody(req));
    const transfer = await this.call('POST', '/transfer', {
      source: 'balance',
      amount: Number(req.amountMinor), // Paystack takes minor units (kobo/pesewas)
      recipient: recipient.data.recipient_code,
      reference: req.reference,
      reason: req.narration,
      currency: req.currency,
    });
    return mapTransfer(req.reference, transfer.data);
  }

  async getPayout(reference: string): Promise<PayoutResult> {
    try {
      const res = await this.call('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
      return mapTransfer(reference, res.data);
    } catch (err) {
      // A reference that was never sent to Paystack (or hasn't landed there yet) is a normal outcome for a
      // status check, not an exceptional one — the same as MockSettlementProvider reports it. Anything else
      // (auth, rate limit, ...) still throws.
      if (err instanceof ProviderCallError && err.notFound) return { reference, status: 'failed', failureReason: 'unknown reference' };
      throw err;
    }
  }

  /** Mobile-money charge (Ghana, Kenya, ...). The customer approves a prompt on their phone. */
  async collect(req: CollectionRequest): Promise<CollectionResult> {
    if (!req.mobileMoney) throw new Error('PaystackAdapter.collect currently supports mobile money only');
    const res = await this.call('POST', '/charge', {
      email: req.email,
      amount: Number(req.amountMinor),
      currency: req.currency,
      reference: req.reference,
      // Paystack's own `GET /bank?currency=GHS&type=mobile_money` returns provider codes uppercase (MTN, ATL, VOD),
      // confirmed live; pass the operator through as given rather than guessing at a lowercase form.
      mobile_money: { phone: req.mobileMoney.phone, provider: req.mobileMoney.operator },
    });
    return mapCharge(req.reference, res.data);
  }

  async getCollection(reference: string): Promise<CollectionResult> {
    try {
      const res = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      return mapCharge(reference, res.data);
    } catch (err) {
      if (err instanceof ProviderCallError && err.notFound) return { reference, status: 'failed', failureReason: 'unknown reference' };
      throw err;
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) {
      // Verified live: an unknown transfer/transaction reference comes back as HTTP 404 with code "not_found".
      throw new ProviderCallError(`Paystack ${method} ${path} failed: ${json.message ?? res.status}`, res.status === 404);
    }
    return json;
  }
}

/** Carries whether a failed call means "nothing there" (safe to report as a status) vs a real error (must throw). */
class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
  ) {
    super(message);
  }
}

function recipientBody(req: PayoutRequest) {
  const d: Destination = req.destination;
  return d.type === 'bank'
    ? { type: 'nuban', name: d.accountName ?? 'Merchant', account_number: d.accountNumber, bank_code: d.bankCode, currency: req.currency }
    : { type: 'mobile_money', name: d.accountName ?? 'Merchant', account_number: d.phone, bank_code: d.operator, currency: req.currency };
}

function mapTransfer(reference: string, data: any): PayoutResult {
  const s = String(data?.status ?? '').toLowerCase();
  const status = s === 'success' ? 'succeeded' : s === 'failed' || s === 'reversed' ? 'failed' : s === 'otp' || s === 'pending' ? 'processing' : 'pending';
  return { reference, status, providerRef: data?.transfer_code ?? data?.id?.toString(), failureReason: status === 'failed' ? data?.reason ?? s : undefined };
}

function mapCharge(reference: string, data: any): CollectionResult {
  const s = String(data?.status ?? '').toLowerCase();
  if (s === 'success') return { reference, status: 'succeeded', providerRef: data?.id?.toString() };
  if (s === 'failed' || s === 'abandoned') return { reference, status: 'failed', failureReason: data?.gateway_response ?? s };
  return { reference, status: 'pending_customer_action', instruction: data?.display_text ?? 'Approve the payment prompt on your phone', providerRef: data?.id?.toString() };
}

