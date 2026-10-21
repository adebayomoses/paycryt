import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@paycryt/core';
import { EvmRpcChainAdapter } from '@paycryt/adapters';

/**
 * Block-timestamp lookups for deposits. Found while reviewing a contributor's note on issue #4: the lookup sent every
 * log block in ONE batch (providers cap batches; a deposit address can be sprayed with dust transfers across many
 * blocks), mishandled a whole-batch rejection, and defaulted a missing timestamp to the epoch, which the payment
 * policy reads as "this deposit predates the request" and silently ignores. A customer who paid in full would be shown
 * as unpaid with no error anywhere.
 */

const ADDRESS = '0x8feab81d36e7576107d5de0758c1b839be31b4f6';
const HEAD = 0x100000;
/** Every block gets a distinct, predictable timestamp, so a mix-up between blocks (or batches) is caught. */
const tsOf = (block: number) => 1_790_000_000 + block;

type BatchMode = 'ok' | 'reverse' | 'drop-first' | 'null-first' | 'item-error' | 'zero-time' | 'garbage-time';

function provider(opts: { logs: number; batchCap?: number; mode?: BatchMode }) {
  const blocks = Array.from({ length: opts.logs }, (_, i) => HEAD - 10 - i);
  const batches: number[] = [];
  const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (Array.isArray(body)) {
      batches.push(body.length);
      if (opts.batchCap && body.length > opts.batchCap) {
        return reply({ jsonrpc: '2.0', id: null, error: { code: -32005, message: `batch too large (max ${opts.batchCap})` } });
      }
      let answers: any[] = body.map((r: any) => {
        const n = parseInt(r.params[0], 16);
        const time = opts.mode === 'zero-time' ? '0x0' : opts.mode === 'garbage-time' ? 'zz' : '0x' + tsOf(n).toString(16);
        return { jsonrpc: '2.0', id: r.id, result: { timestamp: time } };
      });
      if (opts.mode === 'reverse') answers = answers.reverse();
      if (opts.mode === 'drop-first') answers = answers.slice(1);
      if (opts.mode === 'null-first') answers[0] = { jsonrpc: '2.0', id: answers[0].id, result: null };
      if (opts.mode === 'item-error') answers[0] = { jsonrpc: '2.0', id: answers[0].id, error: { code: -32000, message: 'daily request limit reached' } };
      return reply(answers);
    }
    if (body.method === 'eth_blockNumber') return reply({ jsonrpc: '2.0', id: body.id, result: '0x' + HEAD.toString(16) });
    if (body.method === 'eth_getLogs') {
      const log = (b: number) => ({
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + ADDRESS.slice(2)],
        data: '0x' + (1_000_000n + BigInt(b)).toString(16).padStart(64, '0'),
        blockNumber: '0x' + b.toString(16),
        transactionHash: '0x' + b.toString(16).padStart(64, '0'),
        removed: false,
      });
      // Like a real provider, return only the logs inside the requested block range (the adapter scans in chunks).
      const { fromBlock, toBlock } = body.params[0] as { fromBlock: string; toBlock: string };
      const inRange = blocks.filter((n) => n >= parseInt(fromBlock, 16) && n <= parseInt(toBlock, 16));
      return reply({ jsonrpc: '2.0', id: body.id, result: inRange.map(log) });
    }
    throw new Error('unexpected ' + body.method);
  };
  return { fetch, batches, blocks };
}

const adapter = (fetch: FetchLike, extra: { maxBatchSize?: number } = {}) =>
  new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.example', chain: 'ethereum', lookbackBlocks: 5_000, ...extra });

