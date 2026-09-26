# Paycryt

**Open-source, self-hostable crypto payments toolkit built for unstable networks and local fiat rails.**

Most crypto payment tools assume always-on internet, US/EU banks and one clean exchange rate. Paycryt is built for the opposite: shops with flaky connections, customers who pay the wrong amount, and money that ends up in Paystack, Flutterwave or a mobile-money wallet.

You bring the accounts and keys. Paycryt never holds funds, and there is nothing to host on our side.

> **Status: alpha (0.1).** The core logic is tested and the sandbox is complete. All three targeted chains now have a real, live-verified address deriver and chain adapter: [Tron/TRC20](docs/tron.md), [EVM](docs/evm.md) and [Bitcoin](docs/bitcoin.md) — the EVM and Bitcoin ones were each checked, unmocked, against their real mainnets (173 real USDT deposits found on Ethereum; 29 real BTC deposits found and independently cross-checked). None has been run through a full create-payment-and-get-paid flow end to end, and the Paystack/Flutterwave fiat adapters are experimental. Do not point it at real money without your own review.

## What makes it different

| | |
|---|---|
| **Offline-first POS** | A till keeps creating payment requests with no internet: addresses are derived locally from an xpub, prices come from a cached rate plus a safety margin, and everything reconciles on sync. The server re-verifies every request and trusts nothing the device says. → [docs](docs/offline-pos.md) |
| **Local fiat & mobile-money adapters** | Off-ramp and on-ramp through interfaces, with experimental Paystack and Flutterwave adapters (bank + MTN MoMo / M-Pesa style wallets). → [docs](docs/adapters.md) |
| **Fair-rate audit trail** | Every price a customer is charged is a hash-sealed, hash-chained snapshot: the sources, the outliers dropped, the median, your spread. Anyone can re-verify it later. → [docs](docs/fair-rate.md) |
| **Underpayment & overpayment handling** | Tolerances, grace windows, top-ups, credits and refunds, expressed as a pure function that returns *actions* for your app to perform. A configurable late-watch window keeps catching stray deposits on an address for up to 24h (default) after a payment closes, instead of going silent the instant it finalizes. → [docs](docs/payment-policies.md) |
| **Local fake-chain sandbox** | One command gives you a fake blockchain and a full API. Simulate exact, short, over, split, late and unconfirmed payments; fast-forward time; move rates. No faucets, no RPC keys. → [docs](docs/sandbox.md) |
| **Tron (TRC20 USDT)** | A real, non-custodial address deriver and a real chain watcher against the live TronGrid API, with real block-depth confirmations checked against the live chain — the rail most Nigerian/Ghanaian USDT payments actually use. Experimental. → [docs](docs/tron.md) |
| **EVM chains (Ethereum, Base, BNB Chain)** | A real chain watcher over JSON-RPC — `eth_getLogs` for ERC-20 transfers, real block-based confirmations, no indexer needed. Checked live against Ethereum mainnet: found 173 real USDT deposits with no mocking. Experimental. → [docs](docs/evm.md) |
| **Bitcoin (native SegWit)** | A real, non-custodial BIP84 address deriver and a chain watcher over the Esplora REST API (blockstream.info, mempool.space, or self-hosted). Checked live against Bitcoin mainnet: 29 real deposits parsed, matched exactly against an independent recomputation. Experimental. → [docs](docs/bitcoin.md) |
| **Multi-tenant API keys** | One server, many businesses: an admin key onboards merchants, each with their own key (stored only as a hash), spread, policy defaults, webhook secret and **own wallet keys, so customers pay the merchant directly**. A merchant sees only their own payments, events, payouts and devices; someone else's payment id answers exactly like a missing one. Isolation is mutation-tested and survives a real restart. Offline sync now also refuses a device that forges its own asset, policy, expiry or payment id. → [docs](docs/multi-tenant.md) |
| **Persistence** | `SqliteStore` (`node:sqlite`, no native dependency) for `OfflinePOS` and the reference server — payments, the rate audit trail and address leases all survive a restart. Verified with a real process restart: a fresh `node` process reloaded and paid a payment created by a different, already-killed process. `IndexedDbStore` covers the browser/WebView side of `OfflinePOS`, verified with a real page navigation. → [docs](docs/persistence.md) |

## Try it in two minutes

```bash
npm install
npm run build
npm test                # 219 tests
npm run demo:offline    # a POS sells while offline, then syncs
npm run sandbox         # API + fake chain on http://127.0.0.1:8787
```

