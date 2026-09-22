# Security policy

Paycryt is payments software. Please treat security reports seriously and privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository, and include steps to reproduce. We aim to acknowledge within 72 hours.

## Security model (what the code assumes)

- **Non-custodial.** Servers and POS devices hold an extended *public* key (xpub) only. `EvmXpubDeriver` refuses extended private keys. Keep the mnemonic offline; `generateWalletMnemonic` / `evmAccountXpub` are setup-time helpers, not for production servers.
- **Devices are untrusted.** `SyncReceiver` re-derives addresses, re-verifies rate hashes and recomputes amounts. If you write your own sync endpoint, do the same.
- **Webhooks are signed** (HMAC-SHA256 with a timestamp). Always verify with `verifyWebhook` on the raw body and reject old timestamps.
- **Provider credentials** (Paystack, Flutterwave secret keys) belong in environment variables or a secret manager, never in the repo or on POS devices.

## Known gaps (alpha)

- The reference server is in-memory and has a single shared API key. It is a starting point, not a hardened service.
- Two real chain adapters exist (Tron/TRC20 via TronGrid, and EVM chains via JSON-RPC), and both are experimental. The EVM adapter has been checked live against Ethereum mainnet with no mocking (real deposits found, real confirmations computed); the Tron one is verified against live TronGrid responses and a reference address-derivation library. Neither has been run through a full create-payment-and-get-paid flow end to end. Bitcoin has no adapter yet. The fake chain must never be used to decide real payments.
- Bank/mobile-money adapters are experimental and unverified against live providers.
- Late deposits to already-finalised addresses are not detected (see docs/payment-policies.md).

## Your responsibilities

You are responsible for licences, KYC/AML and tax obligations in the jurisdictions you operate in, and for securing your infrastructure, keys and provider accounts.
