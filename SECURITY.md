# Security policy

Paycryt is payments software. Please treat security reports seriously and privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository, and include steps to reproduce. We aim to acknowledge within 72 hours.

## Security model (what the code assumes)

- **Non-custodial.** Servers and POS devices hold an extended *public* key (xpub/zpub) only. `EvmXpubDeriver`, `TronXpubDeriver` and `BtcXpubDeriver` all refuse extended private keys. Keep the mnemonic offline; `generateWalletMnemonic` and the `*AccountXpub`/`btcAccountZpub` helpers are setup-time helpers, not for production servers.
- **Devices are untrusted.** `SyncReceiver` re-derives addresses, re-verifies rate hashes and recomputes amounts, and also refuses a device-supplied asset description, policy, over-long expiry or reused payment id (see docs/offline-pos.md). If you write your own sync endpoint, do the same, and pass `policyFor` and `lookupRequest`: a receiver without them still trusts the device's own policy and can be pointed at an existing payment id.
- **Webhooks are signed** (HMAC-SHA256 with a timestamp). Always verify with `verifyWebhook` on the raw body and reject old timestamps. `verifyWebhook` accepts an array of secrets (and a header with several `v1=` values), so you can rotate a secret without downtime. Deliveries time out after 10 s per attempt and never follow redirects.
- **Provider credentials** (Paystack, Flutterwave secret keys) belong in environment variables or a secret manager, never in the repo or on POS devices.
- **Wallets are public keys only, and only the operator sets them.** Merchant wallet keys are xpubs/zpubs; a private key is refused and never echoed. A merchant key cannot change where its customers pay, so a stolen merchant key can't redirect funds. Protect the admin key accordingly, because whoever holds it can.
- **API keys are stored hashed.** Merchant keys are 256-bit random values kept only as SHA-256 hashes; the admin key (`PAYCRYT_API_KEY`) is configuration, not stored. Merchant **webhook secrets** must be stored recoverably (signing needs them), and merchant-supplied `webhookUrl`s are only filtered for private addresses if you enable `blockPrivateWebhookUrls`. Only the admin can set them. An opt-in literal-address SSRF guard exists (`blockPrivateWebhookUrls`, on by default in the CLI's live mode) but it does not resolve DNS, so keep egress restricted at the network layer before ever letting merchants set their own. See [docs/multi-tenant.md](docs/multi-tenant.md).
- **A persisted store is sensitive data.** If you configure `SqliteStore`, `IndexedDbStore` (or your own `KVStore`) for `PaycrytServer` or `OfflinePOS`, it holds your complete payment history and rate audit trail. For `SqliteStore`, restrict filesystem permissions on the database file, back it up somewhere access-controlled, and never commit it to source control. For `IndexedDbStore`, remember it's per-origin browser storage, readable by any script running on that origin — the usual web same-origin protections are what's standing between it and other code, same as any other client-side data. See [docs/persistence.md](docs/persistence.md).

## Known gaps (alpha)

- **Rate limiting and an admin audit log** are built in (per-key request limits, a per-IP limiter on failed authentication, and `GET /v1/admin/audit` recording merchant lifecycle changes). Both are off by default in `ServerConfig`, but the CLI (`packages/server/src/cli.ts`) turns sane defaults on so a server started from it is protected without extra configuration; see [docs/live-server.md](docs/live-server.md#rate-limiting-and-the-audit-log). Neither is persisted-and-alerted the way a production deployment would want (rate-limit buckets reset on restart; nothing pages you when the audit log grows) — it is a starting point, not a hardened service.
- Live mode (`PAYCRYT_SANDBOX=false`) watches real chains and prices, and refuses to run on fake chains or made-up prices, but it has not moved real money end to end (see docs/live-server.md). Free public RPC nodes are unreliable; live mode fails closed (503, no address issued) rather than guess. Merchant API keys are stored hashed and tenants are isolated (see docs/multi-tenant.md). `node:sqlite` (used by `SqliteStore`) is itself an experimental Node API, and needs Node 22.5+ (see CONTRIBUTING.md).
- Three real chain adapters exist (Tron/TRC20 via TronGrid, EVM chains via JSON-RPC, Bitcoin via the Esplora REST API), and all are experimental. The EVM and Bitcoin adapters have each been checked live against their real mainnets with no mocking (real deposits found, real confirmations computed, cross-checked against an independent recomputation); the Tron one is verified against live TronGrid responses and a reference address-derivation library. A full create-payment-and-get-paid cycle has been completed for real on Tron (a real exchange withdrawal, correctly derived, priced, detected and confirmed — see docs/live-server.md); EVM and Bitcoin have not yet had a real payment run through the full flow, only real deposits read. The fake chain must never be used to decide real payments.
- Bank/mobile-money adapters are experimental and unverified against live providers.
- Late deposits to an already-finalised address are only caught within `policy.lateWatchMs` (default 24h) of finalization; after that the watcher permanently stops polling that address (see docs/payment-policies.md).

## Your responsibilities

You are responsible for licences, KYC/AML and tax obligations in the jurisdictions you operate in, and for securing your infrastructure, keys and provider accounts.
