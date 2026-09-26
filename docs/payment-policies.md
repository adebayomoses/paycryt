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
  lateWatchMs: 24 * 60 * 60_000,                             // how long PaymentWatcher keeps polling after finalization
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

Events are emitted only when the status, the confirmed amount, or the late-arrived amount changes, and carry a stable `id` so webhook receivers can de-duplicate.

### When a chain lookup fails

Real chain adapters fail sometimes: a rate-limited API (`429`), an unreachable node. One payment's failure never stops the others.

- `tick()` catches a failing lookup per payment, keeps that payment's last known state, and carries on with the rest; the failed one is simply retried next tick.
- `watcher.get(id).lastError` holds the most recent failure (`{ message, at }`) and is cleared by the next successful check.
- `watcher.onError((error, { paymentId, stage }) => …)` is called for each failure, where `stage` is `"chain"` (a lookup) or `"handler"` (one of your event handlers threw). Use it for logging and alerting. `PaycrytServer` logs these.
- A throwing event handler no longer blocks the other handlers or later events, and a throwing error handler can't break the watcher either.

Before this, a single failed lookup aborted the whole `tick()`: every payment after it was skipped and the events already collected were dropped.

## Catching deposits after finalization (the late-watch window)

A payment reaching a final status (`paid`, `overpaid`, `expired`, `refund_required`, `manual_review`) doesn't mean the watcher stops caring about its address immediately. It keeps polling for `policy.lateWatchMs` (default 24h) past the moment of finalization, specifically to catch a customer who pays after the deadline, or extra stray funds on an address you'd already closed the book on:

- If it was `expired` (nothing received) and a deposit shows up within the window, it flips to `refund_required` (or `manual_review`, per `latePayment`) — the same as if the deposit had arrived right at expiry.
- If it was already `paid` and *more* money shows up within the window, the status stays `paid` (the original obligation was met on time), but the event's `actions` gains a `late_payment` refund/review entry for the extra amount, and a new event fires because `late` changed even though `status` didn't.

Once `lateWatchMs` has fully elapsed since finalization, the watcher permanently stops polling that address — a deposit arriving after that point is not detected. Set `lateWatchMs` higher for slower-moving payment flows, or lower to bound how many addresses stay actively polled.
