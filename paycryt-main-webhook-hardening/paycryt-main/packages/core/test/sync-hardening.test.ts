import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  CURRENCIES,
  FakeChain,
  LeaseRegistry,
  MemoryStore,
  OfflinePOS,
  SyncReceiver,
  fiatToAssetUnits,
  fromJson,
  rateFromString,
  toJson,
  withPolicy,
  type PaymentRequest,
  type SyncOp,
  type SyncReceiverOptions,
} from '@paycryt/core';
import { makeClock, makeEngine } from './helpers.js';

const NGN_15K = { currency: 'NGN', amountMinor: 1_500_000n };

/** A device with one queued payment, plus what a server needs to receive it. */
async function fixture(receiverOptions: Partial<SyncReceiverOptions> = {}) {
  const clock = makeClock();
  const engine = makeEngine(clock.now);
  const chain = new FakeChain('tron', clock.now);
  const leases = new LeaseRegistry();
  const lease = leases.allocate('till-1', 100);
  const accepted: PaymentRequest[] = [];
  const receiver = new SyncReceiver({
    deriver: chain,
    leases,
    onAccepted: (r) => void accepted.push(r),
    isKnownSnapshot: (h) => !!engine.log.get(h),
    ...receiverOptions,
  });
  const pos = new OfflinePOS({ deviceId: 'till-1', deriver: chain, lease, store: new MemoryStore(), clock: clock.now });
  await pos.cacheRates(engine, [{ base: 'USDT', quote: 'NGN' }]);
  await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_TRC20 });
  const [stored] = await pos.pending();
  const fresh = (): SyncOp => fromJson<SyncOp>(toJson(stored)); // an independent copy a hostile device can edit
  return { receiver, accepted, fresh, chain, leases, clock, engine, pos };
}

const reasonOf = (r: { status: string }) => (r as { reason?: string }).reason ?? '';

describe('a hostile device cannot rewrite the rules of its own sale', () => {
  it('cannot invent an asset description to shrink the price (decimals: 0 would undercharge a million-fold)', async () => {
    const { receiver, fresh } = await fixture();
    const op = fresh();
    const cheat = { ...op.request.asset, decimals: 0 };
    // A careful cheat: recompute the amount consistently from the falsified asset, so only the asset check can catch it.
    op.request.asset = cheat;
    op.request.amountDue = fiatToAssetUnits(1_500_000n, CURRENCIES.NGN, cheat, rateFromString(op.request.effectiveRate));
    expect(op.request.amountDue).toBeLessThan(100n); // the point of the attack
    const res = await receiver.apply(op);
    expect(res.status).toBe('rejected');
    expect(reasonOf(res)).toContain('not one this server prices');
  });

  it('accepts a custom asset only when the server is told about it', async () => {
    const custom = { symbol: 'XYZ', chain: 'tron', decimals: 6, contract: 'TXYZ' };
    const { receiver, fresh } = await fixture({ allowedAssets: [custom] });
    // The real USDT sale is now NOT in the allowed list, so it is refused...
    expect((await receiver.apply(fresh())).status).toBe('rejected');
  });

  it('cannot extend how long a locked rate is honoured', async () => {
    const { receiver, fresh } = await fixture();
    const op = fresh();
    op.request.expiresAt += 7 * 24 * 3_600_000; // "this quote is good for a week"
    const res = await receiver.apply(op);
    expect(res.status).toBe('rejected');
    expect(reasonOf(res)).toContain('outlives the rate');
  });

  it("cannot choose its own policy: the server's replaces it", async () => {
    const serverPolicy = withPolicy({ underpayment: { toleranceBps: 25 } });
    const { receiver, accepted, fresh } = await fixture({ policyFor: () => serverPolicy });
    const op = fresh();
    op.request.policy = withPolicy({ underpayment: { toleranceBps: 10_000 }, minConfirmations: 0 }); // "any payment, even 0, counts as paid"
    expect((await receiver.apply(op)).status).toBe('accepted');
    expect(accepted[0]!.policy.underpayment.toleranceBps).toBe(25);
    expect(accepted[0]!.policy.minConfirmations).toBe(1);
  });

  it("cannot reuse another payment's id to overwrite it", async () => {
    const { receiver, accepted, fresh } = await fixture();
    expect((await receiver.apply(fresh())).status).toBe('accepted');

    const hijack = fresh();
    hijack.opId = 'op_different';
    hijack.addressIndex += 1;
    hijack.request.addressIndex = hijack.addressIndex;
    hijack.request.address = 'fake:tron:000001'; // a different, validly derived address...
    // ...carrying the first payment's id:
    const res = await receiver.apply(hijack);
    expect(res.status).toBe('rejected');
    expect(reasonOf(res)).toContain('id is already in use');
    expect(accepted).toHaveLength(1);
  });

  it('also protects ids the receiver never saw itself, via lookupRequest (e.g. server-created payments)', async () => {
    const { chain, fresh, leases, engine } = await fixture();
    const op = fresh();
    const existing = { ...op.request, address: 'someone-elses-address' } as PaymentRequest;
    const receiver = new SyncReceiver({
      deriver: chain,
      leases,
      onAccepted: () => {},
      isKnownSnapshot: (h) => !!engine.log.get(h),
      lookupRequest: (id) => (id === op.request.id ? existing : undefined),
    });
    const res = await receiver.apply(op);
    expect(res.status).toBe('rejected');
    expect(reasonOf(res)).toContain('id is already in use');
  });

  it('still accepts an honest replay of the same op and id', async () => {
    const { receiver, fresh } = await fixture();
    expect((await receiver.apply(fresh())).status).toBe('accepted');
    expect((await receiver.apply(fresh())).status).toBe('duplicate');
  });
});

describe('per-request address sources (resolveDeriver)', () => {
  it("checks the address against the deriver chosen for that op, so one tenant's wallet can't stand in for another's", async () => {
    const other = new FakeChain('tron-other'); // a different wallet: derives different addresses
    const { chain, fresh, leases, engine } = await fixture();
    const mk = (resolve: SyncReceiverOptions['resolveDeriver']) =>
      new SyncReceiver({ deriver: chain, resolveDeriver: resolve, leases, onAccepted: () => {}, isKnownSnapshot: (h) => !!engine.log.get(h) });

    const wrong = await mk(() => other).apply(fresh());
    expect(wrong.status).toBe('rejected');
    expect(reasonOf(wrong)).toContain('does not derive');

    expect((await mk(() => chain).apply(fresh())).status).toBe('accepted');
    expect((await mk(() => undefined).apply(fresh())).status).toBe('accepted'); // undefined falls back to the default deriver
    expect((await mk(async () => chain).apply(fresh())).status).toBe('accepted'); // async resolvers work
  });

  it('concurrent retries of one op are applied exactly once, even with an async resolver', async () => {
    const { chain, fresh, leases, engine } = await fixture();
    let accepted = 0;
    const receiver = new SyncReceiver({
      deriver: chain,
      resolveDeriver: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return chain;
      },
      leases,
      onAccepted: () => void accepted++,
      isKnownSnapshot: (h) => !!engine.log.get(h),
    });
    const results = await Promise.all([receiver.apply(fresh()), receiver.apply(fresh()), receiver.apply(fresh())]);
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'duplicate', 'duplicate']);
    expect(accepted).toBe(1);
  });
});
