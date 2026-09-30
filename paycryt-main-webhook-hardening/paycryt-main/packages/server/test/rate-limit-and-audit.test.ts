import { afterEach, describe, expect, it } from 'vitest';
import { evmAccountXpub, tronAccountXpub } from '@paycryt/core';
import type { ServerConfig } from '@paycryt/server';
import { PaycrytServer } from '@paycryt/server';

const DEV = 'test test test test test test test test test test test junk';
const EVM_XPUB = evmAccountXpub(DEV);
const TRON_XPUB = tronAccountXpub(DEV);

let server: PaycrytServer | undefined;

async function boot(overrides: Partial<ServerConfig> = {}) {
  server = await PaycrytServer.create({ apiKey: 'admin_key_0123456789abcdef', sandbox: true, spreadBps: 100, ...overrides });
  const url = `http://127.0.0.1:${await server.listen(0)}`;
  return { url, server };
}

async function call(url: string, key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => null) };
}

const ADMIN = 'admin_key_0123456789abcdef';

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('request rate limiting', () => {
  it('is off by default: a burst of requests is never throttled', async () => {
    const { url } = await boot();
    for (let i = 0; i < 20; i++) expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200);
  });

  it('answers 429 with Retry-After once a key exceeds its budget, and lets it through again after refilling', async () => {
    const { url } = await boot({ requestsPerMinute: 60, requestBurst: 2 }); // 1/sec, burst 2
    expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200);
    expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200);
    const blocked = await call(url, ADMIN, 'GET', '/v1/payments');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Rate limit exceeded');
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1100)); // long enough for one token to refill at 1/sec
    expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200);
  });

  it('tracks the admin key and each merchant key in separate buckets, so one exhausting theirs never blocks another', async () => {
    const { url } = await boot({ requestsPerMinute: 60, requestBurst: 2 });
    const m = await call(url, ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada' }); // spends one of the admin's 2 tokens
    const merchantKey = m.body.apiKey as string;

    expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200); // admin's last token
    expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(429); // admin bucket now exhausted
    expect((await call(url, merchantKey, 'GET', '/v1/payments')).status).toBe(200); // merchant's own bucket is untouched, full burst available
  });

  it('never limits /health, even past the budget', async () => {
    const { url } = await boot({ requestsPerMinute: 60, requestBurst: 1 });
    await call(url, ADMIN, 'GET', '/v1/payments');
    await call(url, ADMIN, 'GET', '/v1/payments'); // exhausts the admin bucket
    expect((await fetch(url + '/health')).status).toBe(200);
  });
});

describe('auth-failure rate limiting', () => {
  it('only counts failed attempts: a correct key is never throttled by it', async () => {
    const { url } = await boot({ authFailuresPerMinute: 2 });
    for (let i = 0; i < 10; i++) expect((await call(url, ADMIN, 'GET', '/v1/payments')).status).toBe(200);
  });

  it('answers 429 after repeated bad keys from the same caller, not a plain 401', async () => {
    const { url } = await boot({ authFailuresPerMinute: 2 });
    expect((await call(url, 'wrong-1', 'GET', '/v1/payments')).status).toBe(401);
    expect((await call(url, 'wrong-2', 'GET', '/v1/payments')).status).toBe(401);
    const third = await call(url, 'wrong-3', 'GET', '/v1/payments');
    expect(third.status).toBe(429);
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
  });

  it('is off by default', async () => {
    const { url } = await boot();
    for (let i = 0; i < 10; i++) expect((await call(url, 'nope', 'GET', '/v1/payments')).status).toBe(401);
  });
});

describe('admin audit log', () => {
  it('records merchant lifecycle actions, newest first, admin-only, never the secrets', async () => {
    const { url } = await boot();
    const created = await call(url, ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada Stores', wallets: { evm: EVM_XPUB } });
    const id = created.body.merchant.id as string;
    const originalKey = created.body.apiKey as string;

    const forbidden = await call(url, originalKey, 'GET', '/v1/admin/audit');
    expect(forbidden.status).toBe(403); // a merchant key can't read the operator's audit log

    await call(url, ADMIN, 'POST', `/v1/admin/merchants/${id}/wallets`, { evm: null, tron: TRON_XPUB });
    await call(url, ADMIN, 'POST', `/v1/admin/merchants/${id}/disable`);
    await call(url, ADMIN, 'POST', `/v1/admin/merchants/${id}/enable`);
    const rotated = await call(url, ADMIN, 'POST', `/v1/admin/merchants/${id}/rotate-key`);
    const apiKey = rotated.body.apiKey as string;

    const audit = await call(url, ADMIN, 'GET', '/v1/admin/audit');
    expect(audit.status).toBe(200);
    expect(audit.body.map((e: any) => e.action)).toEqual([
      'merchant.rotate-key',
      'merchant.enable',
      'merchant.disable',
      'merchant.wallets',
      'merchant.create',
    ]);
    expect(audit.body.every((e: any) => e.merchantId === id && e.actor === 'admin')).toBe(true);
    const raw = JSON.stringify(audit.body);
    expect(raw).not.toContain(apiKey); // never the merchant's API key
    expect(raw).not.toContain(EVM_XPUB); // never the wallet key value, just which family changed
    expect(raw).not.toContain(TRON_XPUB);
    const walletsEntry = audit.body.find((e: any) => e.action === 'merchant.wallets');
    expect(walletsEntry.detail).toEqual({ changed: { evm: 'removed', tron: 'set' } });
  });

  it('does not record a failed action, and respects ?limit=', async () => {
    const { url } = await boot();
    expect((await call(url, ADMIN, 'POST', '/v1/admin/merchants/mch_doesnotexist/disable')).status).toBe(404);
    expect((await call(url, ADMIN, 'GET', '/v1/admin/audit')).body).toEqual([]);

    for (let i = 0; i < 5; i++) await call(url, ADMIN, 'POST', '/v1/admin/merchants', { name: `M${i}` });
    const limited = await call(url, ADMIN, 'GET', '/v1/admin/audit?limit=2');
    expect(limited.body).toHaveLength(2);
    expect(limited.body[0].detail.name).toBe('M4'); // newest first
  });

  it('survives a real restart, over a real SQLite file', async () => {
    const { SqliteStore } = await import('@paycryt/adapters');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'paycryt-audit-'));
    const dbPath = join(dir, 'audit.db');
    try {
      const dbA = new SqliteStore(dbPath);
      const first = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store: dbA });
      const firstUrl = `http://127.0.0.1:${await first.listen(0)}`;
      await call(firstUrl, ADMIN, 'POST', '/v1/admin/merchants', { name: 'Persisted Co' });
      await first.close();
      dbA.close();

      const dbB = new SqliteStore(dbPath); // a genuinely separate SqliteStore instance over the same file
      const second = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store: dbB });
      const secondUrl = `http://127.0.0.1:${await second.listen(0)}`;
      const entries = (await call(secondUrl, ADMIN, 'GET', '/v1/admin/audit')).body;
      expect(entries).toHaveLength(1);
      expect(entries[0].detail.name).toBe('Persisted Co');
      await second.close();
      dbB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
