import {
  CURRENCIES,
  type CollectionProvider,
  type CollectionRequest,
  type CollectionResult,
  type Currency,
  type FetchLike,
  type PayoutRequest,
  type PayoutResult,
  type SettlementProvider,
  formatUnits,
} from '@paycryt/core';

/**
 * Flutterwave v3 adapter: bank and mobile-money payouts (M-Pesa, MTN MoMo, ...) and mobile-money collection.
 *
 * EXPERIMENTAL. Written against Flutterwave's public docs and covered by mocked-HTTP tests only.
 * Note that Flutterwave takes MAJOR units (naira, not kobo). Test with sandbox keys before going live.
 */
export class FlutterwaveAdapter implements SettlementProvider, CollectionProvider {
  readonly name = 'flutterwave';
  private readonly baseUrl: string;

  constructor(
    private readonly secretKey: string,
    private readonly fetch: FetchLike,
    opts: { baseUrl?: string } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? 'https://api.flutterwave.com/v3';
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    const d = req.destination;
    const res = await this.call('POST', '/transfers', {
      account_bank: d.type === 'bank' ? d.bankCode : d.operator,
      account_number: d.type === 'bank' ? d.accountNumber : d.phone,
      amount: major(req.amountMinor, req.currency),
      currency: req.currency,
      narration: req.narration ?? 'Paycryt settlement',
      reference: req.reference,
      beneficiary_name: d.accountName,
    });
    return mapTransfer(req.reference, res.data);
  }

  async getPayout(reference: string, providerRef?: string): Promise<PayoutResult> {
    if (!providerRef) throw new Error('Flutterwave needs the providerRef (transfer id) to check a payout');
    const res = await this.call('GET', `/transfers/${encodeURIComponent(providerRef)}`);
    return mapTransfer(reference, res.data);
  }

  /** Mobile-money charge. M-Pesa (KES) and Ghana mobile money are wired up; others can be added the same way. */
  async collect(req: CollectionRequest): Promise<CollectionResult> {
    const mm = req.mobileMoney;
    if (!mm) throw new Error('FlutterwaveAdapter.collect currently supports mobile money only');
    const type = req.currency === 'KES' ? 'mpesa' : req.currency === 'GHS' ? 'mobile_money_ghana' : undefined;
    if (!type) throw new Error(`No Flutterwave mobile-money charge type mapped for ${req.currency}`);
    const res = await this.call('POST', `/charges?type=${type}`, {
      tx_ref: req.reference,
      amount: major(req.amountMinor, req.currency),
      currency: req.currency,
      email: req.email,
      phone_number: mm.phone,
      network: type === 'mobile_money_ghana' ? mm.operator.toUpperCase() : undefined,
    });
    return mapCharge(req.reference, res);
  }

  async getCollection(reference: string): Promise<CollectionResult> {
    const res = await this.call('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    return mapCharge(reference, res);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === 'error') throw new Error(`Flutterwave ${method} ${path} failed: ${json.message ?? res.status}`);
    return json;
  }
}

/** Minor units -> the decimal number Flutterwave expects. Uses string math, so no float drift. */
function major(minor: bigint, currencyCode: string): number {
  const c: Currency | undefined = (CURRENCIES as Record<string, Currency>)[currencyCode];
  if (!c) throw new Error(`Unsupported currency ${currencyCode}`);
  return Number(formatUnits(minor, c.decimals));
}

function mapTransfer(reference: string, data: any): PayoutResult {
  const s = String(data?.status ?? '').toUpperCase();
  const status = s === 'SUCCESSFUL' ? 'succeeded' : s === 'FAILED' ? 'failed' : s === 'PENDING' ? 'processing' : 'pending';
  return { reference, status, providerRef: data?.id?.toString(), failureReason: status === 'failed' ? data?.complete_message ?? 'failed' : undefined };
}

function mapCharge(reference: string, res: any): CollectionResult {
  const data = res?.data ?? {};
  const s = String(data.status ?? '').toLowerCase();
  if (s === 'successful') return { reference, status: 'succeeded', providerRef: data.id?.toString() };
  if (s === 'failed') return { reference, status: 'failed', failureReason: data.processor_response ?? 'failed' };
  return { reference, status: 'pending_customer_action', instruction: res?.meta?.authorization?.note ?? 'Approve the payment prompt on your phone', providerRef: data.id?.toString() };
}
