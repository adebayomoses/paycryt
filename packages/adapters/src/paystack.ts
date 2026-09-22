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
    const res = await this.call('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    return mapTransfer(reference, res.data);
  }

  /** Mobile-money charge (Ghana, Kenya, ...). The customer approves a prompt on their phone. */
  async collect(req: CollectionRequest): Promise<CollectionResult> {
    if (!req.mobileMoney) throw new Error('PaystackAdapter.collect currently supports mobile money only');
    const res = await this.call('POST', '/charge', {
      email: req.email,
      amount: Number(req.amountMinor),
      currency: req.currency,
      reference: req.reference,
      mobile_money: { phone: req.mobileMoney.phone, provider: req.mobileMoney.operator.toLowerCase() },
    });
    return mapCharge(req.reference, res.data);
  }

  async getCollection(reference: string): Promise<CollectionResult> {
    const res = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return mapCharge(reference, res.data);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) throw new Error(`Paystack ${method} ${path} failed: ${json.message ?? res.status}`);
    return json;
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

