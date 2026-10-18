# @paycryt/adapters

The optional, real-world half of [Paycryt](https://github.com/adebayomoses/paycryt): the pieces that talk to blockchains, price feeds, payment providers and storage. Everything takes an injected `fetch`, so it is testable and runs on any runtime.

> **Alpha (0.1).** The Tron, EVM and Bitcoin watchers were each checked against their real mainnets; a full payment cycle has been completed for real on Tron only. The Paystack and Flutterwave adapters are partly verified against live sandboxes (see below). Not security-audited. Needs Node 22.5+ (for `node:sqlite`).

```bash
npm install @paycryt/adapters@alpha @paycryt/core@alpha
```

## What is in it

| | |
|---|---|
| **Chain watchers** | `TronGridChainAdapter` (TRC20 USDT, real block-depth confirmations), `EvmRpcChainAdapter` (ERC-20 transfers over plain JSON-RPC: Ethereum, Base, BNB Chain), `EsploraChainAdapter` (Bitcoin via blockstream.info, mempool.space or your own electrs) |
| **Rate sources** | `CoinGeckoRateProvider`, `BinanceRateProvider`, `ParallelMarketRateProvider` (wrap any async function, e.g. a P2P board) |
| **Fiat rails** | `PaystackAdapter`, `FlutterwaveAdapter`: bank and mobile-money payouts and mobile-money collection. Flutterwave M-Pesa collection is verified live. Payouts reach the real APIs but are gated by each provider's account verification. |
| **Stores** | `SqliteStore` (built-in `node:sqlite`, no native dependency) and `IndexedDbStore` (browser and WebView POS devices) |

## Quickstart

```js quickstart
import { CoinGeckoRateProvider, EvmRpcChainAdapter, SqliteStore, TronGridChainAdapter } from '@paycryt/adapters';

// Free public RPC and API tiers rate-limit hard. Use a key or your own node for anything real.
const tron = new TronGridChainAdapter({ fetch, apiKey: process.env.TRONGRID_API_KEY });
const ethereum = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://your-rpc.example/v2/KEY', chain: 'ethereum' });
const rates = new CoinGeckoRateProvider(fetch);
const store = new SqliteStore(':memory:'); // or a file path, to survive restarts

console.log(tron.chain, ethereum.chain, rates.name, typeof store.get);
store.close();
```

Plug the chain adapters into a `PaymentWatcher` from `@paycryt/core`, or let [`@paycryt/server`](https://www.npmjs.com/package/@paycryt/server) wire them up from environment variables.

## Related

- [`@paycryt/core`](https://www.npmjs.com/package/@paycryt/core) · [`@paycryt/server`](https://www.npmjs.com/package/@paycryt/server)
- [Adapter docs and verification notes](https://github.com/adebayomoses/paycryt/blob/main/docs/adapters.md) · [Contributing](https://github.com/adebayomoses/paycryt/blob/main/CONTRIBUTING.md) · MIT licensed.