With the sandbox running:

```bash
H='Authorization: Bearer sandbox_key'
# 1. create a NGN 15,000 payment payable in USDT
curl -s -H "$H" -X POST localhost:8787/v1/payments \
  -d '{"amount":"15000","currency":"NGN","asset":"USDT_TRC20"}'
# 2. the customer pays only 60%...
curl -s -H "$H" -X POST localhost:8787/v1/sandbox/deposit \
  -d '{"paymentId":"<id>","scenario":"underpay","percent":60}'
# 3. ...status is now partially_paid, with a request_topup action
curl -s -H "$H" localhost:8787/v1/payments/<id>
```

## Use it as a library

```ts
import {
  ASSETS, EvmXpubDeriver, MemoryStore, OfflinePOS, RateEngine, StaticRateProvider,
} from '@paycryt/core';

const engine = new RateEngine({
  providers: [new StaticRateProvider('exchange', { 'USDT/NGN': '1498' }),
              new StaticRateProvider('street',   { 'USDT/NGN': '1506' })],
  spreadBps: 100,
});

const pos = new OfflinePOS({
  deviceId: 'till-1',
  deriver: new EvmXpubDeriver(process.env.XPUB!), // xpub only: no private keys on the device
  lease: { start: 0, end: 500 },
  store: new MemoryStore(),                       // swap for @paycryt/adapters' SqliteStore in production
});

await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);   // online, once in a while
const { request, uri } = await pos.createPayment({                // works with no internet
  fiat: { currency: 'NGN', amountMinor: 1_500_000n },
  asset: ASSETS.USDT_ERC20,
});
// show `uri` as a QR code; later: await pos.sync(transport)
```

## How it fits together

```
        POS device (offline-capable)                     Your server (self-hosted)
  ┌────────────────────────────────┐              ┌───────────────────────────────────┐
  │ OfflinePOS                     │   sync       │ SyncReceiver  ── re-verifies ──┐  │
  │  · xpub → address (no network) │ ───────────▶ │  address · lease · rate hashes │  │
  │  · cached rate + margin        │              │  amount due recomputed         │  │
  │  · queue (idempotent ops)      │              ├────────────────────────────────┘  │
  └────────────────────────────────┘              │ RateEngine  →  RateAuditLog (hash chain)
                                                  │ PaymentWatcher ─ ChainAdapter (FakeChain │ TronGrid │ EVM RPC │ Esplora)
                                                  │ evaluatePayment (policy)  →  events/webhooks
                                                  │ SettlementOrchestrator → Paystack │ Flutterwave │ …
                                                  └───────────────────────────────────┘
```

## Packages

| Package | What it is |
|---|---|
| [`@paycryt/core`](packages/core) | The library: amounts, HD address derivation, rate engine + audit log, payment policy, watcher, fake chain, offline POS + sync receiver, webhooks, settlement interfaces. Runs in Node and browsers. |
| [`@paycryt/adapters`](packages/adapters) | Optional: CoinGecko, Binance and parallel-market rate sources; live Tron/TRC20, EVM and Bitcoin chain adapters; `SqliteStore` and `IndexedDbStore` `KVStore`s; Paystack and Flutterwave (all experimental). |
| [`@paycryt/server`](packages/server) | Optional reference API with the built-in sandbox. Runs in-memory by default; pass a `store` to `PaycrytServer.create()` and it survives restarts. Still a starting point, not a production service. |
| [`examples/offline-pos`](examples/offline-pos) | Runnable end-to-end demo. |

Use only what you need. Install the library from npm, or fork the repo and self-host the server.

## Design rules

- **No floats for money.** Amounts are `bigint` minor units; rates are `bigint` scaled by 1e18; the customer-side rounding always goes in the merchant's favour.
- **Non-custodial by construction.** The API refuses extended *private* keys; devices and servers only ever see an xpub.
- **Decisions are data.** Policies return `PolicyAction`s (`refund`, `credit`, `request_topup`, ...). Your code moves the money, so behaviour is testable and auditable.
- **Trust nothing from a device.** Offline requests are re-derived, re-priced and re-hashed on sync.

## Disclaimer

Paycryt is software, not a financial service. You are responsible for the licences, KYC/AML, tax and other regulatory obligations that apply where you operate, and for the security of your keys and infrastructure. See [SECURITY.md](SECURITY.md). No warranty; see [LICENSE](LICENSE).

## License

[MIT](LICENSE)
