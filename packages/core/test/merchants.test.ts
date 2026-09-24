import { describe, expect, it } from 'vitest';
import { MemoryStore, MerchantStore, generateApiKey, sha256Hex, toMerchantView, toJson } from '@paycryt/core';

describe('MerchantStore', () => {
  it('creates a merchant and authenticates by its API key', async () => {
    const store = new MerchantStore(new MemoryStore());
    const { merchant, apiKey } = await store.create({ name: 'Ada Stores' });
    expect(apiKey).toMatch(/^pk_[0-9a-f]{64}$/);
    expect(merchant.keyPrefix).toBe(apiKey.slice(0, 11));

    const found = await store.authenticate(apiKey);
    expect(found?.id).toBe(merchant.id);
    expect(await store.authenticate('pk_' + '0'.repeat(64))).toBeUndefined();
    expect(await store.authenticate('not-a-key')).toBeUndefined();
    expect(await store.authenticate('')).toBeUndefined();
  });

  it('never stores the plaintext API key, only its hash', async () => {
    const kv = new MemoryStore();
    const store = new MerchantStore(kv);
    const { merchant, apiKey } = await store.create({ name: 'Ada Stores' });
    expect(merchant.keyHash).toBe(sha256Hex(apiKey));

    const everything: string[] = [];
    for (const k of [...(await kv.keys('merchant')), ...(await kv.keys('merchant-key:'))]) everything.push(k, toJson(await kv.get(k)));
    expect(everything.join('\n')).not.toContain(apiKey);
  });

  it('generates distinct 256-bit keys', () => {
    const keys = new Set(Array.from({ length: 50 }, generateApiKey));
    expect(keys.size).toBe(50);
  });

  it('validates input', async () => {
    const store = new MerchantStore(new MemoryStore());
    await expect(store.create({ name: '  ' })).rejects.toThrow(/name is required/);
    await expect(store.create({ name: 'x', spreadBps: -1 })).rejects.toThrow(/spreadBps/);
    await expect(store.create({ name: 'x', spreadBps: 1.5 })).rejects.toThrow(/spreadBps/);
    await expect(store.create({ name: 'x', spreadBps: 9_999 })).rejects.toThrow(/spreadBps/);
  });

  it('rotating a key invalidates the old one immediately', async () => {
    const store = new MerchantStore(new MemoryStore());
    const { merchant, apiKey: oldKey } = await store.create({ name: 'Ada Stores' });
    const rotated = await store.rotateKey(merchant.id);
    expect(rotated!.apiKey).not.toBe(oldKey);
    expect(await store.authenticate(oldKey)).toBeUndefined();
    expect((await store.authenticate(rotated!.apiKey))?.id).toBe(merchant.id);
    expect(await store.rotateKey('mch_missing')).toBeUndefined();
  });

  it('a disabled merchant cannot authenticate, and can be re-enabled', async () => {
    const store = new MerchantStore(new MemoryStore());
    const { merchant, apiKey } = await store.create({ name: 'Ada Stores' });
    await store.setDisabled(merchant.id, true);
    expect(await store.authenticate(apiKey)).toBeUndefined();
    expect((await store.get(merchant.id))?.disabled).toBe(true); // data is kept
    await store.setDisabled(merchant.id, false);
    expect((await store.authenticate(apiKey))?.id).toBe(merchant.id);
  });

  it('generates a webhook secret only when a webhook URL is given', async () => {
    const store = new MerchantStore(new MemoryStore());
    const without = await store.create({ name: 'A' });
    expect(without.merchant.webhookSecret).toBeUndefined();
    const withHook = await store.create({ name: 'B', webhookUrl: 'https://b.example/hook' });
    expect(withHook.merchant.webhookSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const custom = await store.create({ name: 'C', webhookUrl: 'https://c.example/hook', webhookSecret: 'mine' });
    expect(custom.merchant.webhookSecret).toBe('mine');
  });

  it('the public view hides the key hash and webhook secret', async () => {
    const store = new MerchantStore(new MemoryStore());
    const { merchant } = await store.create({ name: 'B', webhookUrl: 'https://b.example/hook' });
    const view = toMerchantView(merchant);
    expect(view).not.toHaveProperty('keyHash');
    expect(view).not.toHaveProperty('webhookSecret');
    expect(view.hasWebhookSecret).toBe(true);
  });

  it('lists merchants oldest first and survives a reload over the same store', async () => {
    const kv = new MemoryStore();
    const first = new MerchantStore(kv);
    const a = await first.create({ name: 'A', now: 1000 });
    const b = await first.create({ name: 'B', now: 2000 });

    const reloaded = new MerchantStore(kv); // "restart"
    expect((await reloaded.list()).map((m) => m.name)).toEqual(['A', 'B']);
    expect((await reloaded.authenticate(b.apiKey))?.name).toBe('B');
    expect((await reloaded.authenticate(a.apiKey))?.name).toBe('A');
  });
});
