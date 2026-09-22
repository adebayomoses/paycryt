import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TronXpubDeriver, tronAccountXpub, tronAddressFromPublicKey } from '@paycryt/core';

// The well-known Hardhat/Anvil development mnemonic. Never use it for real funds.
const DEV = 'test test test test test test test test test test test junk';

describe('Tron address derivation', () => {
  it('matches the reference tronweb library for a known private key', () => {
    // Verified live: TronWeb.address.fromPrivateKey('000...0001') === 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC'
    // (tronweb@5.3.2, https://cdn.jsdelivr.net/npm/tronweb@5.3.2/dist/TronWeb.js)
    const priv = '0000000000000000000000000000000000000000000000000000000000000001';
    const pub = secp256k1.getPublicKey(priv, false);
    expect(tronAddressFromPublicKey(pub)).toBe('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
  });

  it('derives SLIP-44 coin-type 195 addresses (m/44\'/195\'/0\'/0/i) from an xpub', () => {
    const d = new TronXpubDeriver(tronAccountXpub(DEV));
    const a0 = d.derive(0);
    const a1 = d.derive(1);
    expect(a0).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/); // Base58Check, 34 chars, starts with T
    expect(a1).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(a0).not.toBe(a1);
    expect(d.derive(0)).toBe(a0); // deterministic
  });

  it('refuses private extended keys', () => {
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV)).privateExtendedKey;
    expect(() => new TronXpubDeriver(xprv)).toThrow(/PRIVATE/);
  });

  it('derives a different address than the EVM path for the same seed (different coin type)', async () => {
    const { evmAccountXpub, EvmXpubDeriver } = await import('@paycryt/core');
    const tron = new TronXpubDeriver(tronAccountXpub(DEV)).derive(0);
    const evm = new EvmXpubDeriver(evmAccountXpub(DEV)).derive(0);
    expect(tron).not.toBe(evm);
  });
});
