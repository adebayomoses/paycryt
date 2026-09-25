# Multi-tenant API keys

One Paycryt server can serve many businesses. The operator holds the **admin key** (`PAYCRYT_API_KEY`); each business, called a **merchant**, gets its own **API key**. A merchant sees only their own payments, events, payouts and devices, is charged their own spread, gets their own policy defaults, and receives webhooks at their own URL signed with their own secret.

The admin key alone keeps working exactly as before, so a single-business deployment doesn't change at all.

## Onboarding a merchant

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" -X POST localhost:8787/v1/admin/merchants -d '{
  "name": "Ada Stores",
  "spreadBps": 50,
  "webhookUrl": "https://ada.example/paycryt-hook",
  "policy": { "expiryMs": 300000, "underpayment": { "toleranceBps": 100 } }
}'
# {
#   "merchant": { "id": "mch_…", "name": "Ada Stores", "keyPrefix": "pk_21aa0e1e", … },
#   "apiKey": "pk_…",                  <- shown once. Hand it to the merchant; it cannot be shown again.
#   "webhookSecret": "whsec_…"         <- shown once, only if a webhookUrl was set
# }
```

The merchant then uses `Authorization: Bearer pk_…` on the same endpoints as always (`/v1/payments`, `/v1/events`, …).

| Endpoint (admin key only) | Purpose |
|---|---|
| `POST /v1/admin/merchants` | Create a merchant. Fields: `name` (required), `webhookUrl`, `webhookSecret`, `spreadBps` (0-5000), `policy`, `wallets`. Unknown fields are rejected. |
| `GET /v1/admin/merchants`, `GET /v1/admin/merchants/:id` | List / read merchants. Never includes keys or secrets. |
| `POST /v1/admin/merchants/:id/rotate-key` | Issue a new key; the old one stops working immediately. |
| `POST /v1/admin/merchants/:id/wallets` | Set (`"evm": "xpub…"`) or remove (`null`) a wallet key; see below. |
| `POST /v1/admin/merchants/:id/disable` / `/enable` | Block or restore a merchant. Their data is kept, and webhooks stop while disabled. |
| `GET /v1/me` (any key) | Who am I: `{ role: 'admin' }` or `{ role: 'merchant', merchant }`. |

## What is isolated

| | A merchant can see | Notes |
|---|---|---|
| Payments (`/v1/payments`) | only their own | Someone else's payment id answers `404`, byte-for-byte the same as an id that doesn't exist, so ids can't be probed. |
| Events, payouts | only their own | |
| Sandbox deposits | only for their own payments | `time`, `mine` and `rates` change every tenant's chain, clock and market, so they are admin-only. |
| Offline devices | only their own | The first key to lease a device owns it. Nobody else can lease, renew or sync it. A device the admin registered can't be claimed by a merchant. |
| Rate audit trail | shared | It holds prices, not anyone's business data, and sharing it keeps one verifiable chain. |
| Webhooks | own endpoint, own secret | A merchant's secret cannot validate anyone else's events (tested). |

The admin key sees everything.

### Offline sync and tenancy

A synced payment belongs to whichever merchant **owns the device**, taken from the server's own record, never from anything the device sends. A device that stamps someone else's `merchantId` on its payments is overridden (tested by a hostile-device test).

## Per-merchant wallets: customers pay the merchant, not the operator

Give each merchant their own **wallet public keys** and every deposit address for that merchant is derived from them, so funds settle straight to the merchant's wallet. The server only ever holds public keys and cannot spend.

```bash
# at creation...
curl -s -H "Authorization: Bearer $ADMIN_KEY" -X POST localhost:8787/v1/admin/merchants -d '{
  "name": "Ada Stores",
  "wallets": { "evm": "xpub…", "tron": "xpub…", "bitcoin": "zpub…" }
}'
# ...or later. Set a family with a key, remove it with null:
curl -s -H "Authorization: Bearer $ADMIN_KEY" -X POST localhost:8787/v1/admin/merchants/mch_…/wallets -d '{ "evm": "xpub…", "tron": null }'
```

| Family | Covers | Key |
|---|---|---|
| `evm` | Ethereum, Base, BNB Chain | account xpub at `m/44'/60'/0'` |
| `tron` | Tron (TRC20) | account xpub at `m/44'/195'/0'` |
| `bitcoin` | Bitcoin | native-SegWit account **zpub** at `m/84'/0'/0'` |

