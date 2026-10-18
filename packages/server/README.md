# @paycryt/server

The self-hosted server for [Paycryt](https://github.com/adebayomoses/paycryt): a REST API, a **web dashboard**, and an installable **offline-first POS app**, in one process you run yourself. Non-custodial: it holds public keys only, and there is nothing to host on anyone else's side.

> **Alpha (0.1).** A real payment has been completed on Tron mainnet, but this has not been security-audited and no real money has been moved on EVM or Bitcoin through it. Start with small amounts and read [SECURITY.md](https://github.com/adebayomoses/paycryt/blob/main/SECURITY.md). Needs Node 22.5+.

## Try it in a minute

```bash
npx @paycryt/server@alpha
```

That starts a **sandbox** on <http://127.0.0.1:8787> with a fake chain and fake money. Open it in a browser, sign in with the key `sandbox_key`, create a payment, scan its QR code, and use the buttons to play the customer (exact, short, over, late...).

Add a merchant in the dashboard, then open **/pos** on a phone to try the till. It keeps selling with the server down and sends everything when the connection returns.

## Run it for real

```bash
PAYCRYT_SANDBOX=false \
PAYCRYT_API_KEY="$(openssl rand -hex 24)" \
PAYCRYT_DB_PATH=./paycryt.db \
PAYCRYT_CHAINS=tron,bitcoin \
TRONGRID_API_KEY=... \
npx @paycryt/server@alpha
```

Live mode watches real chains and real exchange rates, and refuses to start on fake ones. It needs a database, a strong admin key and a free [TronGrid](https://www.trongrid.io) key (or your own node). Every setting is validated at startup and the error names the variable to fix. Full guide: [docs/live-server.md](https://github.com/adebayomoses/paycryt/blob/main/docs/live-server.md). Put it behind HTTPS before using the POS app on phones.

## Embed it

```js
import { PaycrytServer } from '@paycryt/server';

const server = await PaycrytServer.create({ apiKey: 'a-long-random-admin-key', sandbox: true });
const port = await server.listen(8787);
console.log(`dashboard: http://127.0.0.1:${port}/`);
```

## What you get

- **Multi-tenant:** one admin key onboards merchants; each has their own key and their own wallet, so customers pay the merchant directly. Merchants see only their own payments.
- **Safe by default:** per-key rate limiting, an admin audit log, and signed webhooks with retries.
- **Fails closed:** if a price or an address check cannot be completed it answers 503 rather than guess.
- **Dashboard** (`/`) and **POS** (`/pos`): plain pages served by the server itself. The dashboard ships no third-party code; the POS bundles the audited `@noble`/`@scure` crypto libraries.

## Related

- [`@paycryt/core`](https://www.npmjs.com/package/@paycryt/core) · [`@paycryt/adapters`](https://www.npmjs.com/package/@paycryt/adapters)
- [Dashboard](https://github.com/adebayomoses/paycryt/blob/main/docs/dashboard.md) · [POS app](https://github.com/adebayomoses/paycryt/blob/main/docs/pos.md) · [Contributing](https://github.com/adebayomoses/paycryt/blob/main/CONTRIBUTING.md) · MIT licensed.
