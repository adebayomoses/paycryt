# Roadmap

Status legend: ✅ done · 🚧 next · 💡 idea

## v0.1 (this release): the foundation
- ✅ Offline-first POS: local address derivation, address leases, offline margin, idempotent sync queue, server-side re-verification
- ✅ Fair-rate engine: multi-source median, outlier rejection, spread, hash-chained audit log
- ✅ Underpayment / overpayment / late-payment policy engine + payment watcher
- ✅ Fake-chain sandbox: scenarios, time travel, reference API
- ✅ Signed webhooks with retries and replay
- ✅ Settlement/collection interfaces; experimental Paystack + Flutterwave adapters
- ✅ EVM xpub address derivation (checked against known test vectors)
- ✅ **Tron (TRC20 USDT) support:** `TronXpubDeriver` (address encoding checked byte-for-byte against `tronweb`) and `TronGridChainAdapter`, a real chain watcher against the live TronGrid API. See [docs/tron.md](docs/tron.md). Not yet run against a real, money-moving deposit end to end — test on Shasta/Nile testnet or with small amounts first.
- ✅ **EVM chain support:** `EvmRpcChainAdapter`, a real JSON-RPC chain watcher (ERC-20 `Transfer` logs via `eth_getLogs`, real block-based confirmations). Verified live against Ethereum mainnet — found 173 real USDT deposits to a real address with no mocking. See [docs/evm.md](docs/evm.md). No payment has been created and paid through the full flow end to end yet.
- ✅ **Bitcoin support:** `BtcXpubDeriver` (BIP84 native SegWit, checked byte-for-byte against `bitcoinjs-lib`) and `EsploraChainAdapter`, a real chain watcher over the Esplora REST API (blockstream.info/mempool.space/self-hosted). Verified live against Bitcoin mainnet — 29 real deposits parsed with zero mismatches against an independent recomputation. See [docs/bitcoin.md](docs/bitcoin.md). No payment has been created and paid through the full flow end to end yet.

The three chains this project targets now all have a real, live-verified (if still experimental) address deriver and chain adapter.

## v0.2: make it usable for real
- ✅ **Persistence:** `SqliteStore` (`@paycryt/adapters`, backed by Node's built-in `node:sqlite`) implementing `KVStore`, plus `PaymentRequestStore`/`RateSnapshotStore`/`LeaseRegistryStore` (`@paycryt/core`). Wired into `PaycrytServer` (now `PaycrytServer.create()`, async) so payments, the rate audit trail and address leases all survive a restart. Verified with a genuine process-level restart: a payment created by one `node` process was correctly reloaded and paid by a completely separate process started afterward, over a real SQLite file. See [docs/persistence.md](docs/persistence.md).
- 🚧 A real block-confirmation count for Tron (TronGrid's transfer endpoint only exposes solidified/not; see [docs/tron.md](docs/tron.md#confirmations))
- ✅ **`IndexedDbStore`:** a real `KVStore` for browser/WebView POS devices (`@paycryt/adapters`). Verified in a real browser via an import map (no bundler): get/set/overwrite/delete/prefix-scan, and that data survives a real page navigation to a fresh document, read back by a brand-new store instance with `bigint` fields intact. React Native/AsyncStorage still needs its own implementation (same four-method interface).
- ✅ **Late-watch window:** `PaymentWatcher` keeps polling an address for `policy.lateWatchMs` (default 24h) after a payment finalizes, so a deposit that lands after the deadline — or extra stray funds on an already-`paid` payment — is still caught and flagged for refund/review instead of vanishing silently. Verified live against the sandbox server: a payment marked `expired`, then paid 5 minutes later, correctly transitioned to `refund_required` with the refund action attached. See [docs/payment-policies.md](docs/payment-policies.md#catching-deposits-after-finalization-the-late-watch-window).
- 🚧 Multi-tenant API keys and per-merchant policies
- 🚧 Verify Paystack/Flutterwave adapters against live sandboxes; add provider webhooks for payout status

## v0.3: reach
- 💡 More rails: M-Pesa Daraja, MTN MoMo API, Airtel Money, Moniepoint, Opay
- 💡 Payment links + hosted-checkout static template (self-hostable, no server needed)
- 💡 Typed SDK generation from an OpenAPI spec (Python, PHP)
- 💡 Reconciliation reports and CSV export
- 💡 Signed rate snapshots (Ed25519) so devices can prove a snapshot came from your server offline
- 💡 Fee/commission splits for agent networks
- 💡 Solana Pay and Lightning

Want to work on one? Open an issue first so we can agree on the approach. See [CONTRIBUTING.md](CONTRIBUTING.md).
