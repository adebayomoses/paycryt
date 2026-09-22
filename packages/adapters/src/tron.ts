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
   * TronGrid's `/transactions/trc20` endpoint reports whether a transfer is solidified (via the
   * `only_confirmed`/`only_unconfirmed` filters) but not a block-confirmation count. This adapter reports
   * a solidified transfer's `confirmations` as this fixed number, and an unconfirmed one as 0. Set it at
   * or above your `PaymentPolicy.minConfirmations` so solidified deposits are actually accepted. Default 20.
   */
  confirmedWeight?: number;
  /** Transfers fetched per request. A freshly generated one-time deposit address rarely needs more. Default 200. */
  limit?: number;
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

/**
 * Watches TRC20 deposits (USDT and other tokens) via the public TronGrid API.
 *
 * Verified against the live API (response shape, query parameters, `TRON-PRO-API-KEY` header) and the
 * address format is checked byte-for-byte against the reference `tronweb` library — see
 * `tronAddressFromPublicKey` in @paycryt/core. Not yet run against a real, money-moving deposit end to end,
 * so treat it as EXPERIMENTAL and test on Shasta/Nile testnet or with small amounts first.
 *
 * Limitations: no pagination (fine for one-time deposit addresses, which see very few transfers each;
 * raise `limit` if you reuse addresses), and confirmations are a fixed weight rather than a real count
 * (see `confirmedWeight`).
 */
export class TronGridChainAdapter implements ChainAdapter {
  readonly chain = 'tron';
  private readonly baseUrl: string;
  private readonly contracts: Record<string, string>;
  private readonly confirmedWeight: number;
  private readonly limit: number;

  constructor(private readonly opts: TronGridOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.trongrid.io';
    this.contracts = { ...DEFAULT_CONTRACTS, ...opts.contracts };
    this.confirmedWeight = opts.confirmedWeight ?? 20;
    this.limit = opts.limit ?? 200;
  }

  async getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]> {
    const contract = this.contracts[assetSymbol];
    if (!contract) throw new Error(`TronGridChainAdapter: no TRC20 contract configured for asset "${assetSymbol}"`);

    const [confirmed, unconfirmed] = await Promise.all([
      this.fetchTransfers(address, contract, 'only_confirmed'),
      this.fetchTransfers(address, contract, 'only_unconfirmed'),
    ]);

    // A transfer can appear in both polls as it solidifies between them; the confirmed copy wins.
    const byTxId = new Map<string, ChainDeposit>();
    for (const tx of unconfirmed) byTxId.set(tx.transaction_id, this.toDeposit(tx, address, assetSymbol, 0));
    for (const tx of confirmed) byTxId.set(tx.transaction_id, this.toDeposit(tx, address, assetSymbol, this.confirmedWeight));
    return [...byTxId.values()];
  }

  private toDeposit(tx: TronGridTransfer, address: string, assetSymbol: string, confirmations: number): ChainDeposit {
    return { txId: tx.transaction_id, address, assetSymbol, amount: BigInt(tx.value), confirmations, receivedAt: tx.block_timestamp };
  }

  private async fetchTransfers(address: string, contract: string, filter: 'only_confirmed' | 'only_unconfirmed'): Promise<TronGridTransfer[]> {
    const params = new URLSearchParams({ contract_address: contract, only_to: 'true', limit: String(this.limit), [filter]: 'true' });
    const url = `${this.baseUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`;
    const res = await this.opts.fetch(url, { headers: this.opts.apiKey ? { 'TRON-PRO-API-KEY': this.opts.apiKey } : {} });
    if (!res.ok) throw new Error(`TronGrid ${filter} request failed: HTTP ${res.status}`);
    const json = (await res.json()) as TronGridResponse;
    if (json.success === false) throw new Error(`TronGrid ${filter} request failed: ${json.error ?? 'unknown error'}`);
    // Defensive filter: the endpoint is scoped to this contract/direction already, but don't trust a third party blindly.
    return (json.data ?? []).filter((t) => t.type === 'Transfer' && t.to === address);
  }
}
