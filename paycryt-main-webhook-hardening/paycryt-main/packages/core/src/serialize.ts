/** JSON that survives bigint. Use for anything persisted or sent between a POS device and the server. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
}

export function fromJson<T>(text: string): T {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === 'object' && typeof (v as { $bigint?: unknown }).$bigint === 'string' ? BigInt((v as { $bigint: string }).$bigint) : v,
  ) as T;
}

/** Minimal async key-value store. Implement over SQLite, IndexedDB, AsyncStorage, or a file. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, sorted ascending. */
  keys(prefix: string): Promise<string[]>;
}

/** In-memory store that round-trips through JSON, so it catches values a real disk-backed store could not persist. */
export class MemoryStore implements KVStore {
  private readonly data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : fromJson<T>(raw);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, toJson(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
