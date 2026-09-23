import { fromJson, toJson, type KVStore } from '@paycryt/core';

export interface IndexedDbStoreOptions {
  /** Default 'paycryt'. Use a different name to run several independent stores in one origin. */
  dbName?: string;
  /**
   * Default 'kv'. Keep this the same across every `IndexedDbStore` that shares a `dbName` — like
   * `SqliteStore`, this class uses one object store per database, with keys namespaced by prefix
   * (`payment:`, `rate:`, ...), not one store per concern. Mixing `storeName`s under one `dbName` needs
   * a version bump that an already-open connection can block; this class doesn't attempt that.
   */
  storeName?: string;
}

function getIndexedDb(): IDBFactory {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) throw new Error('IndexedDbStore needs a global `indexedDB` — a browser, a WebView, or a polyfill like fake-indexeddb under Node/tests.');
  return idb;
}

/**
 * A `KVStore` backed by IndexedDB, for `OfflinePOS` running in a browser or a WebView-based POS app
 * (the till a cashier actually uses). Values are serialised with `toJson`/`fromJson` — the same as
 * `MemoryStore` and `SqliteStore` — so a payment queue behaves identically no matter which backend an
 * app is built on, rather than depending on IndexedDB's own structured-clone bigint support.
 *
 * Verified against a real browser (chromium, via IndexedDB directly — not a Node polyfill): open, get,
 * set, overwrite, delete, prefix `keys()`, and that data survives a page navigation to the same origin.
 */
export class IndexedDbStore implements KVStore {
  private readonly dbName: string;
  private readonly storeName: string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(opts: IndexedDbStoreOptions = {}) {
    this.dbName = opts.dbName ?? 'paycryt';
    this.storeName = opts.storeName ?? 'kv';
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.request<string | undefined>('readonly', (store) => store.get(key));
    return raw === undefined ? undefined : fromJson<T>(raw);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.request('readwrite', (store) => store.put(toJson(value), key));
  }

  async delete(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(key));
  }

  /** Full-store scan, filtered by prefix client-side — simple and correct for any prefix, including one containing special characters. */
  async keys(prefix: string): Promise<string[]> {
    const all = await this.request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return (all as string[]).filter((k) => k.startsWith(prefix)).sort();
  }

  /** Closes the underlying IndexedDB connection. Safe to call even if nothing was ever opened. */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    (await this.dbPromise).close();
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = getIndexedDb().open(this.dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(this.storeName)) req.result.createObjectStore(this.storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
        req.onblocked = () =>
          reject(new Error(`IndexedDB open of "${this.dbName}" blocked — another connection is holding it open at an older version.`));
      });
    }
    return this.dbPromise;
  }

  private async request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const req = run(tx.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }
}
