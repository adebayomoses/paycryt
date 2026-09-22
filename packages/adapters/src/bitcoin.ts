import type { ChainAdapter, ChainDeposit, FetchLike } from '@paycryt/core';

export interface EsploraOptions {
  fetch: FetchLike;
  /** Default: Blockstream's public instance. Point this at mempool.space, or your own self-hosted esplora/electrs. */
  baseUrl?: string;
  clock?: () => number;
}

interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraTx {
  txid: string;
  vout: EsploraVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

/**
 * Watches native SegWit (bech32, bc1...) BTC deposits via any Esplora-compatible REST API
 * (blockstream.info, mempool.space, or a self-hosted electrs/esplora instance).
 *
 * Verified live against blockstream.info's public API: response shape, the "multiple outputs to the
 * same address in one tx must be summed" case, and that unconfirmed transactions carry no timestamp.
 *
 * Confirmations are real, computed from `currentTipHeight - tx.block_height + 1`, same idea as the EVM
 * adapter. Not yet run against a real, money-moving deposit end to end — treat it as EXPERIMENTAL and
 * test on testnet/signet or with small amounts first.
 */
export class EsploraChainAdapter implements ChainAdapter {
  readonly chain = 'bitcoin';
  private readonly baseUrl: string;
  private readonly clock: () => number;
  /**
   * Esplora's address-history endpoint gives no timestamp for an unconfirmed transaction, so this
   * remembers when *this adapter* first saw each one and reuses that estimate until it confirms
   * (at which point the real on-chain `block_time` takes over and the estimate is discarded).
   */
  private readonly firstSeenUnconfirmed = new Map<string, number>();

  constructor(private readonly opts: EsploraOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://blockstream.info/api';
    this.clock = opts.clock ?? Date.now;
  }

  async getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]> {
    if (assetSymbol !== 'BTC') throw new Error(`EsploraChainAdapter only watches BTC, got asset "${assetSymbol}"`);

    const [tipHeight, txs] = await Promise.all([this.tipHeight(), this.addressTxs(address)]);
    const deposits: ChainDeposit[] = [];

    for (const tx of txs) {
      const received = tx.vout.filter((v) => v.scriptpubkey_address === address).reduce((sum, v) => sum + BigInt(v.value), 0n);
      if (received === 0n) continue;

      if (tx.status.confirmed) {
        this.firstSeenUnconfirmed.delete(tx.txid); // a real timestamp is available now; stop estimating
        deposits.push({
          txId: tx.txid,
          address,
          assetSymbol,
          amount: received,
          confirmations: Math.max(0, tipHeight - tx.status.block_height! + 1),
          receivedAt: tx.status.block_time! * 1000,
        });
      } else {
        let firstSeen = this.firstSeenUnconfirmed.get(tx.txid);
        if (firstSeen === undefined) {
          firstSeen = this.clock();
          this.firstSeenUnconfirmed.set(tx.txid, firstSeen);
        }
        deposits.push({ txId: tx.txid, address, assetSymbol, amount: received, confirmations: 0, receivedAt: firstSeen });
      }
    }
    return deposits;
  }

  private async tipHeight(): Promise<number> {
    const res = await this.opts.fetch(`${this.baseUrl}/blocks/tip/height`);
    if (!res.ok) throw new Error(`Esplora tip-height request failed: HTTP ${res.status}`);
    const height = Number(await res.text());
    if (!Number.isFinite(height)) throw new Error('Esplora tip-height request returned a non-numeric value');
    return height;
  }

  private async addressTxs(address: string): Promise<EsploraTx[]> {
    const res = await this.opts.fetch(`${this.baseUrl}/address/${encodeURIComponent(address)}/txs`);
    if (!res.ok) throw new Error(`Esplora address-history request failed: HTTP ${res.status}`);
    return (await res.json()) as EsploraTx[];
  }
}
