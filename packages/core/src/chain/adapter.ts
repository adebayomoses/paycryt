import type { Asset } from '../amount.js';
import type { ChainDeposit } from '../payments/types.js';

/**
 * A view of one blockchain. Real implementations (EVM RPC, Tron, Bitcoin, ...) and the FakeChain
 * sandbox both satisfy this, so application code never changes between sandbox and production.
 */
export interface ChainAdapter {
  readonly chain: string;
  /** All deposits seen for `address`, with their current confirmation counts. */
  getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]>;
  /**
   * Can this adapter actually see payments in `asset`? A server must refuse to price or accept an asset its watcher
   * cannot see: the customer would pay an address nobody is looking at, and the payment would sit "awaiting" forever.
   * Native ETH is the example: it has a price, but an adapter that reads ERC-20 transfer logs can never detect it.
   *
   * Optional. An adapter that leaves it out is assumed to watch everything on its chain (the FakeChain does).
   */
  supportsAsset?(asset: Asset): boolean;
}
