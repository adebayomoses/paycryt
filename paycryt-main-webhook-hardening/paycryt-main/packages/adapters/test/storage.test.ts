import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@paycryt/adapters';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paycryt-sqlite-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteStore', () => {
  it('gets, sets and deletes values, round-tripping bigint', async () => {
    const store = new SqliteStore(':memory:');
    expect(await store.get('missing')).toBeUndefined();

    await store.set('k1', { amount: 123n, label: 'ten USDT' });
    const v = await store.get<{ amount: bigint; label: string }>('k1');
    expect(v).toEqual({ amount: 123n, label: 'ten USDT' });
    expect(typeof v!.amount).toBe('bigint');

    await store.set('k1', { amount: 456n, label: 'updated' }); // overwrite
    expect(await store.get('k1')).toEqual({ amount: 456n, label: 'updated' });

    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
    store.close();
  });

  it('lists keys by prefix, sorted, excluding non-matching keys', async () => {
    const store = new SqliteStore(':memory:');
    await store.set('payment:a', 1);
    await store.set('payment:b', 2);
    await store.set('rate:USDT/NGN', 3);
    expect(await store.keys('payment:')).toEqual(['payment:a', 'payment:b']);
    expect(await store.keys('rate:')).toEqual(['rate:USDT/NGN']);
    expect(await store.keys('nope:')).toEqual([]);
    store.close();
  });

  it('escapes LIKE metacharacters in the prefix itself', async () => {
    const store = new SqliteStore(':memory:');
    await store.set('weird%_key:1', 'a');
    await store.set('weird_other:2', 'b'); // must NOT match a "weird%_key:" prefix scan
    expect(await store.keys('weird%_key:')).toEqual(['weird%_key:1']);
    store.close();
  });

  it('persists to a real file across separate instances', async () => {
    const path = join(dir, 'data.sqlite');
    const first = new SqliteStore(path);
    await first.set('req:1', { id: 'req_1', amountDue: 10_000_000n });
    first.close();

    const second = new SqliteStore(path);
    expect(await second.get('req:1')).toEqual({ id: 'req_1', amountDue: 10_000_000n });
    second.close();
  });

  it('creates the schema idempotently (safe to open the same file twice)', async () => {
    const path = join(dir, 'idempotent.sqlite');
    const a = new SqliteStore(path);
    await a.set('x', 1);
    a.close();
    const b = new SqliteStore(path); // should not throw on CREATE TABLE IF NOT EXISTS
    expect(await b.get('x')).toBe(1);
    b.close();
  });
});
