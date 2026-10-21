# Changelog

All notable changes. The three packages (`@paycryt/core`, `@paycryt/adapters`, `@paycryt/server`) are versioned together.

## 0.1.0 (alpha)

The first release. **Alpha:** a real payment has been completed end to end on Tron mainnet, but nothing here has been security-audited, and EVM and Bitcoin have only been verified reading real deposits. See [SECURITY.md](SECURITY.md).

### What is in it

- **Non-custodial by construction.** Deposit addresses are derived from an extended public key for EVM chains, Tron and Bitcoin; private keys are refused and never echoed.
- **Fair-rate engine** with a hash-chained, tamper-evident audit trail of every price a customer was charged.
- **Payment policies** for underpayment, overpayment and late payment, as a pure function that returns actions for your code to perform.
- **Live chain watchers** for Tron (USDT, real confirmations), EVM chains (ERC-20) and Bitcoin, plus CoinGecko and Binance rate sources.
- **A self-hosted server** (`npx @paycryt/server@alpha`): REST API, multi-tenant merchants with their own wallets, per-key rate limiting, an admin audit log, signed webhooks, and a persistent store. It fails closed: no price or no address check means a 503, never a guess.
- **A web dashboard** at `/`: create payments with a QR code and the exact amount, simulate customers in the sandbox, look up rates, and run the operator's admin tasks.
- **An offline-first POS app** at `/pos`: an installable till that keeps selling with the server down and syncs by itself when the connection returns.
- **Webhook hardening and an opt-in SSRF guard**: secret rotation without downtime, a timeout on every delivery attempt, no redirect following, and a literal-address check on merchant webhook URLs (on by default in live mode). Contributed by [@oasamz09-ctrl](https://github.com/oasamz09-ctrl) in [#2](https://github.com/adebayomoses/paycryt/pull/2).
- **A fake-chain sandbox** for developing without faucets or RPC keys.
- Experimental **Paystack** and **Flutterwave** adapters. Flutterwave M-Pesa collection is verified live; payouts reach the real APIs but are gated by each provider's account verification.

### Known limits

- Only Tron has completed a real create-and-get-paid cycle. See the open issues for EVM and Bitcoin.
- Native ETH and TRX payments are not supported (the watchers read token transfers). A server refuses them rather than accept a payment it could never see.
- The POS service worker is verified in Chrome, not Safari or Firefox.
- No receipts, refunds screen, or multi-cashier support in the POS.
- The webhook-URL guard checks the host as written and does not resolve DNS (documented), and it currently lets two IPv6 forms through: IPv4-compatible `[::127.0.0.1]` and 6to4 `[2002:7f00:1::]`. Practical risk is low on most hosts but it should be closed; see the open issue.

### Fixed along the way

- `OfflinePOS` priced sales at addresses outside its lease after a lease renewal.
- A sale made while online from a cached rate always outlived that rate's lock, so the server refused it.
- `OfflinePOS.sync()` deleted a queued sale when the server answered with something that was not a sync result.
- A live server accepted offline sales in assets its chain watcher could not see (native ETH), which would never have been detected as paid.
- The EVM watcher looked up block timestamps in one batch regardless of size (providers cap batches, and a deposit address can be sprayed with dust transfers to exceed the cap), mishandled a whole-batch rejection with an opaque `TypeError`, and silently treated a missing timestamp as the year 1970, which the payment policy reads as "older than the request" and ignores: a customer who paid in full could be shown as unpaid with no error. Lookups are now chunked (`maxBatchSize`, default 50), replies are validated, and an incomplete answer is an error. Found by reviewing a contributor's note on issue #4.
