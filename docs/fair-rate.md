# Fair-rate audit trail

When a customer asks "why did I pay 10.24 USDT for ₦15,000?", you should be able to answer with evidence, months later.

## What gets recorded

Every call to `RateEngine.getSnapshot()` produces a `RateSnapshot`:

```jsonc
{
  "base": "USDT", "quote": "NGN", "direction": "CRYPTO_TO_FIAT",
  "quotes":   [{ "source": "exchange", "price": "1498", "asOf": 1790000000000 },
               { "source": "parallel-market", "price": "1506", "asOf": 1790000000000 }],
  "rejected": [{ "source": "typo-feed", "reason": "outlier: 903 bps from median" }],
  "aggregation": "median",
  "mid": "1502",
  "spreadBps": 100,
  "effectiveRate": "1486.98",          // what the customer was actually charged
  "createdAt": 1790000000000, "lockedUntil": 1790000900000,
  "prevHash": "…",                      // link to the previous snapshot
  "hash": "…"                           // sha256 of everything above
}
```

Each payment request stores `rateSnapshotHash`, so any charge can be traced to the exact inputs behind it.

## How the rate is chosen

1. Ask every `RateProvider` (cached for `quoteTtlMs`, default 30 s). Failures and stale quotes (`maxQuoteAgeMs`) are recorded, not fatal.
2. Take the median, drop quotes more than `maxDeviationBps` (default 300 = 3%) from it, and take the median again.
3. Require at least `minSources` survivors.
4. Apply your `spreadBps` **against the customer**: below mid when they pay crypto for a fiat bill (`CRYPTO_TO_FIAT`), above mid when they buy crypto (`FIAT_TO_CRYPTO`).

Add a parallel-market source (`ParallelMarketRateProvider`) beside official exchanges, and the median naturally reflects what customers experience while the outlier filter guards against a bad feed.

## Tamper evidence

- `verifySnapshot(s)`: the contents still match the hash.
- `verifyChain(list)` / `engine.log.verify()`: every `prevHash` points at its predecessor, so deleting or editing an old snapshot breaks the chain from that point on.
- Derived snapshots (offline margin, re-locks) record `derivedFrom: { hash, reason }` and chain to their parent.

**What this does and does not prove.** It proves the log has not been altered since it was written, and shows the inputs. It does not prove the *sources* were honest. To make the log externally credible, publish the head hash periodically (a commit, a tweet, a timestamping service) so that history cannot be silently rewritten.

## API

```ts
const engine = new RateEngine({ providers, spreadBps: 100, minSources: 2 });
const snap = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
engine.log.get(snap.hash);   // look it up later
engine.log.verify();         // { ok: true }
```

The reference server exposes `GET /v1/rates/USDT-NGN`, `GET /v1/audit/rates` and `GET /v1/audit/rates/:hash`.
