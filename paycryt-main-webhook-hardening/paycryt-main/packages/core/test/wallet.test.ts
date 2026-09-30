import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import { EvmXpubDeriver, evmAccountXpub, generateWalletMnemonic } from '@paycryt/core';

// The well-known Hardhat/Anvil development mnemonic. Never use it for real funds.
const DEV = 'test test test test test test test test test test test junk';

describe('EVM xpub derivation', () => {
  it('matches the known addresses for m/44\'/60\'/0\'/0/i', () => {
    const d = new EvmXpubDeriver(evmAccountXpub(DEV));
    expect(d.derive(0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(d.derive(1)).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('refuses private extended keys', () => {
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV)).privateExtendedKey;
    expect(() => new EvmXpubDeriver(xprv)).toThrow(/PRIVATE/);
  });

  it('generates fresh 24-word mnemonics', () => {
    expect(generateWalletMnemonic().split(' ')).toHaveLength(24);
  });
});
