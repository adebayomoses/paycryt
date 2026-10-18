# @paycryt/core

The engine of [Paycryt](https://github.com/adebayomoses/paycryt): open-source, self-hostable, **non-custodial** crypto payments built for unstable networks and local fiat rails. This package has no server and no network code. It is the logic, and it runs in Node and in browsers.

> **Alpha (0.1).** Tested, and a real payment has been completed on Tron mainnet, but it has not been security-audited. Read [SECURITY.md](https://github.com/adebayomoses/paycryt/blob/main/SECURITY.md) before it goes anywhere near real money.

```bash
npm install @paycryt/core@alpha
```

## What is in it

- **Non-custodial addresses.** Derive deposit addresses for EVM chains, Tron and Bitcoin from an extended *public* key. A private key is refused and never echoed.
- **A fair-rate engine.** Median of several sources, outliers dropped, your spread applied against the customer, and every price a hash-chained, tamper-evident snapshot you can audit later.
- **Payment policies.** A pure function that turns "what arrived on-chain" into a status and *actions* (top up, refund, credit). It never moves money itself.
- **An offline-first POS engine.** `OfflinePOS` keeps pricing and creating payable requests with no connection and syncs them safely afterwards.
- **A fake-chain sandbox** (`FakeChain`) to simulate exact, short, over, split, late and unconfirmed payments.

## Quickstart

```js quickstart
import {
  ASSETS, EvmXpubDeriver, FakeChain, RateEngine, StaticRateProvider, createPaymentRequest,
  evaluatePayment, evmAccountXpub, formatUnits, generateWalletMnemonic, parseUnits, withPolicy,
} from '@paycryt/core';

// 1. A merchant wallet. Only the PUBLIC key belongs on a server; keep the mnemonic offline.
const xpub = evmAccountXpub(generateWalletMnemonic());
const address = new EvmXpubDeriver(xpub).derive(0);

// 2. Price NGN 15,000 in USDT from two sources, with a 1% spread, recorded in a hash-chained audit log.
const engine = new RateEngine({
  providers: [new StaticRateProvider('exchange', { 'USDT/NGN': '1498' }), new StaticRateProvider('parallel', { 'USDT/NGN': '1506' })],
  spreadBps: 100,
});
const snapshot = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });

// 3. A payment request for that address.
const request = createPaymentRequest({
  fiat: { currency: 'NGN', amountMinor: parseUnits('15000', 2) },
  asset: ASSETS.USDT_ERC20, address, addressIndex: 0, snapshot, policy: withPolicy(), now: Date.now(),
});
console.log(`send ${formatUnits(request.amountDue, 6)} USDT to ${request.address}`);

// 4. The customer pays 60%. The policy turns that into a status and actions your app carries out.
const chain = new FakeChain('ethereum');
chain.scenarios.underpay(request, 60);
const result = evaluatePayment(request, await chain.getDeposits(request.address, 'USDT'), Date.now());
console.log(result.status, result.actions);
```

Money is never a float: amounts are `bigint` in minor units and rates are `bigint` scaled by 1e18.

## Related

- [`@paycryt/adapters`](https://www.npmjs.com/package/@paycryt/adapters): live chain watchers, rate sources, Paystack/Flutterwave, stores.
- [`@paycryt/server`](https://www.npmjs.com/package/@paycryt/server): the self-hosted server, dashboard and offline POS app.
- [Documentation](https://github.com/adebayomoses/paycryt/tree/main/docs) · [Contributing](https://github.com/adebayomoses/paycryt/blob/main/CONTRIBUTING.md) · MIT licensed.