describe('timestamp lookups are batched within provider limits', () => {
  it('splits a large lookup into chunks of at most 50 by default, and gives every deposit its own block\'s time', async () => {
    const p = provider({ logs: 130 });
    const deposits = await adapter(p.fetch).getDeposits(ADDRESS, 'USDT');
    expect(p.batches).toEqual([50, 50, 30]);
    expect(deposits).toHaveLength(130);
    for (const d of deposits) {
      const block = parseInt(d.txId.slice(2), 16);
      expect(d.receivedAt, `block ${block}`).toBe(tsOf(block) * 1000); // right block, right batch, nothing crossed over
    }
  });

  it('honours a smaller maxBatchSize', async () => {
    const p = provider({ logs: 25 });
    await adapter(p.fetch, { maxBatchSize: 10 }).getDeposits(ADDRESS, 'USDT');
    expect(p.batches).toEqual([10, 10, 5]);
  });

  it('works against a provider that refuses any batch over 100, which the old code could not', async () => {
    const p = provider({ logs: 300, batchCap: 100 });
    const deposits = await adapter(p.fetch).getDeposits(ADDRESS, 'USDT');
    expect(deposits).toHaveLength(300);
    expect(Math.max(...p.batches)).toBeLessThanOrEqual(50);
  });

  it('matches answers to blocks by id, not by position', async () => {
    const p = provider({ logs: 7, mode: 'reverse' });
    const deposits = await adapter(p.fetch).getDeposits(ADDRESS, 'USDT');
    for (const d of deposits) expect(d.receivedAt).toBe(tsOf(parseInt(d.txId.slice(2), 16)) * 1000);
  });

  it('sends nothing when there are no deposits', async () => {
    const p = provider({ logs: 0 });
    expect(await adapter(p.fetch).getDeposits(ADDRESS, 'USDT')).toEqual([]);
    expect(p.batches).toEqual([]);
  });

  it('validates maxBatchSize up front', () => {
    const p = provider({ logs: 0 });
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => adapter(p.fetch, { maxBatchSize: bad }), String(bad)).toThrow(/maxBatchSize/);
    expect(() => adapter(p.fetch, { maxBatchSize: 1 })).not.toThrow();
  });
});

describe('a lookup that cannot be answered completely is an error, never a guess', () => {
  it('explains a whole-batch rejection, and says which setting to change', async () => {
    const p = provider({ logs: 300, batchCap: 100 });
    const err = await adapter(p.fetch, { maxBatchSize: 500 }).getDeposits(ADDRESS, 'USDT').then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/rejected a batch of 300/);
    expect(err?.message).toContain('batch too large (max 100)'); // the provider's own words
    expect(err?.message).toContain('-32005');
    expect(err?.message).toMatch(/maxBatchSize/);
    expect(err).not.toBeInstanceOf(TypeError); // the old failure was "results is not iterable"
  });

  it('a missing answer is an error, so a paid-in-full deposit is never reported at the epoch', async () => {
    const p = provider({ logs: 5, mode: 'drop-first' });
    await expect(adapter(p.fetch).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/no answer for block/);
  });

  it('a block the node does not know yet (a node that is behind) is a clear, retryable error', async () => {
    const p = provider({ logs: 5, mode: 'null-first' });
    await expect(adapter(p.fetch).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/does not know block .* yet/);
  });

  it('a per-call provider error (a limit, an outage) still surfaces with the provider\'s message', async () => {
    const p = provider({ logs: 5, mode: 'item-error' });
    await expect(adapter(p.fetch).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/daily request limit reached/);
  });

  it('refuses a timestamp of zero or garbage rather than passing it on', async () => {
    await expect(adapter(provider({ logs: 3, mode: 'zero-time' }).fetch).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/no usable timestamp/);
    await expect(adapter(provider({ logs: 3, mode: 'garbage-time' }).fetch).getDeposits(ADDRESS, 'USDT')).rejects.toThrow(/no usable timestamp/);
  });

  it('never returns a deposit stamped with the epoch, in any failure mode', async () => {
    for (const mode of ['drop-first', 'null-first', 'item-error', 'zero-time', 'garbage-time'] as const) {
      const result = await adapter(provider({ logs: 4, mode }).fetch).getDeposits(ADDRESS, 'USDT').then((d) => d, () => 'threw');
      if (result !== 'threw') expect(result.every((d) => d.receivedAt > 0), mode).toBe(true);
    }
  });
});
