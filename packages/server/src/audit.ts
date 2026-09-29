import type { KVStore } from '@paycryt/core';

/**
 * One admin action, e.g. onboarding a merchant or changing its wallets. Never carries a secret: no API
 * key, no webhook secret, and wallet changes record which chain families changed, not the key values —
 * an xpub is not a spending credential, but it does reveal a merchant's future addresses and volumes, so
 * it doesn't belong in a log any more than the wallet endpoint's own response needs to repeat it back.
 */
export interface AuditEntry {
  at: number;
  actor: 'admin';
  action: 'merchant.create' | 'merchant.rotate-key' | 'merchant.wallets' | 'merchant.disable' | 'merchant.enable';
  merchantId: string;
  detail?: Record<string, unknown>;
}

/** Durable, append-only admin audit log over any `KVStore`. Entries are never edited or removed. */
export class AuditLogStore {
  constructor(private readonly store: KVStore) {}

  async append(entry: Omit<AuditEntry, 'actor'>): Promise<void> {
    const seq = await this.nextSeq();
    await this.store.set(`audit:${seq}`, { actor: 'admin', ...entry } satisfies AuditEntry);
  }

  /** The most recent entries, newest first. */
  async recent(limit = 100): Promise<AuditEntry[]> {
    const keys = await this.store.keys('audit:');
    const tail = keys.slice(-limit); // keys() is ascending by the zero-padded sequence, so the tail is the newest
    const entries = await Promise.all(tail.map((k) => this.store.get<AuditEntry>(k)));
    return entries.filter((e): e is AuditEntry => !!e).reverse();
  }

  private async nextSeq(): Promise<string> {
    const n = ((await this.store.get<number>('audit-seq')) ?? 0) + 1;
    await this.store.set('audit-seq', n);
    return String(n).padStart(10, '0');
  }
}
