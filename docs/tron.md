# Tron (TRC20 USDT)

Tron is the most common rail for USDT in Nigeria and Ghana: low fees, fast blocks. Paycryt has a real, non-custodial deposit address deriver and a real chain watcher for it.

> **Status: experimental.** The address derivation is checked byte-for-byte against the reference `tronweb` library, and the chain adapter is verified against TronGrid's live API (response shape, query parameters, headers). Neither has been run against a real, money-moving deposit end to end. Test on Shasta/Nile testnet or with small amounts before trusting it with real funds.

## Address derivation — `TronXpubDeriver`

Same idea as `EvmXpubDeriver`: give it an **account-level xpub** and it derives addresses with no network call and no private key.

```ts
import { TronXpubDeriver, tronAccountXpub, generateWalletMnemonic } from '@paycryt/core';

// Setup time, offline, on a secure machine:
const mnemonic = generateWalletMnemonic();      // keep this offline, forever
const xpub = tronAccountXpub(mnemonic);          // m/44'/195'/0' — safe to hand to a server or POS device

// Runtime, online or offline:
const deriver = new TronXpubDeriver(xpub);
deriver.derive(0);  // "TR7NHq..." — a fresh deposit address, deterministic per index
```

- Path: `m/44'/195'/0'/0/i` — coin type 195 is Tron's registered [SLIP-44](https://github.com/satoshilabs/slips/blob/master/slip-0044.md) value.
- Encoding: `Base58Check(0x41 ‖ keccak256(pubkey)[-20:])`. Same "hash the pubkey, take the last 20 bytes" step as Ethereum; only the final encoding differs.
- Verified: `tronAddressFromPublicKey` derives `TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC` from private key `0x…01`, matching `TronWeb.address.fromPrivateKey` exactly (checked live against `tronweb@5.3.2`).
- Like `EvmXpubDeriver`, it throws if you pass an extended **private** key by mistake.

## Watching deposits — `TronGridChainAdapter`

```ts
import { TronGridChainAdapter } from '@paycryt/adapters';
import { PaymentWatcher } from '@paycryt/core';

const tron = new TronGridChainAdapter({
  fetch,                              // Node 18+/20+/24 has this built in
  apiKey: process.env.TRONGRID_API_KEY, // free, from the TronGrid dashboard — raises your rate limit
});

const watcher = new PaymentWatcher([tron /* , evmAdapter, ... */]);
```

It queries TronGrid's `GET /v1/accounts/:address/transactions/trc20` endpoint, scoped to the USDT contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) by default. Pass `contracts` to watch other TRC20 tokens:

```ts
new TronGridChainAdapter({ fetch, contracts: { USDC: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8' } });
```

### Confirmations

TronGrid's transfer endpoint tells you whether a transfer is **solidified** (via `only_confirmed`/`only_unconfirmed`), but not a block-confirmation count. The adapter reports:

- an unconfirmed transfer as `confirmations: 0`;
- a solidified one as `confirmations: confirmedWeight` (default **20**).

Set `confirmedWeight` at or above your `PaymentPolicy.minConfirmations` so solidified deposits actually clear. The default policy's `minConfirmations: 1`, so the default weight of 20 is already well above it.

### Rate limits

The public `api.trongrid.io` endpoint is rate-limited per IP; a fresh deposit address makes two calls per poll (confirmed + unconfirmed). Get a free API key from the [TronGrid dashboard](https://www.trongrid.io/) and pass it as `apiKey`, or point `baseUrl` at your own full node.

### Known limitations

- **No pagination.** `limit` (default 200) is fetched in one request. Fine for one-time deposit addresses, which see very few transfers; raise it or add pagination yourself if you reuse addresses.
- **No block-level confirmation count** — see above.
- Only tested with mocked and live-read HTTP; no live test transaction has been sent through it.

## Wiring it into the reference server

The bundled `PaycrytServer` (`@paycryt/server`) always uses `FakeChain` — it's a sandbox by design. To go live, build your own thin server around `@paycryt/core` (or fork `packages/server/src/app.ts`) and swap the chain adapter:

```ts
const chains = [new TronGridChainAdapter({ fetch, apiKey: process.env.TRONGRID_API_KEY })];
const watcher = new PaymentWatcher(chains);
// createPaymentRequest(...) with asset: ASSETS.USDT_TRC20, address: new TronXpubDeriver(xpub).derive(index)
```
