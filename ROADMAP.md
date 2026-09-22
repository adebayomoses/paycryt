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

## v0.2: make it usable for real
- 🚧 **Bitcoin support:** chain adapter and a zpub address deriver
- 🚧 A real block-confirmation count for Tron (TronGrid's transfer endpoint only exposes solidified/not; see [docs/tron.md](docs/tron.md#confirmations))
- 🚧 `SqliteStore` and `IndexedDbStore` for `KVStore`; a persistent `PaymentStore` so the server survives restarts
- 🚧 Late-watch window: keep polling finalised addresses for stray deposits
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
