# Persistence

The reference server (`PaycrytServer`) and `OfflinePOS` both talk to storage through the same small interface, `KVStore`:

```ts
interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}
```

`MemoryStore` (in `@paycryt/core`) implements it with nothing but a `Map`, for tests and quick demos. Two real backends live in `@paycryt/adapters`: `SqliteStore` for a Node-based server or till, and `IndexedDbStore` for a browser or WebView-based POS app — the till a cashier actually taps on.

## Using `IndexedDbStore`

```ts
import { IndexedDbStore } from '@paycryt/adapters';

const store = new IndexedDbStore(); // dbName 'paycryt', storeName 'kv' by default
```

Values are serialised with `toJson`/`fromJson` — the same as `MemoryStore` and `SqliteStore` — so a payment queue behaves identically no matter which backend an app is built on, rather than depending on IndexedDB's own structured-clone `bigint` support.

> **Verified in a real browser, not a Node polyfill.** A build of `IndexedDbStore` was loaded as a real ES module in a real browser page (Chromium, via an import map — no bundler), exercised through get/set/overwrite/delete/prefix-scan, then the page was navigated away and back to a fresh document. A brand-new `IndexedDbStore` instance in that fresh document read back a payment-request-shaped value with a `bigint` field, byte-for-byte and type-correct — genuine cross-navigation persistence, not just an in-memory reference surviving within one JS heap. (Vitest unit tests, which run under Node, use the standard `fake-indexeddb` polyfill instead.)

Keep one `storeName` per `dbName` for the lifetime of that database (see the JSDoc on `IndexedDbStoreOptions` for why) — this matches `SqliteStore`'s one-table, prefix-namespaced-keys design (`payment:`, `rate:`, ...), which is what `PaymentRequestStore`/`RateSnapshotStore`/`LeaseRegistryStore` already assume.

## Using `SqliteStore`

```ts
import { SqliteStore } from '@paycryt/adapters';

const store = new SqliteStore('/var/lib/paycryt/paycryt.sqlite'); // or ':memory:' for tests
```

> **`node:sqlite` is an experimental Node API** (available since ~Node 22.5, still flagged experimental as of Node 24). If you'd rather depend on a mature, non-experimental driver, implement `KVStore` over `better-sqlite3` or anything else — the interface is deliberately four methods, on purpose.

### With `OfflinePOS`

```ts
const pos = new OfflinePOS({
  deviceId: 'till-1',
  deriver,
  lease,
  store: new SqliteStore('/var/lib/paycryt/till-1.sqlite'), // was MemoryStore in the quick-start examples
});
```

### With the reference server

Pass `store` in `ServerConfig` and use the async `create()` factory (reloading persisted state needs an await, so plain `new PaycrytServer(...)` isn't available):

```ts
import { PaycrytServer } from '@paycryt/server';
import { SqliteStore } from '@paycryt/adapters';

const server = await PaycrytServer.create({
  apiKey: process.env.PAYCRYT_API_KEY!,
  store: new SqliteStore(process.env.PAYCRYT_DB_PATH!),
});
```

Or from the CLI, set `PAYCRYT_DB_PATH`:

```bash
PAYCRYT_DB_PATH=./paycryt.sqlite npm run sandbox
```

Omit `store` entirely and the server runs exactly as before — fully in-memory, nothing to configure. This is purely additive.

## What survives a restart, and what doesn't

| | Persisted? |
|---|---|
| Payment requests (amount due, address, expiry, policy, rate snapshot hash) | ✅ |
| The rate audit trail (every hash-chained snapshot, in order) | ✅ |
| Address leases (which index ranges each device/server has used) | ✅ |
| **Fake-chain sandbox deposit history** | ❌, on purpose |
| The sync-idempotency cache (which `opId`s were already applied) | ❌, harmlessly |

The fake chain was never meant to be durable — it exists to simulate a blockchain in tests and demos, and restarting the sandbox naturally resets it, the same way restarting a real chain's node would not erase the real chain. **On a real chain, the chain itself is the durable deposit history** — a real `ChainAdapter` (Tron/EVM/Bitcoin) re-discovers deposits by querying the chain again after a restart, so this limitation only affects the sandbox.

Not persisting the `opId` idempotency cache is a deliberate simplification, not a bug: if a device re-sends a sync operation it already sent before a restart, the server just re-validates it instead of instantly recognizing it as a duplicate. Validation still passes, because the address is already known to belong to that same request (rebuilt from the reloaded payment requests via `SyncReceiver.hydrate()`), and `watcher.watch()` is itself idempotent. The op is accepted again, harmlessly.

## How it fits together

On restart, `PaycrytServer.create()`:
1. Loads every stored `PaymentRequest` and hands each one to a fresh `PaymentWatcher` via `watch()` — which re-evaluates it for real against the chain on the very next `tick()`, rather than trusting stale in-memory state.
2. Replays every stored `RateSnapshot`, in order, into the `RateEngine`'s audit log — restoring the hash chain intact. If a corrupted chain is detected on reload, it logs a warning rather than refusing to start.
3. Restores the `LeaseRegistry` so no device is ever handed an address range that overlaps one it (or the server itself) already used.

Building your own server instead of using `PaycrytServer`? The three pieces — `PaymentRequestStore`, `RateSnapshotStore`, `LeaseRegistryStore` (all in `@paycryt/core`) — work the same way standalone, over any `KVStore`.

## Securing a persisted store

A populated store holds your complete payment history and rate audit trail — sensitive data. Treat the database file the same way you'd treat any other secret: restrict filesystem permissions, back it up somewhere access-controlled, and never commit it to source control. See [SECURITY.md](../SECURITY.md).
