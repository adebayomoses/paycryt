import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@paycryt/core';
import { EvmRpcChainAdapter } from '@paycryt/adapters';

const DEPOSIT_ADDRESS = '0x8feab81d36e7576107d5de0758c1b839be31b4f6'; // the real "to" address from REAL_LOG's topics[2]
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// Real log captured live from Ethereum mainnet via https://ethereum-rpc.publicnode.com (2026-09-22), a genuine
// USDT Transfer to DEPOSIT_ADDRESS at block 0x18d3375 (26030965). Value and topic hash are the real on-chain bytes.
const REAL_LOG = {
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0x000000000000000000000000915fd34cadd63907b51eb64dddc2eadd114a0bed',
    '0x0000000000000000000000008feab81d36e7576107d5de0758c1b839be31b4f6',
  ],
  data: '0x00000000000000000000000000000000000000000000000000000000033dbb03', // 54,377,219 base units
  blockNumber: '0x18d3375', // 26,030,965
  transactionHash: '0xd777c87ad781290fda9e697217fca39953748b9828aa6ffc4bb7e93622b2b291',
  removed: false,
};
const CURRENT_BLOCK = '0x18d3389'; // 26,030,985 — 21 blocks after the log
const BLOCK_TIMESTAMP = '0x6ab212ff'; // 1,790,055,167 — the log's real block_timestamp

interface Call {
  body: any;
}

function mockRpc(handlers: { logs?: unknown[]; blockNumber?: string; onBatch?: (ids: number[], nums: number[]) => any[] }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ body });
    if (Array.isArray(body)) {
      // batch: eth_getBlockByNumber requests
      const nums = body.map((b: any) => parseInt(b.params[0], 16));
      const ids = body.map((b: any) => b.id);
      const results = handlers.onBatch ? handlers.onBatch(ids, nums) : ids.map((id: number) => ({ id, result: { timestamp: BLOCK_TIMESTAMP } }));
      return { ok: true, status: 200, json: async () => results, text: async () => '' };
    }
    if (body.method === 'eth_blockNumber') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: handlers.blockNumber ?? CURRENT_BLOCK }), text: async () => '' };
    }
    if (body.method === 'eth_getLogs') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: handlers.logs ?? [] }), text: async () => '' };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  return { fetch, calls };
}

