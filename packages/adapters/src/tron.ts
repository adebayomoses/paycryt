import type { ChainAdapter, ChainDeposit, FetchLike } from '@paycryt/core';

/** TRC20 contract addresses for symbols this adapter knows about. Matches `ASSETS.USDT_TRC20.contract` in @paycryt/core. */
const DEFAULT_CONTRACTS: Record<string, string> = {
  USDT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};

export interface TronGridOptions {
  fetch: FetchLike;
  /** Default: TronGrid's public endpoint. Point this at your own full node or a paid TronGrid plan. */
  baseUrl?: string;
  /** Sent as the `TRON-PRO-API-KEY` header. Free from the TronGrid dashboard; raises your rate limit. */
  apiKey?: string;
  /** Symbol -> TRC20 contract address, merged over the USDT default. */
  contracts?: Record<string, string>;
  /**
   * Fallback only. Confirmations are normally real: `chainTip - transactionBlock + 1`. If the block lookup
   * for a transfer fails (a rate-limited or unreachable node), a solidified transfer is reported with this
   * many confirmations instead — safe, because solidified means final — and an unconfirmed one with 0.
   * Set it at or above your `PaymentPolicy.minConfirmations`. Default 20.
   */
  confirmedWeight?: number;
  /** Transfers fetched per request. A freshly generated one-time deposit address rarely needs more. Default 200. */
  limit?: number;
  /** How long the chain-tip height is reused across lookups. A Tron block takes ~3s. Default 2500 ms. */
  tipCacheMs?: number;
  /** How many solidified transactions' block numbers are remembered (they never change). Default 5000. */
  blockCacheSize?: number;
  clock?: () => number;
}

interface TronGridTransfer {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  type: string;
  value: string;
}

interface TronGridResponse {
  success: boolean;
  data?: TronGridTransfer[];
  error?: string;
}

/** Block lookups per batch, so a busy address doesn't fire hundreds of requests at once. */
const LOOKUP_BATCH = 8;

/**
 * Watches TRC20 deposits (USDT and other tokens) via the public TronGrid API.
 *
 * **Confirmations are real.** TronGrid's transfer list says whether a transfer is solidified but not how
 * many blocks deep it is, so this adapter also asks the node for the chain tip (`/wallet/getnowblock`) and
 * for each transfer's block (`/wallet/gettransactioninfobyid`) and reports `tip - block + 1`, the same as
 * the EVM and Bitcoin adapters. Verified against the live API: a transfer 1,161 blocks back reported
 * 1,162 confirmations, and the solidified height sat 19 blocks behind the tip.
 *
 * Calls per check: two transfer lists, plus (only when there is something to report) one tip lookup that
 * is cached for a few seconds and one block lookup per transfer not seen before. A solidified transfer's
 * block never changes, so it is looked up once and remembered.
 *
 * Still EXPERIMENTAL: not yet run against a real, money-moving deposit end to end. No pagination beyond
 * `limit` (fine for one-time deposit addresses).
 */
export class TronGridChainAdapter implements ChainAdapter {
  readonly chain = 'tron';
  private readonly baseUrl: string;
  private readonly contracts: Record<string, string>;
  private readonly confirmedWeight: number;
  private readonly limit: number;
  private readonly tipCacheMs: number;
  private readonly blockCacheSize: number;
  private readonly clock: () => number;
  private tip?: { height: number; at: number };
  private readonly solidifiedBlocks = new Map<string, number>(); // txid -> block number; insertion-ordered for eviction

  constructor(private readonly opts: TronGridOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.trongrid.io';
    this.contracts = { ...DEFAULT_CONTRACTS, ...opts.contracts };
    this.confirmedWeight = opts.confirmedWeight ?? 20;
    this.limit = opts.limit ?? 200;
    this.tipCacheMs = opts.tipCacheMs ?? 2_500;
    this.blockCacheSize = opts.blockCacheSize ?? 5_000;
    this.clock = opts.clock ?? Date.now;
  }

