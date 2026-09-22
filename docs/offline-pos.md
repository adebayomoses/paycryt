# Offline-first POS

A till that stops working when the internet drops is a till that loses sales. `OfflinePOS` keeps creating valid, priced, payable requests with no network, and the server safely reconciles them afterwards.

## The flow

1. **Online, occasionally:** `cacheRates()` (or `cacheSnapshot()` with a snapshot fetched from your server) stores a hash-sealed rate snapshot on the device.
2. **Offline:** `createPayment()`
   - derives a deposit address from the merchant **xpub** at the next index in the device's *lease*, needing no network and no private key;
   - prices from the cached snapshot, adds an **offline safety margin** (default 150 bps) and shortens the expiry (default 30 min);
   - saves the request and queues a `SyncOp` with a random idempotency key.
3. **Customer pays on-chain** to that address. The till cannot see it yet, and that is fine.
4. **Back online:** `sync(transport)` replays the queue in order. Each op is `accepted`, `duplicate` (already applied) or `rejected` (with a reason). A network error stops the run and leaves the rest queued.
5. The server starts **watching** each accepted request. Because chain history is queryable, a payment made while the till was offline is found and evaluated against the request's own expiry, not the sync time.

## Why addresses never collide

Each device gets a disjoint slice of address indexes from `LeaseRegistry`:

```ts
const lease = leases.allocate('till-1', 500);   // { start: 0, end: 500 }
```

When a device runs out it throws `LeaseExhaustedError`; call `leases.renew()` while online. Old ranges stay valid so queued ops from before the renewal still sync.

## What the server checks (`SyncReceiver`)

A compromised or buggy device cannot get a bad request accepted:

| Check | Stops |
|---|---|
| Address index is inside the device's lease | using another device's addresses |
| `deriver.derive(index) === request.address` | payments to an attacker's address |
| No other request uses the address | address reuse |
| Rate lineage hashes verify (`verifyChain`) | edited rates |
| Last snapshot is the one the request cites | mismatched pricing |
| Root snapshot exists in *your* audit log (`isKnownSnapshot`) | invented rates: a hash proves integrity, not origin |
| Extra spread within `maxOfflineSpreadBps` (default 500) | under-charging via a negative margin |
| `amountDue` recomputed from the rate | under-charging by editing the amount |
| `opId` not seen before | double-applying a retried op |

## Tuning

| Option | Default | Meaning |
|---|---|---|
| `offlineSpreadBps` | 150 | Extra margin for price moves you cannot see. |
| `offlineExpiryMs` | 30 min | How long an offline-priced request stays payable. |
| `maxRateAgeMs` | 6 h | Refuse to price from a cached rate older than this (`RateTooStaleError`). |
| `isOnline` | offline | If it returns true, no margin is added (a lapsed lock is re-locked at the same market rate). |

## Storage

`KVStore` is a four-method interface. `MemoryStore` is for tests; `SqliteStore` (in `@paycryt/adapters`, backed by Node's built-in `node:sqlite`) is a real backend for a Node-based till. On mobile or in a browser, implement it over IndexedDB or AsyncStorage. Values are serialised with `toJson`/`fromJson`, which preserve `bigint`. See [docs/persistence.md](persistence.md).

## Limitations (alpha)

- Address derivers exist for **EVM**, **Tron** and **Bitcoin** (`EvmXpubDeriver`, `TronXpubDeriver`, `BtcXpubDeriver`) — see [docs/evm.md](evm.md), [docs/tron.md](tron.md), [docs/bitcoin.md](bitcoin.md).
- The cashier still needs some way to learn a payment landed (a phone with data, or waiting for sync). Offline mode makes *taking* the order robust; it cannot make an unseen chain visible.
- Rejected ops are kept in `pos.rejected()`. Show them to the cashier: the customer may already have paid an address the server refused.
