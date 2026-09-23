import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbStore } from '@paycryt/adapters';

// fake-indexeddb/auto installs a fresh in-memory IndexedDB on `globalThis`. Reset the specific
// databases each test uses so tests don't leak state into one another.
async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('IndexedDbStore', () => {
  afterEach(async () => {
    await deleteDb('paycryt');
    await deleteDb('custom-db');
  });

  it('gets, sets, overwrites and deletes values, round-tripping bigint', async () => {
    const store = new IndexedDbStore();
    expect(await store.get('missing')).toBeUndefined();

    await store.set('k1', { amount: 123n, label: 'ten USDT' });
    const v = await store.get<{ amount: bigint; label: string }>('k1');
    expect(v).toEqual({ amount: 123n, label: 'ten USDT' });
    expect(typeof v!.amount).toBe('bigint');

    await store.set('k1', { amount: 456n, label: 'updated' });
    expect(await store.get('k1')).toEqual({ amount: 456n, label: 'updated' });

    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
    await store.close();
  });

  it('lists keys by prefix, sorted, excluding non-matching keys', async () => {
    const store = new IndexedDbStore();
    await store.set('payment:b', 2);
    await store.set('payment:a', 1);
    await store.set('rate:USDT/NGN', 3);
    expect(await store.keys('payment:')).toEqual(['payment:a', 'payment:b']);
    expect(await store.keys('rate:')).toEqual(['rate:USDT/NGN']);
    expect(await store.keys('nope:')).toEqual([]);
    await store.close();
  });

  it('handles a prefix containing characters that would need escaping in a LIKE-style scan', async () => {
    const store = new IndexedDbStore();
    await store.set('weird%_key:1', 'a');
    await store.set('weird_other:2', 'b');
    expect(await store.keys('weird%_key:')).toEqual(['weird%_key:1']);
    await store.close();
  });

  it('persists across separate IndexedDbStore instances against the same database name', async () => {
    const first = new IndexedDbStore({ dbName: 'custom-db' });
    await first.set('req:1', { id: 'req_1', amountDue: 10_000_000n });
    await first.close();

    const second = new IndexedDbStore({ dbName: 'custom-db' });
    expect(await second.get('req:1')).toEqual({ id: 'req_1', amountDue: 10_000_000n });
    await second.close();
  });

  it('keeps independent databases separate by dbName', async () => {
    const a = new IndexedDbStore({ dbName: 'custom-db' });
    const b = new IndexedDbStore();
    await a.set('shared-key', 'in-custom-db');
    expect(await b.get('shared-key')).toBeUndefined();
    await a.close();
    await b.close();
  });

  it('works with a non-default storeName, consistently used across instances sharing a dbName', async () => {
    const first = new IndexedDbStore({ dbName: 'custom-db', storeName: 'requests' });
    await first.set('k', 'a request');
    await first.close();

    const second = new IndexedDbStore({ dbName: 'custom-db', storeName: 'requests' });
    expect(await second.get('k')).toBe('a request');
    await second.close();
  });
});

describe('IndexedDbStore without a global indexedDB', () => {
  it('throws a clear error instead of crashing obscurely', async () => {
    const saved = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).indexedDB;
    try {
      const store = new IndexedDbStore();
      await expect(store.get('x')).rejects.toThrow(/needs a global `indexedDB`/);
    } finally {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved;
    }
  });
});
