# Bitcoin (native SegWit, bech32)

A real, non-custodial address deriver and a real chain watcher, completing the three chains this project targets (alongside [Tron](tron.md) and [EVM](evm.md)).

> **Status: experimental**, with strong live proof. The address derivation was checked byte-for-byte against `bitcoinjs-lib` (zpub string, public keys, and the final bc1... addresses all matched exactly). The chain adapter was run — unmocked — against a real, very active Bitcoin address on mainnet: it correctly parsed 29 real deposits, and an independent recomputation from the same raw API response matched the adapter's output with zero mismatches. Still, no payment has been created and paid through the full flow end to end — treat it as experimental and test on testnet/signet or with small amounts first.

## Address derivation — `BtcXpubDeriver`

Native SegWit (BIP84), the address format almost everything uses today: `bc1...`, bech32-encoded, lower fees than legacy formats.

```ts
import { BtcXpubDeriver, btcAccountZpub, generateWalletMnemonic } from '@paycryt/core';

// Setup time, offline, on a secure machine:
const mnemonic = generateWalletMnemonic();
const zpub = btcAccountZpub(mnemonic);           // m/84'/0'/0' — the same zpub a hardware wallet or Electrum exports

// Runtime, online or offline:
const deriver = new BtcXpubDeriver(zpub);
deriver.derive(0);  // "bc1q..." — a fresh deposit address, deterministic per index
```

- Path: `m/84'/0'/0'/0/i` per [BIP84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki).
- Extended-key version bytes: the [SLIP-132](https://github.com/satoshilabs/slips/blob/master/slip-0132.md) `zpub`/`zprv` pair (`0x04b24746`/`0x04b2430c`), not the plain BIP32 `xpub` pair — so a genuine zpub copied from a wallet parses correctly, and a plain xpub or the wrong key type is rejected.
- Address encoding: `Bech32('bc', [0, ...ripemd160(sha256(pubkey))])` per BIP173. Checked byte-for-byte against `bitcoinjs-lib`'s `payments.p2wpkh`.
- Like the other derivers, it throws if you pass an extended **private** key by mistake.

## Watching deposits — `EsploraChainAdapter`

```ts
import { EsploraChainAdapter } from '@paycryt/adapters';
import { PaymentWatcher } from '@paycryt/core';

const bitcoin = new EsploraChainAdapter({
  fetch,
  baseUrl: 'https://blockstream.info/api', // default; or mempool.space, or your own esplora/electrs
});

const watcher = new PaymentWatcher([bitcoin /* , tron, ethereum, ... */]);
```

It's built on the [Esplora REST API](https://github.com/Blockstream/esplora/blob/master/API.md), the same interface behind blockstream.info and mempool.space, and self-hostable via `electrs`. No API key, no custom node RPC.

Two calls per poll:
- `GET /blocks/tip/height` — the current chain tip.
- `GET /address/:address/txs` — recent transactions touching the address, confirmed and unconfirmed together.

For each transaction, every output paid to the watched address is summed (a real address can receive several outputs to itself in one transaction — verified against a live example with 19 outputs in a single tx).

### Confirmations

Real, like the EVM adapter: `tipHeight - tx.block_height + 1`.

### Unconfirmed deposits and `receivedAt`

Esplora's address-history endpoint gives no timestamp for an unconfirmed transaction — verified by inspecting the raw response directly. So the adapter remembers, in memory, the first time *it* saw a given txid unconfirmed, and reuses that estimate on every later poll instead of letting it drift forward to "now" each time. Once the transaction confirms, the estimate is discarded in favour of the real on-chain `block_time`.

This matters for the underpayment/overpayment policy: a deposit that was broadcast on time but is just slow to confirm should stay classified as "pending," not "late," even minutes after your payment's expiry window.

### Known limitations

- **No pagination.** Esplora returns unconfirmed transactions in full but caps confirmed history per page; fine for a fresh one-time deposit address.
- **The first-seen cache is in-process and unbounded.** It clears an entry once a transaction confirms, but if the process restarts while a deposit is still unconfirmed, the estimate resets to "now" on the next poll. Acceptable for short payment windows; revisit if you add persistent storage (see [ROADMAP.md](../ROADMAP.md)).
- Only watches BTC itself — there's no equivalent of an "ERC-20 token" concept on Bitcoin, so this adapter has nothing analogous to the Tron/EVM `contracts` map.
- Only tested against mocked HTTP and live-read queries; no live test transaction has been sent through it end to end.
