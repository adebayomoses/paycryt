# EVM chains (Ethereum, Base, BNB Chain)

A real, non-custodial address deriver already existed (`EvmXpubDeriver`). This adds a real chain watcher: `EvmRpcChainAdapter`, which watches ERC-20 deposits over plain JSON-RPC — no indexer, no paid API required, though you can point it at one.

> **Status: experimental**, but with more end-to-end proof than the other real-chain work here. I queried a live Ethereum mainnet RPC directly — no mocking — with the built adapter and it correctly found **173 real USDT deposits** to a real address, with real transaction hashes, real amounts and real confirmation counts. The Transfer event topic hash, log shape, batch JSON-RPC requests and block timestamps were all checked against live chain data first. Still: no payment has been created and paid through the full flow end to end, so treat it as experimental and test with small amounts first.

## Watching deposits — `EvmRpcChainAdapter`

```ts
import { EvmRpcChainAdapter } from '@paycryt/adapters';
import { PaymentWatcher } from '@paycryt/core';

const ethereum = new EvmRpcChainAdapter({
  fetch,                                    // Node 18+/20+/24 has this built in
  rpcUrl: process.env.ETH_RPC_URL!,         // your own node, or Alchemy/Infura/Ankr/etc.
  chain: 'ethereum',                        // must match ASSETS.USDT_ERC20.chain
});

const watcher = new PaymentWatcher([ethereum /* , base, bsc, tron, ... */]);
```

It calls `eth_getLogs` for the ERC-20 `Transfer` event, filtered by contract and by the deposit address as the `to` topic, then `eth_getBlockByNumber` (batched into one request) to get each block's real timestamp.

Default contracts come from `@paycryt/core`'s `ASSETS` for the given `chain` (USDT on Ethereum, USDT on BSC, USDC on Base). Add your own or override:

```ts
new EvmRpcChainAdapter({ fetch, rpcUrl, chain: 'ethereum', contracts: { MYTOKEN: '0x...' } });
```

## Confirmations: real block depth

Like the Tron and Bitcoin adapters, this one computes actual block-based confirmations: `currentBlock - logBlock + 1`, straight from the chain. No fixed weight to configure.

## Lookback window

`eth_getLogs` needs a block range, and most RPC providers won't index-scan from genesis on every poll. The adapter always queries `[currentBlock - lookbackBlocks, currentBlock]`. Built-in defaults, tuned to comfortably outlive a payment's expiry + grace window:

| Chain | Default `lookbackBlocks` | ~ time covered |
|---|---|---|
| `ethereum` | 1,200 | ~4h at ~12s/block |
| `base` | 7,200 | ~4h at ~2s/block |
| `bsc` | 4,800 | ~4h at ~3s/block |

Any other chain name needs `lookbackBlocks` passed explicitly — the adapter refuses to guess.

## Range chunking

Many providers cap how many blocks `eth_getLogs` can span in one call (a few thousand on free tiers). `maxBlockRange` (default 2000) splits the lookback window into chunks automatically, run sequentially. Tune it to your provider's limit — a paid Alchemy/Infura plan can usually take one large call (`maxBlockRange: 50_000`+); a shared public RPC may need chunks under 2,000.

## Known limitations

- **No pagination beyond chunking** — for a freshly generated one-time deposit address this is a non-issue.
- **Native-coin deposits are out of scope.** ETH or BNB sent directly (not a token) aren't ERC-20 `Transfer` events; this adapter won't see them. That needs separate transaction-receipt watching, not implemented here.
- Only tested against mocked JSON-RPC and read-only live queries; no live test transaction has been sent through it end to end.

## Choosing an RPC provider

Public shared RPCs (like the one used for verification here) are rate-limited and fine for testing. For production, use your own node or a paid tier (Alchemy, Infura, Ankr, QuickNode) — they raise both the rate limit and the `eth_getLogs` range cap.
