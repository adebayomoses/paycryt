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

Confirmations are **real**: `chainTip - transactionBlock + 1`, the same as the EVM and Bitcoin adapters. TronGrid's transfer list only says whether a transfer is *solidified* (final), not how deep it is, so the adapter also asks the node for the chain tip (`POST /wallet/getnowblock`) and for each transfer's block (`POST /wallet/gettransactioninfobyid`).

- A solidified transfer reports its real depth (never below 1, since solidified is final by definition).
- An unconfirmed transfer already in a block reports its real, small depth (e.g. 5); one still in the mempool reports 0. So a policy asking for `minConfirmations: 12` now genuinely waits for 12 blocks, where the old fixed weight of 20 would have accepted a 1-block-deep transfer the moment it appeared solidified.
- **Fallback.** If a lookup fails (a rate-limited or unreachable node), the adapter degrades conservatively instead of failing the whole check: a solidified transfer reports `confirmedWeight` (default 20; safe because solidified is final) and an unconfirmed one reports 0.

Verified against the live API: the adapter's counts for six real USDT transfers matched an independent calculation from the same data (a consistent 3-block offset, which is the tip advancing during the run), and the solidified height sat 19 blocks behind the tip.

**Cost.** Two transfer lists per check, plus, only when there is something to report, one tip lookup (cached ~2.5s, about one block) and one block lookup per transfer not seen before. A solidified transfer's block never changes, so it is looked up once and remembered (up to `blockCacheSize`, default 5000); an unconfirmed one is never cached, since it can still reorganise. In the live run above, the first check made 9 HTTP calls and the second made 3.

### Rate limits

The public `api.trongrid.io` endpoint is rate-limited per IP and **will** answer `429` under polling; it did during testing of this very adapter. A fresh deposit address makes two calls per poll, plus the tip and block lookups described above. A rate-limited check throws, and `PaymentWatcher` now isolates that failure (see [payment-policies.md](payment-policies.md#when-a-chain-lookup-fails)): the affected payment is retried next tick and every other payment carries on. Get a free API key from the [TronGrid dashboard](https://www.trongrid.io/) and pass it as `apiKey`, or point `baseUrl` at your own full node.

### Known limitations

- **No pagination.** `limit` (default 200) is fetched in one request. Fine for one-time deposit addresses, which see very few transfers; raise it or add pagination yourself if you reuse addresses.
- **No retry inside the adapter.** A `429` surfaces as an error, and the watcher retries on its next tick. If you poll many addresses, use an API key or your own node.
- Only tested with mocked and live-read HTTP; no live test transaction has been sent through it.

## Wiring it into the reference server

The bundled `PaycrytServer` (`@paycryt/server`) always uses `FakeChain` — it's a sandbox by design. To go live, build your own thin server around `@paycryt/core` (or fork `packages/server/src/app.ts`) and swap the chain adapter:

```ts
const chains = [new TronGridChainAdapter({ fetch, apiKey: process.env.TRONGRID_API_KEY })];
const watcher = new PaymentWatcher(chains);
// createPaymentRequest(...) with asset: ASSETS.USDT_TRC20, address: new TronXpubDeriver(xpub).derive(index)
```
