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
  /** When this payment first reached a final status. Undefined while still open. */
  finalizedAt?: number;
  /** The most recent failure to check this payment's chain, cleared by the next successful check. */
  lastError?: { message: string; at: number };
}

export type WatcherErrorHandler = (error: unknown, context: { paymentId: string; stage: 'chain' | 'handler' }) => void;

/**
 * Polls chains for each open payment and emits an event whenever its status changes.
 * Call `tick()` on a timer (production) or after each simulated action (tests, sandbox).
 */
export class PaymentWatcher {
  private readonly payments = new Map<string, WatchedPayment>();
  private handlers: Array<(e: PaymentEvent) => void | Promise<void>> = [];
  private errorHandlers: WatcherErrorHandler[] = [];
  private seq = 0;

  private tickQueue: Promise<unknown> = Promise.resolve();
  private readonly concurrency: number;

  constructor(
    private readonly chains: ChainAdapter[],
    private readonly clock: () => number = Date.now,
    options: { concurrency?: number } = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  }

  watch(request: PaymentRequest): void {
    if (this.payments.has(request.id)) return;
    const now = this.clock();
    const evaluation = evaluatePayment(request, [], now);
    this.payments.set(request.id, { request, status: evaluation.status, evaluation, finalizedAt: isFinal(evaluation.status) ? now : undefined });
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

  /**
   * Called when checking a payment's chain fails (a rate-limited or unreachable node) or an event handler
   * throws. One bad payment or handler never stops the others: the tick carries on, and the failed payment
   * is simply retried on the next tick.
   */
  onError(handler: WatcherErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  private reportError(error: unknown, paymentId: string, stage: 'chain' | 'handler'): void {
    for (const h of this.errorHandlers) {
      try {
        h(error, { paymentId, stage });
      } catch {
        /* an error handler must not break the watcher either */
      }
    }
  }

  /**
   * Re-check every payment that is still open, plus any recently-finalized one still inside its
   * `policy.lateWatchMs` window (so a stray deposit that lands after a payment closed is still caught).
   * Returns the events emitted.
   */
  tick(): Promise<PaymentEvent[]> {
    // Ticks run one at a time. A real chain check can take seconds and callers fire ticks on a timer, so
    // overlapping ticks would (1) pile up unbounded concurrent requests against a slow or rate-limited API, and
    // (2) let an older lookup finish AFTER a newer one and overwrite fresh state with a stale view, e.g. a payment
    // already seen as paid regressing to awaiting_payment. A caller that awaits its tick after making a change
    // still gets a full pass that starts after the change.
    const run = this.tickQueue.then(() => this.runTick());
    this.tickQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTick(): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];
    const now = this.clock();
    const due = [...this.payments.values()].filter((entry) => !isFinal(entry.status) || this.withinLateWatch(entry, now));
    await forEachLimited(due, this.concurrency, async (entry) => {
      const wasFinal = isFinal(entry.status);
      const chain = this.chains.find((c) => c.chain === entry.request.asset.chain);
      if (!chain) return;
      let deposits;
      try {
        deposits = await chain.getDeposits(entry.request.address, entry.request.asset.symbol);
        entry.lastError = undefined;
      } catch (err) {
        entry.lastError = { message: err instanceof Error ? err.message : String(err), at: now };
        this.reportError(err, entry.request.id, 'chain');
        return; // keep the last known state; try again next tick
      }
      const evaluation = evaluatePayment(entry.request, deposits, now);
      const changed =
        evaluation.status !== entry.status || evaluation.received !== entry.evaluation.received || evaluation.late !== entry.evaluation.late;
      entry.evaluation = evaluation;
      if (!changed) return;
      entry.status = evaluation.status;
      if (!wasFinal && isFinal(evaluation.status)) entry.finalizedAt = now; // start the late-watch window from the first finalization
      const type = EVENT_FOR_STATUS[evaluation.status];
      if (!type) return;
      events.push({
        id: `evt_${entry.request.id}_${++this.seq}`,
        type,
        paymentId: entry.request.id,
        status: evaluation.status,
        evaluation,
        createdAt: now,
      });
    });
    for (const e of events) {
      for (const h of this.handlers) {
        try {
          await h(e);
        } catch (err) {
          this.reportError(err, e.paymentId, 'handler'); // a failing handler doesn't block the others or later events
        }
      }
    }
    return events;
  }

  private withinLateWatch(entry: WatchedPayment, now: number): boolean {
    return entry.finalizedAt !== undefined && now - entry.finalizedAt <= entry.request.policy.lateWatchMs;
  }
}

/** A status that will not change again without outside action. */
export function isFinal(status: PaymentStatus): boolean {
  return status === 'paid' || status === 'overpaid' || status === 'expired' || status === 'refund_required' || status === 'manual_review';
}

/** Runs `fn` over `items` with at most `limit` in flight. Never rejects on its own: `fn` is expected to handle its errors. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}
