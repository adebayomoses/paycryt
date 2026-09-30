# Local fiat & mobile-money adapters

Paycryt talks to fiat rails through two small interfaces (in `@paycryt/core`):

```ts
interface SettlementProvider {          // off-ramp: pay fiat OUT
  payout(req: PayoutRequest): Promise<PayoutResult>;
  getPayout(reference: string, providerRef?: string): Promise<PayoutResult>;
}
interface CollectionProvider {          // on-ramp: collect fiat IN
  collect(req: CollectionRequest): Promise<CollectionResult>;
  getCollection(reference: string, providerRef?: string): Promise<CollectionResult>;
}
```

`Destination` is either a bank account (`bankCode` + `accountNumber`) or a mobile-money wallet (`operator` + `phone`). Amounts are bigint minor units.

## Bundled adapters (`@paycryt/adapters`)

> **Experimental, partially verified live.** Written against the providers' public docs; the status-check paths (`getPayout`/`getCollection`) and Flutterwave's M-Pesa collection have been run against real sandbox APIs (not mocked), which found and fixed two real bugs — see below. The `payout()` paths reach the real APIs correctly but haven't completed successfully on any account, because both providers gate that behind dashboard-level account settings (also below). Use each provider's test keys first and re-read their current docs before moving real money.

### Verified live, and two bugs it found

Run with `PAYSTACK_TEST_KEY=sk_test_... FLUTTERWAVE_TEST_KEY=FLWSECK_TEST-... npx vitest run live-fiat` (skipped without those env vars, so CI never needs real credentials — see `packages/adapters/test/live-fiat.test.ts`).

- **`getPayout`/`getCollection` on an unknown reference now return `{ status: 'failed' }` instead of throwing.** Both adapters used to throw on any non-2xx response, including a plain "nothing here yet" lookup. That's a real, expected outcome for a status check (the same as `MockSettlementProvider` already reported it), not an exception — confirmed live: Paystack answers HTTP 404 with `code: "not_found"`; Flutterwave is inconsistent with itself, HTTP 404 for `/transfers/:id` but HTTP 400 with a "not found"-worded message for `verify_by_reference`. A real error (bad key, rate limit) still throws.
- **`PaystackAdapter`'s mobile-money `collect()` sent the operator code lowercased** (`mtn`); Paystack's own `GET /bank?currency=GHS&type=mobile_money` returns the codes uppercase (`MTN`, `ATL`, `VOD`). Fixed to pass the code through as given.
- **Flutterwave M-Pesa (KES) collection works end to end against the sandbox**, confirmed with a real STK-push charge against Safaricom Daraja's published test number, returning `pending_customer_action` with a real provider reference.

### Not fully verified — blocked by the provider's own account settings, not the code

- **Paystack `payout()`** reaches the real API with correctly-shaped requests (recipient creation succeeds; the error comes from the `/transfer` step itself) but is refused with *"You cannot initiate third party payouts as a starter business"* — a Paystack business-verification tier, changed from their dashboard, not from here.
- **Paystack `collect()` on GHS/KES** could not be exercised: the test account used was Nigeria/NGN-scoped, and Paystack's mobile-money charge type is Ghana/Kenya-only. Needs a Ghana- or Kenya-scoped Paystack test business to verify. Relatedly, `PaystackAdapter.collect()` only implements mobile money — it has no NGN-native rail (card, bank transfer, USSD) at all, which is a real gap worth closing given Paystack's core market is Nigeria.
- **Flutterwave `payout()`** reaches the real API but is refused with *"Please enable IP Whitelisting to access this service"* — a dashboard security setting, not a code path.

If you have accounts that clear these (a verified Paystack business, or Flutterwave with IP whitelisting configured), running the live suite again would complete the payout-path verification.

| Adapter | Payout | Collection | Notes |
|---|---|---|---|
| `PaystackAdapter` | bank (NUBAN), mobile money | mobile money (Ghana/Kenya only — no NGN collection rail yet) | Minor units. References must be unique per transfer; Paystack has its own reference format rules. |
| `FlutterwaveAdapter` | bank, mobile money (e.g. `MPS` M-Pesa, `MTN`) | M-Pesa (KES), Ghana mobile money | Takes **major** units; the adapter converts. Needs the transfer `id` (`providerRef`) to check status. |
| `MockSettlementProvider` (core) | instant success/failure | – | For the sandbox and tests. |

```ts
import { PaystackAdapter } from '@paycryt/adapters';
const paystack = new PaystackAdapter(process.env.PAYSTACK_SECRET!, fetch);

const orchestrator = new SettlementOrchestrator(
  paystack,
  { destination: { type: 'bank', bankCode: '058', accountNumber: '0123456789' }, feeBps: 100 },
  (id) => watcher.get(id)?.request,
);
watcher.on(orchestrator.handle);   // confirmed payment → fiat payout, once
```

`SettlementOrchestrator` derives the payout reference from the payment id (`settle_<paymentId>`), so a replayed event can never pay twice, provided your provider honours idempotent references.

## Rate sources

`CoinGeckoRateProvider`, `BinanceRateProvider` and `ParallelMarketRateProvider` (wrap any async function, e.g. scrape a P2P board or read a sheet) all implement `RateProvider`. Combine several in `RateEngine`; see [fair-rate.md](fair-rate.md).

## Writing your own adapter

1. Implement `SettlementProvider` and/or `CollectionProvider`.
2. Accept a `FetchLike` in the constructor so you can test with a fake (see `packages/adapters/test/adapters.test.ts`).
3. Map the provider's statuses onto `pending | processing | succeeded | failed` and never swallow errors. A failed call must throw or return `failed`.
4. Use `request.reference` as the provider's idempotency key.
5. Open a PR. New rails (Moniepoint, Opay, Wave, Airtel Money, bank APIs) are very welcome.
