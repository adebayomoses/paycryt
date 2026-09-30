import type { PaymentEvent } from '../chain/watcher.js';
import type { PaymentRequest } from '../payments/types.js';
import type { Destination, PayoutResult, SettlementProvider } from './types.js';

export interface SettlementRule {
  /** Where the merchant's fiat should go. */
  destination: Destination | ((request: PaymentRequest) => Destination);
  /** Fee you keep, in bps of the fiat amount. Default 0. */
  feeBps?: number;
  /** Settle overpaid payments too (only the requested fiat amount is paid out; excess follows the overpayment policy). Default true. */
  settleOverpaid?: boolean;
}

/**
 * Turns confirmed crypto payments into fiat payouts through whichever SettlementProvider you plug in
 * (Paystack, Flutterwave, your own bank API, or the sandbox mock).
 * Payout references are derived from the payment id, so replayed events can never pay twice.
 */
export class SettlementOrchestrator {
  readonly results = new Map<string, PayoutResult>();

  constructor(
    private readonly provider: SettlementProvider,
    private readonly rule: SettlementRule,
    private readonly lookup: (paymentId: string) => PaymentRequest | undefined,
  ) {}

  /** Wire this to `watcher.on(...)`. */
  handle = async (event: PaymentEvent): Promise<PayoutResult | undefined> => {
    if (event.type !== 'payment.confirmed' && !(event.type === 'payment.overpaid' && this.rule.settleOverpaid !== false)) return undefined;
    const request = this.lookup(event.paymentId);
    if (!request) return undefined;

    const reference = `settle_${request.id}`;
    const already = this.results.get(reference);
    if (already && already.status !== 'failed') return already;

    const fee = (request.fiat.amountMinor * BigInt(this.rule.feeBps ?? 0)) / 10_000n;
    const result = await this.provider.payout({
      reference,
      currency: request.fiat.currency,
      amountMinor: request.fiat.amountMinor - fee,
      destination: typeof this.rule.destination === 'function' ? this.rule.destination(request) : this.rule.destination,
      narration: `Paycryt payment ${request.id}`,
    });
    this.results.set(reference, result);
    return result;
  };
}
