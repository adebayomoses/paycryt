/**
 * Offline-first POS demo. Runs entirely in memory with the fake-chain sandbox:  npm run build && npm run demo:offline
 *
 * Story: a cashier sells NGN 15,000 of goods for USDT while the shop's internet is down,
 * the customer pays on-chain, and everything reconciles when the connection returns.
 */
import {
  ASSETS,
  FakeChain,
  LeaseRegistry,
  MemoryStore,
  OfflinePOS,
  PaymentWatcher,
  RateEngine,
  StaticRateProvider,
  SyncReceiver,
  formatUnits,
  verifyChain,
} from '@paycryt/core';

const log = (msg: string) => console.log(msg);

// ---- server side (your backend) ----------------------------------------------------------------
const chain = new FakeChain('tron');
const engine = new RateEngine({
  providers: [
    new StaticRateProvider('exchange', { 'USDT/NGN': '1498' }),
    new StaticRateProvider('parallel-market', { 'USDT/NGN': '1506' }),
  ],
  spreadBps: 100,
});
const watcher = new PaymentWatcher([chain]);
watcher.on((e) => log(`  [server] ${e.type}  received=${formatUnits(e.evaluation.received, 6)} USDT`));
const leases = new LeaseRegistry();
const receiver = new SyncReceiver({
  deriver: chain,
  leases,
  onAccepted: (r) => watcher.watch(r),
  isKnownSnapshot: (h) => !!engine.log.get(h),
});

// ---- device side (the POS tablet) --------------------------------------------------------------
const pos = new OfflinePOS({
  deviceId: 'till-1',
  deriver: chain, // in production: new EvmXpubDeriver(xpub), so the device holds no private keys
  lease: leases.allocate('till-1', 500),
  store: new MemoryStore(), // in production: SQLite / IndexedDB / AsyncStorage
});

log('1) Online: device downloads a hash-sealed rate snapshot');
await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);

log('2) Internet goes down. Cashier charges NGN 15,000 in USDT');
const { request, uri } = await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 1_500_000n }, asset: ASSETS.USDT_TRC20 });
log(`   address:    ${request.address}`);
log(`   amount due: ${formatUnits(request.amountDue, 6)} USDT  (rate ${request.effectiveRate} NGN/USDT incl. offline margin)`);
log(`   QR payload: ${uri}`);

log('3) Customer pays on-chain (the POS cannot see it yet)');
chain.scenarios.exact(request);

log('4) Internet returns. Device syncs its queue');
const summary = await pos.sync({ push: (op) => receiver.apply(op) });
log(`   sync result: ${JSON.stringify(summary)}`);
await watcher.tick();

log('5) Audit: any rate a customer was charged can be re-verified');
const [snapshotChain] = [engine.log.all().slice()];
log(`   server rate log verifies: ${JSON.stringify(verifyChain(snapshotChain))}`);
log(`   payment priced from snapshot ${request.rateSnapshotHash.slice(0, 16)}...`);
