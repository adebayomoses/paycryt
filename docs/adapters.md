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

> **Experimental.** These are written against the providers' public docs and tested with mocked HTTP only. Use each provider's test keys first and re-read their current docs before moving real money.

| Adapter | Payout | Collection | Notes |
|---|---|---|---|
| `PaystackAdapter` | bank (NUBAN), mobile money | mobile money | Minor units. References must be unique per transfer; Paystack has its own reference format rules. |
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
