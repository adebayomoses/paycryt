import { describe, expect, it } from 'vitest';
import {
  FakeChain,
  MockSettlementProvider,
  PaymentWatcher,
  SettlementOrchestrator,
  WebhookDispatcher,
  signWebhook,
  verifyWebhook,
  type FetchLike,
} from '@paycryt/core';
import { makeRequest } from './helpers.js';

describe('webhooks', () => {
  const body = '{"id":"evt_1","type":"payment.confirmed"}';

  it('verifies a good signature and rejects tampering', () => {
    const sig = signWebhook('s3cret', body, 1_700_000_000);
    expect(verifyWebhook('s3cret', body, sig, { nowSec: 1_700_000_010 })).toBe(true);
    expect(verifyWebhook('wrong', body, sig, { nowSec: 1_700_000_010 })).toBe(false);
    expect(verifyWebhook('s3cret', body + ' ', sig, { nowSec: 1_700_000_010 })).toBe(false);
  });

  it('rejects replays of old deliveries', () => {
    const sig = signWebhook('s3cret', body, 1_700_000_000);
    expect(verifyWebhook('s3cret', body, sig, { nowSec: 1_700_000_000 + 3600 })).toBe(false);
  });

  it('retries with backoff, then succeeds, and can be replayed', async () => {
    let calls = 0;
    const seenSignatures: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls++;
      seenSignatures.push(init!.headers!['paycryt-signature']!);
      const ok = calls >= 3;
      return { ok, status: ok ? 200 : 500, json: async () => ({}), text: async () => '' };
    };
    const sleeps: number[] = [];
    const d = new WebhookDispatcher({ url: 'https://merchant.test/hook', secret: 'k', fetch, sleep: async (ms) => void sleeps.push(ms) });

    expect(await d.send({ id: 'evt_1', type: 'payment.confirmed' })).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 5_000]);
    expect(d.log.map((a) => a.ok)).toEqual([false, false, true]);
    expect(seenSignatures.every((s) => s.startsWith('t='))).toBe(true);

    expect(await d.replay('evt_1')).toBe(true);
    expect(calls).toBe(4);
  });

  it('gives up after the last retry', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
    const d = new WebhookDispatcher({ url: 'x', secret: 'k', fetch, backoffMs: [1, 1], sleep: async () => {} });
    expect(await d.send({ id: 'evt_2' })).toBe(false);
    expect(d.log).toHaveLength(3);
  });
});

describe('settlement orchestrator', () => {
  it('pays out fiat once when a payment is confirmed, even if the event replays', async () => {
    const { request, clock } = await makeRequest();
    const chain = new FakeChain('tron', clock.now);
    const watcher = new PaymentWatcher([chain], clock.now);
    watcher.watch(request);

    const provider = new MockSettlementProvider();
    const orch = new SettlementOrchestrator(
      provider,
      { destination: { type: 'mobile_money', operator: 'MTN', phone: '233240000000' }, feeBps: 100 },
      (id) => watcher.get(id)?.request,
    );
    watcher.on(orch.handle);

    chain.scenarios.exact(request);
    const [event] = await watcher.tick();
    await orch.handle(event!); // simulate a duplicate delivery

    expect(provider.payouts.size).toBe(1);
    const payout = [...provider.payouts.values()][0]!;
    expect(payout.request.amountMinor).toBe(1_485_000n); // NGN 15,000 less a 1% fee
    expect(payout.request.reference).toBe(`settle_${request.id}`);
    expect(payout.status).toBe('succeeded');
  });

  it('does not settle unpaid, refund or expired events', async () => {
    const { request, clock } = await makeRequest();
    const chain = new FakeChain('tron', clock.now);
    const watcher = new PaymentWatcher([chain], clock.now);
    watcher.watch(request);
    const provider = new MockSettlementProvider();
    const orch = new SettlementOrchestrator(provider, { destination: { type: 'bank', bankCode: '058', accountNumber: '0123456789' } }, (id) => watcher.get(id)?.request);
    watcher.on(orch.handle);

    chain.scenarios.underpay(request, 50);
    clock.set(request.expiresAt + request.policy.graceMs + 1);
    await watcher.tick();
    expect(provider.payouts.size).toBe(0);
  });
});
