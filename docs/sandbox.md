# Local fake-chain sandbox

Develop against Paycryt without testnet faucets, RPC keys or waiting for blocks. You decide when deposits arrive, how much, and when they confirm.

## Run it

```bash
npm run build && npm run sandbox
# Paycryt SANDBOX listening on http://127.0.0.1:8787   (API key: sandbox_key)
```

or with Docker: `docker compose up` (see [docker-compose.yml](../docker-compose.yml)).

Environment: `PORT`, `HOST`, `PAYCRYT_API_KEY`, `PAYCRYT_SPREAD_BPS`, `PAYCRYT_WEBHOOK_URL`, `PAYCRYT_WEBHOOK_SECRET`, `PAYCRYT_SANDBOX=false` (turns the sandbox off; then a non-default API key is required).

## API (all under `Authorization: Bearer <key>`)

| Method & path | Purpose |
|---|---|
| `POST /v1/payments` | `{ amount, currency, asset, policy?, metadata? }` → payment with address, `amountDue`, `rateSnapshotHash` |
| `GET /v1/payments/:id`, `GET /v1/payments` | status, received / pending / shortfall / excess / late, `actions` |
| `GET /v1/events` | emitted events (also POSTed to `PAYCRYT_WEBHOOK_URL`, signed) |
| `GET /v1/payouts` | mock fiat settlements made for confirmed payments |
| `GET /v1/rates/USDT-NGN` | a fresh hash-sealed snapshot (what a POS caches) |
| `GET /v1/audit/rates`, `/:hash` | the rate log and its verification result |
| `POST /v1/leases`, `/v1/leases/renew` | give an offline device an address range |
| `POST /v1/sync` | receive an offline device's queued operations |

### Sandbox-only controls

| `POST` | Body | Effect |
|---|---|---|
| `/v1/sandbox/deposit` | `{ paymentId, scenario, percent?, parts?, afterMs? }` | simulate a customer: `exact`, `underpay`, `overpay`, `split`, `late`, `unconfirmed` |
| `/v1/sandbox/mine` | `{ blocks }` | confirm pending deposits |
| `/v1/sandbox/time` | `{ advanceMs }` | fast-forward the server clock to test expiry and grace |
| `/v1/sandbox/rates` | `{ pair: "USDT/NGN", price: "1600" }` | move the market |

Amounts in responses are strings of base units (e.g. USDT has 6 decimals, so `"10090920"` is 10.09092 USDT).

## Scenario walk-through

```bash
H='Authorization: Bearer sandbox_key'; U=localhost:8787
ID=$(curl -s -H "$H" -X POST $U/v1/payments -d '{"amount":"15000","currency":"NGN","asset":"USDT_TRC20"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -H "$H" -X POST $U/v1/sandbox/deposit -d "{\"paymentId\":\"$ID\",\"scenario\":\"underpay\",\"percent\":60}"   # partially_paid
curl -s -H "$H" -X POST $U/v1/sandbox/deposit -d "{\"paymentId\":\"$ID\",\"scenario\":\"underpay\",\"percent\":40}"   # paid
curl -s -H "$H" $U/v1/payouts                                                                                            # mock settlement
```

Time travel: `POST /v1/sandbox/time {"advanceMs": 3600000}` on an unpaid payment turns it `expired`.

## In your own tests (no server)

```ts
const chain = new FakeChain('tron');
const watcher = new PaymentWatcher([chain]);
watcher.watch(request);
chain.scenarios.overpay(request, 130);
await watcher.tick();          // → payment.overpaid
```

The same `ChainAdapter` interface is what a real EVM/Tron/Bitcoin adapter implements, so production code paths are the ones you tested.

## Not for production

The reference server keeps everything in memory, the sandbox routes fabricate deposits, and the default API key is public. The CLI refuses to start with the default key unless `PAYCRYT_SANDBOX` is on.
