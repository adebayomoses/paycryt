import type { ChainDeposit } from '../payments/types.js';

/**
 * A view of one blockchain. Real implementations (EVM RPC, Tron, Bitcoin, ...) and the FakeChain
 * sandbox both satisfy this, so application code never changes between sandbox and production.
 */
export interface ChainAdapter {
  readonly chain: string;
  /** All deposits seen for `address`, with their current confirmation counts. */
  getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]>;
}
