import { evaluatePayment, type PaymentEvaluation, type PaymentStatus } from '../payments/policy.js';
import type { PaymentRequest } from '../payments/types.js';
import type { ChainAdapter } from './adapter.js';

export type PaymentEventType =
  | 'payment.detected'
  | 'payment.partially_paid'
  | 'payment.confirmed'
  | 'payment.overpaid'
  | 'payment.expired'
  | 'payment.refund_required'
  | 'payment.manual_review';

export interface PaymentEvent {
  /** Stable id, so receivers can de-duplicate retried webhooks. */
  id: string;
  type: PaymentEventType;
  paymentId: string;
  status: PaymentStatus;
  evaluation: PaymentEvaluation;
  createdAt: number;
}

const EVENT_FOR_STATUS: Partial<Record<PaymentStatus, PaymentEventType>> = {
  confirming: 'payment.detected',
  partially_paid: 'payment.partially_paid',
  paid: 'payment.confirmed',
  overpaid: 'payment.overpaid',
  expired: 'payment.expired',
  refund_required: 'payment.refund_required',
  manual_review: 'payment.manual_review',
};

export interface WatchedPayment {
  request: PaymentRequest;
  status: PaymentStatus;
  evaluation: PaymentEvaluation;
}

/**
 * Polls chains for each open payment and emits an event whenever its status changes.
 * Call `tick()` on a timer (production) or after each simulated action (tests, sandbox).
 */
export class PaymentWatcher {
  private readonly payments = new Map<string, WatchedPayment>();
  private handlers: Array<(e: PaymentEvent) => void | Promise<void>> = [];
  private seq = 0;

  constructor(
    private readonly chains: ChainAdapter[],
    private readonly clock: () => number = Date.now,
  ) {}

  watch(request: PaymentRequest): void {
    if (this.payments.has(request.id)) return;
    const evaluation = evaluatePayment(request, [], this.clock());
    this.payments.set(request.id, { request, status: evaluation.status, evaluation });
  }

  get(id: string): WatchedPayment | undefined {
    return this.payments.get(id);
  }

  list(): WatchedPayment[] {
    return [...this.payments.values()];
  }

  on(handler: (e: PaymentEvent) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  /** Re-check every payment that has not reached a final state. Returns the events emitted. */
  async tick(): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];
    const now = this.clock();
    for (const entry of this.payments.values()) {
      if (isFinal(entry.status)) continue;
      const chain = this.chains.find((c) => c.chain === entry.request.asset.chain);
      if (!chain) continue;
      const deposits = await chain.getDeposits(entry.request.address, entry.request.asset.symbol);
      const evaluation = evaluatePayment(entry.request, deposits, now);
      const changed = evaluation.status !== entry.status || evaluation.received !== entry.evaluation.received;
      entry.evaluation = evaluation;
      if (!changed) continue;
      entry.status = evaluation.status;
      const type = EVENT_FOR_STATUS[evaluation.status];
      if (!type) continue;
      events.push({
        id: `evt_${entry.request.id}_${++this.seq}`,
        type,
        paymentId: entry.request.id,
        status: evaluation.status,
        evaluation,
        createdAt: now,
      });
    }
    for (const e of events) for (const h of this.handlers) await h(e);
    return events;
  }
}

/** A status that will not change again without outside action. */
export function isFinal(status: PaymentStatus): boolean {
  return status === 'paid' || status === 'overpaid' || status === 'expired' || status === 'refund_required' || status === 'manual_review';
}
