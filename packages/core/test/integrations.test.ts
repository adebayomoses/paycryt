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

  it('accepts any of several secrets, so a receiver can rotate without downtime', () => {
    const sig = signWebhook('new-secret', body, 1_700_000_000);
    const now = { nowSec: 1_700_000_010 };
    expect(verifyWebhook(['old-secret', 'new-secret'], body, sig, now)).toBe(true);
    expect(verifyWebhook(['old-secret', 'other'], body, sig, now)).toBe(false);
    expect(verifyWebhook([], body, sig, now)).toBe(false);
    expect(verifyWebhook([''], body, sig, now)).toBe(false);
  });

  it('accepts a header carrying several v1 signatures if any one matches', () => {
    const old = signWebhook('old-secret', body, 1_700_000_000).split(',')[1]!;
    const fresh = signWebhook('new-secret', body, 1_700_000_000);
    const both = `${fresh},${old}`;
    const now = { nowSec: 1_700_000_010 };
    expect(verifyWebhook('new-secret', body, both, now)).toBe(true);
    expect(verifyWebhook('old-secret', body, both, now)).toBe(true);
    expect(verifyWebhook('neither', body, both, now)).toBe(false);
  });

  it('returns false, never throws, on malformed headers', () => {
    const now = { nowSec: 1_700_000_010 };
    for (const h of ['', 'garbage', 't=,v1=', 't=abc,v1=00', 't=1700000000', 'v1=00', 't=-5,v1=00', 't=1e9,v1=00', 't=1700000000,v1=', ',,,', '=,=']) {
      expect(verifyWebhook('s3cret', body, h, now), h).toBe(false);
    }
    expect(verifyWebhook('s3cret', body, undefined as unknown as string, now)).toBe(false);
  });

  it('tolerates spaces after commas in the header', () => {
    const [t, v1] = signWebhook('s3cret', body, 1_700_000_000).split(',');
    expect(verifyWebhook('s3cret', body, `${t}, ${v1}`, { nowSec: 1_700_000_010 })).toBe(true);
  });

  it('sends with a timeout signal and does not follow redirects', async () => {
    let seen: { redirect?: string; signal?: AbortSignal } = {};
    const fetch: FetchLike = async (_url, init) => {
      seen = { redirect: init!.redirect, signal: init!.signal };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const d = new WebhookDispatcher({ url: 'https://merchant.test/hook', secret: 'k', fetch });
    expect(await d.send({ id: 'evt_t' })).toBe(true);
    expect(seen.redirect).toBe('manual');
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  it('counts a hung endpoint as a failed attempt and retries instead of stalling', async () => {
    let calls = 0;
    const fetch: FetchLike = (_url, init) => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timed out'))));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    };
    const d = new WebhookDispatcher({ url: 'https://merchant.test/hook', secret: 'k', fetch, timeoutMs: 20, backoffMs: [1], sleep: async () => {} });
    expect(await d.send({ id: 'evt_hang' })).toBe(true);
    expect(calls).toBe(2);
    expect(d.log[0]).toMatchObject({ ok: false, error: 'timed out' });
  });

  it('counts a 3xx as a failed attempt', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 302, json: async () => ({}), text: async () => '' });
    const d = new WebhookDispatcher({ url: 'https://merchant.test/hook', secret: 'k', fetch, backoffMs: [1], sleep: async () => {} });
    expect(await d.send({ id: 'evt_redir' })).toBe(false);
    expect(d.log.every((a) => a.status === 302 && !a.ok)).toBe(true);
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
