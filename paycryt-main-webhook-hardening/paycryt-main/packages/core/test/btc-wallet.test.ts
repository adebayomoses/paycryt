import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { BtcXpubDeriver, btcAccountZpub, btcAddressFromPublicKey } from '@paycryt/core';

// The well-known Hardhat/Anvil development mnemonic. Never use it for real funds.
const DEV = 'test test test test test test test test test test test junk';

describe('Bitcoin address derivation', () => {
  it('matches the reference bitcoinjs-lib library for known public keys (m/84\'/0\'/0\'/0/0..1)', () => {
    // Verified live: bitcoinjs-lib's bip32.derivePath("m/84'/0'/0'") + payments.p2wpkh for the DEV mnemonic
    // gives these exact pubkeys and addresses (bitcoinjs-lib@6.1.7 + bip32@4 + tiny-secp256k1@2).
    const pub0 = Uint8Array.from(Buffer.from('03fc2a760d930aa1459b35185f45784f4b42050311b232ed490f05db13f448e154', 'hex'));
    const pub1 = Uint8Array.from(Buffer.from('0240c206b458db812db788af3b34f45dabb3824c58ce19cd1ff991fe1f2bceb976', 'hex'));
    expect(btcAddressFromPublicKey(pub0)).toBe('bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te');
    expect(btcAddressFromPublicKey(pub1)).toBe('bc1qp533522veg9uyhpx3sva9vqrnfzmt262n4lsuq');
  });

  it('produces the same zpub string as bitcoinjs-lib for the dev mnemonic', () => {
    // Verified live against bitcoinjs-lib's bip32 with SLIP-132 zpub version bytes.
    expect(btcAccountZpub(DEV)).toBe('zpub6qiy8cvfjiUGpweZnK5zLcKWkizhTsraN95DLyQVvvkp8aevEF8KMzSBnnLix3m9NYqeoLBLEc7G2rJVVCEj1A82gRVN2BXGiWmYosGpCAy');
  });

  it('derives BIP84 addresses (m/84\'/0\'/0\'/0/i) from a zpub', () => {
    const d = new BtcXpubDeriver(btcAccountZpub(DEV));
    expect(d.derive(0)).toBe('bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te');
    expect(d.derive(1)).toBe('bc1qp533522veg9uyhpx3sva9vqrnfzmt262n4lsuq');
    expect(d.derive(0)).toBe(d.derive(0)); // deterministic
  });

  it('refuses private extended keys', () => {
    const ZPUB_VERSIONS = { private: 0x04b2430c, public: 0x04b24746 };
    const zprv = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV), ZPUB_VERSIONS).privateExtendedKey;
    expect(() => new BtcXpubDeriver(zprv)).toThrow(/PRIVATE/);
  });

  it('rejects an ordinary xpub (wrong version bytes for a zpub)', () => {
    const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV)).publicExtendedKey; // standard BITCOIN_VERSIONS, not ZPUB
    expect(() => new BtcXpubDeriver(xpub)).toThrow();
  });
});
