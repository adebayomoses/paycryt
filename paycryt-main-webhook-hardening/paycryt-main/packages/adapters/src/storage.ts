import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { fromJson, toJson, type KVStore } from '@paycryt/core';

/**
 * Loaded via `process.getBuiltinModule` (Node 22.3+) rather than a static `import ... from 'node:sqlite'`.
 * A static import of this module trips up some bundlers/test runners whose builtin-module list predates
 * node:sqlite (added in Node 22.5) — they try to resolve it as a bare npm package named "sqlite" and fail.
 * `getBuiltinModule` is a plain runtime lookup, so there is no import specifier for a bundler to mis-resolve.
 */
function loadSqliteModule(): { DatabaseSync: typeof DatabaseSync } {
  const mod = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as { DatabaseSync: typeof DatabaseSync } | undefined;
  if (!mod) throw new Error('SqliteStore needs Node 22.3+ (process.getBuiltinModule) with node:sqlite (Node 22.5+). Use a different KVStore backend on older Node.');
  return mod;
}

export interface SqliteStoreOptions {
  /** A file path, or ':memory:' for an ephemeral in-process database (handy for tests). */
  path: string;
}

/** Escapes `%`, `_` and `\` so a prefix can be used safely in a `LIKE ... ESCAPE '\'` clause. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A `KVStore` backed by Node's built-in SQLite module (`node:sqlite`) — no native dependency to compile,
 * no extra package to install. Works with `OfflinePOS` on a Node-based till, or as a `PaycrytServer`
 * `store` so payments, the rate audit trail and address leases all survive a restart.
 *
 * `node:sqlite` is an experimental Node API (stable since roughly Node 22.5, still flagged experimental
 * as of Node 24). If you'd rather depend on a mature, non-experimental driver, implement `KVStore` over
 * `better-sqlite3` or any other backend instead — the interface is deliberately small.
 */
export class SqliteStore implements KVStore {
  private readonly db: DatabaseSync;
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly scanStmt: StatementSync;

  constructor(opts: SqliteStoreOptions | string) {
    const path = typeof opts === 'string' ? opts : opts.path;
    const { DatabaseSync } = loadSqliteModule();
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.getStmt = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this.setStmt = this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.deleteStmt = this.db.prepare('DELETE FROM kv WHERE key = ?');
    this.scanStmt = this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key");
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    return row === undefined ? undefined : fromJson<T>(row.value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.setStmt.run(key, toJson(value));
  }

  async delete(key: string): Promise<void> {
    this.deleteStmt.run(key);
  }

  async keys(prefix: string): Promise<string[]> {
    const rows = this.scanStmt.all(`${escapeLike(prefix)}%`) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /** Closes the underlying database file. Call this when shutting down a server that owns the store. */
  close(): void {
    this.db.close();
  }
}
