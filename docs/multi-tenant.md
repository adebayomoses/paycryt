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
| `POST /v1/admin/merchants` | Create a merchant. Fields: `name` (required), `webhookUrl`, `webhookSecret`, `spreadBps` (0-5000), `policy`. Unknown fields are rejected. |
| `GET /v1/admin/merchants`, `GET /v1/admin/merchants/:id` | List / read merchants. Never includes keys or secrets. |
| `POST /v1/admin/merchants/:id/rotate-key` | Issue a new key; the old one stops working immediately. |
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

`MerchantStore` (in `@paycryt/core`) is a standalone, `KVStore`-backed class: `create`, `authenticate`, `rotateKey`, `setDisabled`, `list`, `get`. Payment requests carry an optional `merchantId`. `PaycrytServer` is one implementation of the scoping rules above; copy the `canSee` pattern if you write another.

## Known limitations

- **One shared address deriver.** In the sandbox all merchants draw addresses from the same fake deriver. For real chains you would want each merchant's payments to derive from that merchant's own xpub so funds settle to their own wallet. `PaycrytServer` doesn't do that yet.
- **No rate limiting or audit log of admin actions** yet.
- **`webhookUrl` is not filtered for private addresses.** Only the admin sets it, so this is an operator trust decision. If you let merchants set their own, add an SSRF allow/deny check first.
- **No self-service signup.** Merchants are created by the admin only.