  async getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]> {
    const contract = this.contracts[assetSymbol];
    if (!contract) throw new Error(`TronGridChainAdapter: no TRC20 contract configured for asset "${assetSymbol}"`);

    const [confirmed, unconfirmed] = await Promise.all([
      this.fetchTransfers(address, contract, 'only_confirmed'),
      this.fetchTransfers(address, contract, 'only_unconfirmed'),
    ]);

    // A transfer can appear in both lists as it solidifies between the two calls; the solidified copy wins.
    const transfers = new Map<string, { tx: TronGridTransfer; solidified: boolean }>();
    for (const tx of unconfirmed) transfers.set(tx.transaction_id, { tx, solidified: false });
    for (const tx of confirmed) transfers.set(tx.transaction_id, { tx, solidified: true });
    if (transfers.size === 0) return [];

    const [tip, blocks] = await Promise.all([this.tipHeight(), this.blockNumbers([...transfers.values()])]);

    return [...transfers.values()].map(({ tx, solidified }) => {
      const block = blocks.get(tx.transaction_id);
      const real = tip !== undefined && block !== undefined ? Math.max(0, tip - block + 1) : undefined;
      // Solidified is final by definition, so it is never reported below 1 even if the node we asked is a block behind.
      const confirmations = solidified ? Math.max(1, real ?? this.confirmedWeight) : (real ?? 0);
      return { txId: tx.transaction_id, address, assetSymbol, amount: BigInt(tx.value), confirmations, receivedAt: tx.block_timestamp };
    });
  }

  /** Current chain height, or undefined if it can't be read (callers then fall back rather than fail the whole check). */
  private async tipHeight(): Promise<number | undefined> {
    const now = this.clock();
    if (this.tip && now - this.tip.at < this.tipCacheMs) return this.tip.height;
    try {
      const json = await this.post('/wallet/getnowblock', {});
      const height = json?.block_header?.raw_data?.number;
      if (typeof height !== 'number') return undefined;
      this.tip = { height, at: now };
      return height;
    } catch {
      return undefined;
    }
  }

  /** Block number for each transfer, from cache where a solidified block is already known. Failures leave a gap, not an error. */
  private async blockNumbers(items: Array<{ tx: TronGridTransfer; solidified: boolean }>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const missing: Array<{ tx: TronGridTransfer; solidified: boolean }> = [];
    for (const it of items) {
      const cached = this.solidifiedBlocks.get(it.tx.transaction_id);
      if (cached !== undefined) out.set(it.tx.transaction_id, cached);
      else missing.push(it);
    }
    for (let i = 0; i < missing.length; i += LOOKUP_BATCH) {
      await Promise.all(
        missing.slice(i, i + LOOKUP_BATCH).map(async ({ tx, solidified }) => {
          try {
            const info = await this.post('/wallet/gettransactioninfobyid', { value: tx.transaction_id });
            if (typeof info?.blockNumber !== 'number') return; // not in a block yet
            out.set(tx.transaction_id, info.blockNumber);
            if (solidified) this.remember(tx.transaction_id, info.blockNumber); // only final blocks are safe to cache
          } catch {
            /* leave a gap: the caller falls back to a conservative count */
          }
        }),
      );
    }
    return out;
  }

  private remember(txId: string, block: number): void {
    this.solidifiedBlocks.set(txId, block);
    if (this.solidifiedBlocks.size > this.blockCacheSize) this.solidifiedBlocks.delete(this.solidifiedBlocks.keys().next().value as string);
  }

  private headers(): Record<string, string> {
    return this.opts.apiKey ? { 'TRON-PRO-API-KEY': this.opts.apiKey } : {};
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.opts.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TronGrid POST ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  private async fetchTransfers(address: string, contract: string, filter: 'only_confirmed' | 'only_unconfirmed'): Promise<TronGridTransfer[]> {
    const params = new URLSearchParams({ contract_address: contract, only_to: 'true', limit: String(this.limit), [filter]: 'true' });
    const url = `${this.baseUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`;
    const res = await this.opts.fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`TronGrid ${filter} request failed: HTTP ${res.status}`);
    const json = (await res.json()) as TronGridResponse;
    if (json.success === false) throw new Error(`TronGrid ${filter} request failed: ${json.error ?? 'unknown error'}`);
    // Defensive filter: the endpoint is scoped to this contract/direction already, but don't trust a third party blindly.
    return (json.data ?? []).filter((t) => t.type === 'Transfer' && t.to === address);
  }
}