- **Public keys only.** A private key is refused with a clear message, and the message never contains the value pasted, because error text ends up in logs and responses.
- **Each key belongs to one merchant.** A second merchant registering the same key gets `409`, because their customers would be paying the same addresses and payments could no longer be told apart.
- **Only the operator sets wallets.** A merchant key can't change where money goes, so a stolen merchant key can't redirect funds. Merchants can read their own wallets via `/v1/me`.
- **Indexes move forward only.** Each merchant has a counter per family, resumed after a restart from the payments on record, so an address is never handed to two customers. Changing a wallet keeps the counter going; old payments keep their addresses. Chains in one family share a sequence (an Ethereum and a Base payment get different addresses).
- **Outside the sandbox, no wallet means no payments** on that chain (`400`), for both API-created and device-synced payments. The shared fake addresses exist only as a sandbox stand-in.
- **Offline devices are held to the merchant's wallet.** Sync checks each address against the wallet of the merchant that owns the device, so a device deriving from another wallet, or from the sandbox fake, is rejected.

Verified with real vectors: the first EVM address for the standard dev mnemonic is Hardhat's well-known account 0 (`0xf39F…2266`), the Bitcoin one matches `bitcoinjs-lib`, and after a real process restart the next payment continued at Hardhat account 2 (`0x3C44…93BC`).

## Per-merchant settings

- **`spreadBps`**: the merchant's margin against their customers, replacing the server default. `GET /v1/rates/...` returns snapshots priced with it.
- **`policy`**: defaults for that merchant's payments (`expiryMs`, `graceMs`, tolerances, `latePayment`, `lateWatchMs`, ...). A per-request `policy` overrides it **field by field**, including inside `underpayment`/`overpayment`, so overriding one tolerance doesn't reset the rest.
- Policies (merchant defaults and per-request) are **validated**: unknown fields such as a typo `expiry` are rejected instead of silently ignored, and out-of-range values (negative expiry, tolerance over 100%) are refused. Use `validatePolicyOverrides` from `@paycryt/core` in your own server.

## How keys are stored

An API key is 256 bits of randomness (`pk_` + 64 hex characters). The server stores only its **SHA-256 hash**, plus the first few characters so an operator can tell keys apart in a list. A leaked database therefore reveals hashes, not usable keys, and a byte-level search of the SQLite file for a key finds nothing (checked). Because the keys are random rather than chosen, a plain hash is sufficient. There's no password guessing to slow down.

The one secret that must be stored recoverably is the **webhook secret**, because signing needs it. Treat the database as sensitive (see [SECURITY.md](../SECURITY.md)).

## Persistence

Merchants, key hashes and device ownership live in the same `store` as everything else (`SqliteStore` etc.), or in memory if there's none. They survive a restart: verified with a real process restart. A fresh `node` process accepted the merchant's original key, still showed them their payment, hid it from a second merchant, and processed the payment to `paid`.

## Building your own server

`MerchantStore` (in `@paycryt/core`) is a standalone, `KVStore`-backed class: `create`, `authenticate`, `rotateKey`, `setDisabled`, `setWallets`, `list`, `get`. Payment requests carry an optional `merchantId`. `PaycrytServer` is one implementation of the scoping rules above; copy the `canSee` pattern if you write another.

## Known limitations

- **The chain is still the fake chain.** Per-merchant wallets make addresses real-format and merchant-owned, but `PaycrytServer` still watches the sandbox `FakeChain`. For real deposits, build your own server around `@paycryt/core` with a real chain adapter (see [tron.md](tron.md), [evm.md](evm.md), [bitcoin.md](bitcoin.md)); the wallet and tenant logic carries over.
- **Address discovery gap.** The server does not check the chain for a merchant's past use of a wallet before starting at index 0. If you reuse an xpub that already received funds elsewhere, you will start on addresses that may have history.
- **No rate limiting or audit log of admin actions** yet.
- **`webhookUrl` is not filtered for private addresses.** Only the admin sets it, so this is an operator trust decision. If you let merchants set their own, add an SSRF allow/deny check first.
- **No self-service signup.** Merchants are created by the admin only.
