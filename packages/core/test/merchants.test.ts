import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  MemoryStore,
  MerchantStore,
  WalletConflictError,
  btcAccountZpub,
  deriverForWallet,
  evmAccountXpub,
  generateApiKey,
  sha256Hex,
  toJson,
  toMerchantView,
  tronAccountXpub,
  walletFamilyForChain,
} from '@paycryt/core';

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

describe('merchant wallets', () => {
  const DEV = 'test test test test test test test test test test test junk';
  const OTHER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('maps chains to wallet families', () => {
    expect(['ethereum', 'base', 'bsc'].map(walletFamilyForChain)).toEqual(['evm', 'evm', 'evm']);
    expect(walletFamilyForChain('tron')).toBe('tron');
    expect(walletFamilyForChain('bitcoin')).toBe('bitcoin');
    expect(walletFamilyForChain('solana')).toBeUndefined();
  });

  it('builds a working deriver per family and proves the key derives', () => {
    expect(deriverForWallet('evm', evmAccountXpub(DEV)).derive(0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(deriverForWallet('tron', tronAccountXpub(DEV)).derive(0)).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(deriverForWallet('bitcoin', btcAccountZpub(DEV)).derive(0)).toBe('bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te');
  });

  it('rejects a private key or junk with an error that never contains the input', () => {
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV)).privateExtendedKey;
    let msg = '';
    try {
      deriverForWallet('evm', xprv);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('PUBLIC key');
    expect(msg).not.toContain(xprv);
    expect(() => deriverForWallet('evm', 'junk')).toThrow(/Invalid evm wallet key/);
    expect(() => deriverForWallet('bitcoin', evmAccountXpub(DEV))).toThrow(/Invalid bitcoin wallet key/); // xpub is not a zpub
  });

  it('stores validated wallets on create, and keeps them across a reload', async () => {
    const kv = new MemoryStore();
    const store = new MerchantStore(kv);
    const { merchant } = await store.create({ name: 'A', wallets: { evm: evmAccountXpub(DEV) } });
    expect((await new MerchantStore(kv).get(merchant.id))?.wallets).toEqual({ evm: evmAccountXpub(DEV) });
  });

  it('enforces one merchant per wallet key, allows re-setting your own, and supports clearing', async () => {
    const store = new MerchantStore(new MemoryStore());
    const a = (await store.create({ name: 'A', wallets: { evm: evmAccountXpub(DEV) } })).merchant;
    const b = (await store.create({ name: 'B' })).merchant;

    await expect(store.setWallets(b.id, { evm: evmAccountXpub(DEV) })).rejects.toBeInstanceOf(WalletConflictError);
    await expect(store.create({ name: 'C', wallets: { evm: evmAccountXpub(DEV) } })).rejects.toBeInstanceOf(WalletConflictError);
    expect((await store.setWallets(a.id, { evm: evmAccountXpub(DEV) }))?.wallets?.evm).toBe(evmAccountXpub(DEV)); // your own key again

    const moved = await store.setWallets(b.id, { evm: evmAccountXpub(OTHER), tron: tronAccountXpub(OTHER) });
    expect(Object.keys(moved!.wallets!).sort()).toEqual(['evm', 'tron']);
    const cleared = await store.setWallets(b.id, { evm: null, tron: null });
    expect(cleared!.wallets).toBeUndefined();
    // A is still using this key, so B still cannot take it:
    await expect(store.setWallets(b.id, { evm: evmAccountXpub(DEV) })).rejects.toBeInstanceOf(WalletConflictError); // still A's
    expect(await store.setWallets('mch_missing', { evm: null })).toBeUndefined();
  });

  it('rejects unknown wallet families instead of ignoring them', async () => {
    const store = new MerchantStore(new MemoryStore());
    const a = (await store.create({ name: 'A' })).merchant;
    await expect(store.setWallets(a.id, { solana: 'x' } as never)).rejects.toThrow(/Unknown wallet family/);
    await expect(store.create({ name: 'B', wallets: { solana: 'x' } as never })).rejects.toThrow(/Unknown wallet family/);
  });
});
