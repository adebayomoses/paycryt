import { randomId } from '../hash.js';
import type { ChainDeposit, PaymentRequest } from '../payments/types.js';
import type { AddressDeriver } from '../wallet/derive.js';
import type { ChainAdapter } from './adapter.js';

/**
 * An in-memory blockchain for development and tests. No faucets, no RPC keys, no waiting for blocks:
 * you decide when deposits arrive and when they confirm.
 */
export class FakeChain implements ChainAdapter, AddressDeriver {
  private deposits: ChainDeposit[] = [];
  private nextIndex = 0;

  constructor(
    readonly chain = 'fake',
    private readonly clock: () => number = Date.now,
  ) {}

  /** AddressDeriver: deterministic fake addresses, so offline devices work in the sandbox too. */
  derive(index: number): string {
    return `fake:${this.chain}:${index.toString().padStart(6, '0')}`;
  }

  /** Convenience for callers that do not care about the index. */
  newAddress(): { address: string; index: number } {
    const index = this.nextIndex++;
    return { address: this.derive(index), index };
  }

  async getDeposits(address: string, assetSymbol: string): Promise<ChainDeposit[]> {
    return this.deposits.filter((d) => d.address === address && d.assetSymbol === assetSymbol).map((d) => ({ ...d }));
  }

  /** Simulate someone sending funds. `at` lets scenarios backdate or postdate the deposit. */
  simulateDeposit(input: {
    address: string;
    assetSymbol: string;
    amount: bigint;
    confirmations?: number;
    at?: number;
  }): ChainDeposit {
    const deposit: ChainDeposit = {
      txId: randomId('0xfake'),
      address: input.address,
      assetSymbol: input.assetSymbol,
      amount: input.amount,
      confirmations: input.confirmations ?? 0,
      receivedAt: input.at ?? this.clock(),
    };
    this.deposits.push(deposit);
    return deposit;
  }

  /** Mine `blocks` blocks: every deposit gains that many confirmations. */
  mine(blocks = 1): void {
    for (const d of this.deposits) d.confirmations += blocks;
  }

  /** Ready-made customer behaviours for a given payment request. All return the simulated deposits. */
  readonly scenarios = {
    /** Pays exactly and confirms. */
    exact: (r: PaymentRequest) => this.pay(r, r.amountDue, 1),
    /** Pays `percent`% of the amount due (e.g. 90 for a 10% shortfall). */
    underpay: (r: PaymentRequest, percent: number) => this.pay(r, (r.amountDue * BigInt(Math.round(percent * 100))) / 10_000n, 1),
    /** Pays `percent`% of the amount due (e.g. 120). */
    overpay: (r: PaymentRequest, percent: number) => this.pay(r, (r.amountDue * BigInt(Math.round(percent * 100))) / 10_000n, 1),
    /** Pays in several instalments summing to the amount due. */
    split: (r: PaymentRequest, parts: number) => {
      const each = r.amountDue / BigInt(parts);
      const out: ChainDeposit[] = [];
      for (let i = 0; i < parts; i++) out.push(...this.pay(r, i === parts - 1 ? r.amountDue - each * BigInt(parts - 1) : each, 1));
      return out;
    },
    /** Pays exactly, but `afterMs` after the request expired. */
    late: (r: PaymentRequest, afterMs: number) => this.pay(r, r.amountDue, 1, r.expiresAt + afterMs),
    /** Pays exactly but never confirms (stays at 0 confirmations). */
    unconfirmed: (r: PaymentRequest) => this.pay(r, r.amountDue, 0),
  };

  private pay(r: PaymentRequest, amount: bigint, confirmations: number, at?: number): ChainDeposit[] {
    return [this.simulateDeposit({ address: r.address, assetSymbol: r.asset.symbol, amount, confirmations, at })];
  }
}
