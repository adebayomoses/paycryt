# Underpayment & overpayment handling

Real customers send the wrong amount, pay in pieces, or pay late. `evaluatePayment()` is a **pure function**: given the request, the deposits seen on-chain, the time and the policy, it returns a status and a list of actions. Your app performs the actions (refund, credit, ask for a top-up); Paycryt never moves money on its own.

```ts
const e = evaluatePayment(request, deposits, Date.now());
// { status: 'partially_paid', received, pending, shortfall, excess, late, actions: [...] }
```

## Policy

```ts
withPolicy({
  minConfirmations: 1,
  expiryMs: 15 * 60_000,       // request lifetime
  graceMs: 10 * 60_000,        // deposits up to this long after expiry still count, at the locked rate
  underpayment: { toleranceBps: 50, onExpiry: 'refund' },   // 'refund' | 'accept_partial' | 'manual_review'
  overpayment:  { toleranceBps: 50, action: 'credit' },     // 'keep' | 'credit' | 'refund' | 'manual_review'
  latePayment: 'refund',                                    // 'refund' | 'manual_review'
});
```

## Statuses and actions

| Situation | Status | Actions |
|---|---|---|
| Nothing yet | `awaiting_payment` | none |
| Enough seen but not confirmed | `confirming` | none |
| Short by more than tolerance, still open | `partially_paid` | `request_topup {remaining}` |
| Confirmed total within tolerance of the amount due | `paid` | none |
| Confirmed total above due + tolerance | `overpaid` | per `overpayment.action`: `credit`, `refund` (the excess) or `manual_review`; `keep` adds none |
| Still short after expiry + grace | `refund_required` / `paid` / `manual_review` | per `underpayment.onExpiry`: `refund` (what was received), accept, or review |
| Deposit arrived after expiry + grace | `refund_required` if nothing else was received on time | `refund` (reason `late_payment`) or `manual_review`, per `latePayment` |
| Never paid | `expired` | none |

Tolerances are basis points of the amount due. A 50 bps tolerance on 10 USDT forgives 0.05 USDT, enough to absorb a wallet that deducted a fee from the amount. Split payments simply add up.

## The `PaymentWatcher`

```ts
const watcher = new PaymentWatcher([chainAdapter]);
watcher.on(event => …);        // payment.detected | partially_paid | confirmed | overpaid | expired | refund_required | manual_review
watcher.watch(request);
setInterval(() => watcher.tick(), 5_000);
```

Events are emitted only when the status or confirmed amount changes, and carry a stable `id` so webhook receivers can de-duplicate.

## Webhooks

`WebhookDispatcher` POSTs events with a Stripe-style header `paycryt-signature: t=<unix>,v1=<hmac-sha256>`, retries with backoff (1s, 5s, 30s, 5min, 30min), keeps a delivery log, and supports `replay(eventId)`. Verify on the receiving side with `verifyWebhook(secret, rawBody, header)`, which also rejects deliveries older than 5 minutes.

## Known limitation

The watcher stops polling a payment once it reaches a final status (`paid`, `overpaid`, `expired`, `refund_required`, `manual_review`). A deposit sent to an address *after* its request expired and was finalised is therefore not detected. Operators should periodically sweep or scan old addresses. A configurable "late-watch" window is on the [roadmap](../ROADMAP.md).
