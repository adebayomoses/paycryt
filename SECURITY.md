# Security policy

Paycryt is payments software. Please treat security reports seriously and privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository, and include steps to reproduce. We aim to acknowledge within 72 hours.

## Security model (what the code assumes)

- **Non-custodial.** Servers and POS devices hold an extended *public* key (xpub/zpub) only. `EvmXpubDeriver`, `TronXpubDeriver` and `BtcXpubDeriver` all refuse extended private keys. Keep the mnemonic offline; `generateWalletMnemonic` and the `*AccountXpub`/`btcAccountZpub` helpers are setup-time helpers, not for production servers.
- **Devices are untrusted.** `SyncReceiver` re-derives addresses, re-verifies rate hashes and recomputes amounts. If you write your own sync endpoint, do the same.
- **Webhooks are signed** (HMAC-SHA256 with a timestamp). Always verify with `verifyWebhook` on the raw body and reject old timestamps.
- **Provider credentials** (Paystack, Flutterwave secret keys) belong in environment variables or a secret manager, never in the repo or on POS devices.
- **A persisted store is sensitive data.** If you configure `SqliteStore` (or your own `KVStore`) for `PaycrytServer` or `OfflinePOS`, the resulting file holds your complete payment history and rate audit trail. Restrict filesystem permissions on it, back it up somewhere access-controlled, and never commit it to source control. See [docs/persistence.md](docs/persistence.md).

## Known gaps (alpha)

- The reference server has a single shared API key regardless of whether persistence is enabled. It is a starting point, not a hardened service. `node:sqlite` (used by `SqliteStore`) is itself an experimental Node API.
- Three real chain adapters exist (Tron/TRC20 via TronGrid, EVM chains via JSON-RPC, Bitcoin via the Esplora REST API), and all are experimental. The EVM and Bitcoin adapters have each been checked live against their real mainnets with no mocking (real deposits found, real confirmations computed, cross-checked against an independent recomputation); the Tron one is verified against live TronGrid responses and a reference address-derivation library. None has been run through a full create-payment-and-get-paid flow end to end. The fake chain must never be used to decide real payments.
- Bank/mobile-money adapters are experimental and unverified against live providers.
- Late deposits to an already-finalised address are only caught within `policy.lateWatchMs` (default 24h) of finalization; after that the watcher permanently stops polling that address (see docs/payment-policies.md).

## Your responsibilities

You are responsible for licences, KYC/AML and tax obligations in the jurisdictions you operate in, and for securing your infrastructure, keys and provider accounts.
