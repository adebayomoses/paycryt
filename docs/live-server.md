# Running the server live

`PaycrytServer` has two modes. **Sandbox** (the default) uses a fake chain and made-up prices so you can develop with no accounts. **Live** (`PAYCRYT_SANDBOX=false`) watches real blockchains and prices from real exchanges. The two never mix: a live server has no simulator endpoints, and the sandbox cannot be given real chains.

> **Alpha.** Each piece has been checked against its real network, and a live server has been driven end to end against real CoinGecko, Binance, Blockstream and an Ethereum RPC. But no real money has moved through the full flow. Start with small amounts and read [SECURITY.md](../SECURITY.md).

## Start it

```bash
npm run build

PAYCRYT_SANDBOX=false \
PAYCRYT_API_KEY="$(openssl rand -hex 24)" \
PAYCRYT_DB_PATH=./paycryt.db \
PAYCRYT_CHAINS=tron,ethereum,bitcoin \
TRONGRID_API_KEY=... \
ETHEREUM_RPC_URL=https://your-paid-rpc.example/v2/KEY \
PAYCRYT_RATE_SOURCES=coingecko,binance \
node packages/server/dist/cli.js
```

### Environment

| Variable | Meaning |
|---|---|
| `PAYCRYT_SANDBOX=false` | Turns live mode on. |
| `PAYCRYT_API_KEY` | Admin key, 24+ characters, not the default. The admin onboards merchants, so treat it like a root password. |
| `PAYCRYT_DB_PATH` | **Required.** SQLite file holding payments, merchants, wallet indexes and the rate audit trail. Without it a restart forgets open payments, and a customer who pays afterwards is never matched. `PAYCRYT_ALLOW_EPHEMERAL=true` overrides this for experiments only. |
| `PAYCRYT_CHAINS` | **Required.** Any of `tron`, `bitcoin`, `ethereum`, `base`, `bsc`. |
| `TRONGRID_API_KEY`, `TRONGRID_URL` | Tron. The free tier answers HTTP 429 under polling, so set a key or your own node. |
| `ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `BSC_RPC_URL` | Required for each EVM chain listed. See the note on public RPCs below. |
| `ESPLORA_URL` | Bitcoin. Defaults to blockstream.info; use mempool.space or your own electrs. |
| `PAYCRYT_RATE_SOURCES` | `coingecko` (default), `binance`, or both. `COINGECKO_API_KEY` / `COINGECKO_URL` are optional. |
| `PAYCRYT_MIN_RATE_SOURCES` | How many sources must agree. Default 1. |
| `PAYCRYT_MAX_RATE_DEVIATION_BPS` | How far a source may sit from the median. Default 300 (3%). Range 1 to 5000. |
| `PAYCRYT_POLL_MS`, `PAYCRYT_POLL_CONCURRENCY` | How often payments are checked (default 5000) and how many at once (default 4). |

Every setting is validated at startup, and the error names the variable to fix. RPC URLs often carry an API key in the path, so the startup summary prints only their host.

## What live mode refuses to do

Live mode would rather stop than guess. Each of these is a deliberate refusal:

- **Start without real chains and real price sources.** It never falls back to a fake chain or invented prices.
- **Create a payment for a merchant with no wallet.** Deposit addresses must derive from the merchant's own public key, so customers pay the merchant directly. An admin-owned or wallet-less account gets a 400.
- **Hand out an address that already has funds.** Before issuing an address the server checks the chain. A used address is skipped. If the check itself fails (rate limit, node down) the request gets a 503 and **no address is issued**, because a reused address could make an old deposit look like a new payment.
- **Price a payment from nothing.** If no rate can be produced, the answer is a 503, not a stale or default price.
- **Price from sources that disagree.** See below.
- **Accept a chain that isn't configured.**
- **Credit a new payment with old funds.** Deposits that were at an address before the request existed are ignored (see [payment policies](payment-policies.md#funds-that-were-already-at-the-address)).

## Watching it

`GET /health` is unauthenticated and returns `{ ok, sandbox, mode }`.

`GET /v1/status` (admin key) returns the configured chains and rate sources, the last poll (`at`, `tookMs`, `agoMs`), payment counts by status, and `chainErrors`: every payment whose latest chain lookup failed, with the message. A growing `chainErrors` or a large `agoMs` is the thing to alert on.

Polls never overlap. If the chain is slower than the poll interval the next poll waits, so a slow API is not hit by a pile of concurrent requests. One failing chain lookup never stops the other payments being checked.

## Two things real data taught us

**Rate sources really do disagree.** On the day this was tested, CoinGecko quoted 1,326 NGN per USDT and Binance 1,518, about 14% apart. That is normal for the naira: official and parallel-market prices differ. With two sources the median is the midpoint, so both are the same distance from it and both are rejected. The server then answers 503 rather than pick a winner and short-change either you or your customer. The error shows what each source quoted:

```
No exchange rate available right now: Only 0 agreeing rate source(s) for USDT/NGN, need 1.
Quotes: coingecko 1326.14, binance 1518.4; sources must be within 300 bps of their median
```

You have three honest options: use one source you trust, add a third so an outlier can be identified, or widen `PAYCRYT_MAX_RATE_DEVIATION_BPS` knowingly (the price is then the median, and the audit trail records both quotes). Widening is a business decision about who absorbs the gap, not a technical fix.

**Free public RPCs are unreliable, so use a paid tier or your own node.** Against `ethereum-rpc.publicnode.com`, three end-to-end attempts gave one success and two `eth_getLogs` HTTP 403 responses ("Archive requests require a personal token"), even though the adapter only asks for the last 1,200 blocks and the same call succeeds when repeated by hand. Live mode handled it correctly (503, no address issued, nothing half-created), but a shared free node will make payment creation flaky. Providers such as Alchemy, Infura and Ankr, or a node you run, avoid this.

## Onboarding a merchant

```bash
curl -X POST http://127.0.0.1:8787/v1/admin/merchants \
  -H "Authorization: Bearer $PAYCRYT_API_KEY" -H 'content-type: application/json' \
  -d '{ "name": "Ada Stores", "wallets": { "evm": "xpub...", "tron": "xpub...", "bitcoin": "zpub..." } }'
```

The response contains the merchant's API key once. Only its hash is stored. Wallet keys must be extended **public** keys; a private key is refused and never echoed. See [multi-tenant](multi-tenant.md).

## Not covered yet

Rate limiting, an admin audit log, and live checks of the Paystack/Flutterwave adapters. See the [roadmap](../ROADMAP.md).