describe('EvmRpcChainAdapter', () => {
  it('parses a real captured Transfer log into a ChainDeposit with real block-based confirmations', async () => {
    const { fetch, calls } = mockRpc({ logs: [REAL_LOG] });
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' });
    const deposits = await adapter.getDeposits(DEPOSIT_ADDRESS, 'USDT');

    expect(deposits).toEqual([
      {
        txId: REAL_LOG.transactionHash,
        address: DEPOSIT_ADDRESS,
        assetSymbol: 'USDT',
        amount: 54_377_219n,
        confirmations: 21, // 26,030,985 - 26,030,965 + 1
        receivedAt: 1_790_055_167_000,
      },
    ]);

    const logsCall = calls.find((c) => c.body.method === 'eth_getLogs')!;
    expect(logsCall.body.params[0].address).toBe(USDT_CONTRACT);
    expect(logsCall.body.params[0].topics[0]).toBe(REAL_LOG.topics[0]);
    expect(logsCall.body.params[0].topics[2]).toBe(`0x000000000000000000000000${DEPOSIT_ADDRESS.slice(2).toLowerCase()}`);
  });

  it('returns nothing when there are no matching logs, with no extra block-timestamp calls', async () => {
    const { fetch, calls } = mockRpc({ logs: [] });
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' });
    const deposits = await adapter.getDeposits(DEPOSIT_ADDRESS, 'USDT');
    expect(deposits).toEqual([]);
    expect(calls.some((c) => Array.isArray(c.body))).toBe(false);
  });

  it('drops removed (reorged-out) logs', async () => {
    const { fetch } = mockRpc({ logs: [{ ...REAL_LOG, removed: true }] });
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' });
    expect(await adapter.getDeposits(DEPOSIT_ADDRESS, 'USDT')).toEqual([]);
  });

  it('batches timestamp lookups for several distinct blocks in one request', async () => {
    const logB = { ...REAL_LOG, transactionHash: '0xb2', blockNumber: '0x18d3376' }; // next block
    let batchSizes: number[] = [];
    const { fetch } = mockRpc({
      logs: [REAL_LOG, logB],
      onBatch: (ids, nums) => {
        batchSizes.push(ids.length);
        return ids.map((id, i) => ({ id, result: { timestamp: nums[i] === 0x18d3376 ? '0x6ab21302' : BLOCK_TIMESTAMP } }));
      },
    });
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' });
    const deposits = await adapter.getDeposits(DEPOSIT_ADDRESS, 'USDT');
    expect(batchSizes).toEqual([2]); // one batched call covering both distinct blocks
    expect(deposits.map((d) => d.receivedAt).sort()).toEqual([1_790_055_167_000, 1_790_055_170_000]);
  });

  it('chunks eth_getLogs when the range exceeds maxBlockRange', async () => {
    const calls: any[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      calls.push(body);
      if (Array.isArray(body)) return { ok: true, status: 200, json: async () => [], text: async () => '' };
      if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ result: '0x64' }), text: async () => '' }; // block 100
      if (body.method === 'eth_getLogs') return { ok: true, status: 200, json: async () => ({ result: [] }), text: async () => '' };
      throw new Error('unexpected');
    };
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum', lookbackBlocks: 100, maxBlockRange: 30 });
    await adapter.getDeposits(DEPOSIT_ADDRESS, 'USDT');
    const logCalls = calls.filter((c) => c.method === 'eth_getLogs');
    expect(logCalls).toHaveLength(4); // 100 blocks / 30 per chunk, rounded up
    expect(logCalls[0].params[0].fromBlock).toBe('0x0');
    expect(logCalls.at(-1)!.params[0].toBlock).toBe('0x64');
  });

  it('rejects an asset with no configured contract', async () => {
    const { fetch } = mockRpc({});
    await expect(new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' }).getDeposits(DEPOSIT_ADDRESS, 'DOGE')).rejects.toThrow(/no ERC20 contract configured/);
  });

  it('requires an explicit lookbackBlocks for a chain with no built-in default', () => {
    const { fetch } = mockRpc({});
    expect(() => new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'arbitrum' })).toThrow(/no default lookbackBlocks/);
  });

  it('uses built-in per-chain defaults for ethereum, base and bsc', () => {
    const { fetch } = mockRpc({});
    for (const chain of ['ethereum', 'base', 'bsc']) {
      expect(() => new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain })).not.toThrow();
    }
  });

  it('accepts a custom contract map, overriding the per-chain defaults', async () => {
    const customLog = { ...REAL_LOG, transactionHash: '0xcustom' };
    const { fetch, calls } = mockRpc({ logs: [customLog] });
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum', contracts: { MYTOKEN: '0x1111111111111111111111111111111111111111'.slice(0, 42) } });
    await adapter.getDeposits(DEPOSIT_ADDRESS, 'MYTOKEN');
    const logsCall = calls.find((c) => c.body.method === 'eth_getLogs')!;
    expect(logsCall.body.params[0].address.toLowerCase()).toBe('0x1111111111111111111111111111111111111111'.slice(0, 42).toLowerCase());
  });

  it('surfaces RPC and HTTP errors instead of swallowing them', async () => {
    const httpFail: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    await expect(new EvmRpcChainAdapter({ fetch: httpFail, rpcUrl: 'https://rpc.test', chain: 'ethereum' }).getDeposits(DEPOSIT_ADDRESS, 'USDT')).rejects.toThrow(/HTTP 500/);

    const rpcFail: FetchLike = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ error: { message: 'boom' } }), text: async () => '' };
      throw new Error('unexpected');
    };
    await expect(new EvmRpcChainAdapter({ fetch: rpcFail, rpcUrl: 'https://rpc.test', chain: 'ethereum' }).getDeposits(DEPOSIT_ADDRESS, 'USDT')).rejects.toThrow(/boom/);
  });

  it('rejects a malformed address', async () => {
    const { fetch } = mockRpc({});
    const adapter = new EvmRpcChainAdapter({ fetch, rpcUrl: 'https://rpc.test', chain: 'ethereum' });
    await expect(adapter.getDeposits('not-an-address', 'USDT')).rejects.toThrow(/Invalid EVM address/);
  });
});
