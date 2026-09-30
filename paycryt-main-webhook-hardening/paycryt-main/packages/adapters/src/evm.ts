import { ASSETS, type Asset, type ChainAdapter, type ChainDeposit, type FetchLike } from '@paycryt/core';

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic. Verified live against real USDT logs. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Chains with a built-in `lookbackBlocks` default, tuned to comfortably outlive a payment's expiry + grace window. */
const DEFAULT_LOOKBACK_BLOCKS: Record<string, number> = {
  ethereum: 1_200, // ~4h at ~12s/block
  base: 7_200, // ~4h at ~2s/block
  bsc: 4_800, // ~4h at ~3s/block
};

function defaultContractsForChain(chain: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const asset of Object.values(ASSETS) as Asset[]) {
    if (asset.chain === chain && asset.contract) out[asset.symbol] = asset.contract;
  }
  return out;
}

/** Left-pads a 20-byte address to the 32-byte topic format eth_getLogs expects. */
function padTopicAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`Invalid EVM address: ${address}`);
  return `0x${'0'.repeat(24)}${hex}`;
}

export interface EvmRpcOptions {
  fetch: FetchLike;
  /** Your own node, or Alchemy/Infura/Ankr/etc. Public shared RPCs rate-limit and cap `eth_getLogs` ranges. */
  rpcUrl: string;
  /** Must match the `chain` field of the assets you watch on this instance, e.g. 'ethereum' | 'base' | 'bsc'. */
  chain: string;
  /** Symbol -> ERC20 contract address, merged over @paycryt/core's `ASSETS` for this chain. */
  contracts?: Record<string, string>;
  /** How many blocks back to scan on every poll. Required unless `chain` has a built-in default (ethereum/base/bsc). */
  lookbackBlocks?: number;
  /** `eth_getLogs` is split into ranges of at most this many blocks, for providers that cap the range. Default 2000. */
  maxBlockRange?: number;
}

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  removed?: boolean;
}

/**
 * Watches ERC-20 deposits over a plain JSON-RPC endpoint (`eth_getLogs` + `eth_getBlockByNumber`) — works
 * against Ethereum, Base, BNB Chain or any other EVM chain, given the right `rpcUrl` and `chain` name.
 *
 * Verified live: the Transfer topic hash, log shape, batch JSON-RPC requests and block timestamps were all
 * checked against a public Ethereum mainnet RPC and real USDT transfer logs. Not yet run against a real,
 * money-moving deposit end to end — treat it as EXPERIMENTAL.
 *
 * Unlike the Tron adapter, confirmations here are real: `currentBlock - logBlock + 1`, computed from the
 * chain itself rather than a synthetic weight.
 *
 * Out of scope: native-coin deposits (ETH/BNB itself, not a token) aren't ERC-20 Transfer events and need
 * separate transaction-receipt watching, which this adapter does not do.
 */
export class EvmRpcChainAdapter implements ChainAdapter {
  readonly chain: string;
  private readonly contracts: Record<string, string>;
  private readonly lookbackBlocks: number;
  private readonly maxBlockRange: number;
  private nextId = 0;

  constructor(private readonly opts: EvmRpcOptions) {
    this.chain = opts.chain;
    this.contracts = { ...defaultContractsForChain(opts.chain), ...opts.contracts };
    this.maxBlockRange = opts.maxBlockRange ?? 2_000;
    const lookback = opts.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS[opts.chain];
    if (!lookback) throw new Error(`EvmRpcChainAdapter: no default lookbackBlocks for chain "${opts.chain}"; pass one explicitly.`);
    this.lookbackBlocks = lookback;
  }

  async getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]> {
    const contract = this.contracts[assetSymbol];
    if (!contract) throw new Error(`EvmRpcChainAdapter (${this.chain}): no ERC20 contract configured for asset "${assetSymbol}"`);

    const currentBlock = await this.blockNumber();
    const fromBlock = Math.max(0, currentBlock - this.lookbackBlocks);
    const toTopic = padTopicAddress(address);

    const logs = (await this.getLogsChunked(contract, toTopic, fromBlock, currentBlock)).filter((l) => !l.removed);
    if (logs.length === 0) return [];

    const blockNumbers = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))];
    const timestamps = await this.blockTimestamps(blockNumbers);

    return logs.map((l) => {
      const blockNum = parseInt(l.blockNumber, 16);
      return {
        txId: l.transactionHash,
        address,
        assetSymbol,
        amount: BigInt(l.data),
        confirmations: Math.max(0, currentBlock - blockNum + 1),
        receivedAt: (timestamps.get(blockNum) ?? 0) * 1000,
      };
    });
  }

  private async blockNumber(): Promise<number> {
    return parseInt(await this.rpc<string>('eth_blockNumber', []), 16);
  }

  private async getLogsChunked(contract: string, toTopic: string, fromBlock: number, toBlock: number): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.maxBlockRange + 1) {
      const end = Math.min(start + this.maxBlockRange, toBlock);
      const chunk = await this.rpc<RawLog[]>('eth_getLogs', [
        { address: contract, topics: [TRANSFER_TOPIC, null, toTopic], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
      ]);
      out.push(...chunk);
    }
    return out;
  }

  /** One batched JSON-RPC request for every distinct block, instead of one round trip per log. */
  private async blockTimestamps(blockNumbers: number[]): Promise<Map<number, number>> {
    const batch = blockNumbers.map((n) => ({ jsonrpc: '2.0', id: ++this.nextId, method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] }));
    const res = await this.opts.fetch(this.opts.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
    if (!res.ok) throw new Error(`EVM RPC batch block lookup failed: HTTP ${res.status}`);
    const results = (await res.json()) as Array<{ id: number; result?: { timestamp: string }; error?: { message: string } }>;
    const blockById = new Map(batch.map((b, i) => [b.id, blockNumbers[i]!]));
    const out = new Map<number, number>();
    for (const r of results) {
      const blockNum = blockById.get(r.id);
      if (blockNum === undefined) continue;
      if (r.error) throw new Error(`EVM RPC eth_getBlockByNumber failed: ${r.error.message}`);
      out.set(blockNum, parseInt(r.result!.timestamp, 16));
    }
    return out;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.opts.fetch(this.opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }),
    });
    if (!res.ok) throw new Error(`EVM RPC ${method} failed: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`EVM RPC ${method} failed: ${json.error.message}`);
    return json.result as T;
  }
}
