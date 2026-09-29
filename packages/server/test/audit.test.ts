import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@paycryt/core';
import { AuditLogStore } from '@paycryt/server';

describe('AuditLogStore', () => {
  it('returns entries newest first', async () => {
    const log = new AuditLogStore(new MemoryStore());
    await log.append({ at: 1, action: 'merchant.create', merchantId: 'mch_1', detail: { name: 'Ada' } });
    await log.append({ at: 2, action: 'merchant.disable', merchantId: 'mch_1' });
    await log.append({ at: 3, action: 'merchant.enable', merchantId: 'mch_1' });
    const entries = await log.recent();
    expect(entries.map((e) => e.action)).toEqual(['merchant.enable', 'merchant.disable', 'merchant.create']);
    expect(entries.every((e) => e.actor === 'admin')).toBe(true);
    expect(entries[2]!.detail).toEqual({ name: 'Ada' });
  });

  it('respects the limit, keeping the most recent entries', async () => {
    const log = new AuditLogStore(new MemoryStore());
    for (let i = 0; i < 10; i++) await log.append({ at: i, action: 'merchant.disable', merchantId: `mch_${i}` });
    const entries = await log.recent(3);
    expect(entries.map((e) => e.merchantId)).toEqual(['mch_9', 'mch_8', 'mch_7']);
  });

  it('survives being rebuilt over the same store (a real restart)', async () => {
    const store = new MemoryStore();
    await new AuditLogStore(store).append({ at: 1, action: 'merchant.create', merchantId: 'mch_1' });
    const reopened = new AuditLogStore(store);
    await reopened.append({ at: 2, action: 'merchant.rotate-key', merchantId: 'mch_1' });
    const entries = await reopened.recent();
    expect(entries).toHaveLength(2); // the sequence counter carried over, not reset to collide with entry 1
    expect(entries.map((e) => e.action)).toEqual(['merchant.rotate-key', 'merchant.create']);
  });

  it('is empty before anything is appended', async () => {
    expect(await new AuditLogStore(new MemoryStore()).recent()).toEqual([]);
  });
});
