import { type AddressDeriver, BtcXpubDeriver, EvmXpubDeriver, TronXpubDeriver } from './derive.js';

/**
 * Chains that share one address scheme share one wallet key: an Ethereum, Base and BNB Chain deposit
 * address are all derived from the same EVM account xpub.
 */
export type WalletFamily = 'evm' | 'tron' | 'bitcoin';

export const WALLET_FAMILIES: readonly WalletFamily[] = ['evm', 'tron', 'bitcoin'];

const FAMILY_BY_CHAIN: Record<string, WalletFamily> = {
  ethereum: 'evm',
  base: 'evm',
  bsc: 'evm',
  tron: 'tron',
  bitcoin: 'bitcoin',
};

/** Which wallet key covers `chain` (an `Asset.chain`), or undefined for a chain Paycryt has no deriver for. */
export function walletFamilyForChain(chain: string): WalletFamily | undefined {
  return FAMILY_BY_CHAIN[chain];
}

const KEY_HINT: Record<WalletFamily, string> = {
  evm: "an EVM account xpub (m/44'/60'/0')",
  tron: "a Tron account xpub (m/44'/195'/0')",
  bitcoin: "a native-SegWit account zpub (m/84'/0'/0')",
};

/**
 * Builds the deriver for a wallet public key. Throws a clear error for anything that isn't a valid
 * extended PUBLIC key, and never includes the offending value in the message — a key someone pasted
 * by mistake might be a private one, and error text ends up in logs and API responses.
 */
export function deriverForWallet(family: WalletFamily, key: string, chain?: string): AddressDeriver {
  try {
    const deriver =
      family === 'evm' ? new EvmXpubDeriver(key, chain) : family === 'tron' ? new TronXpubDeriver(key, chain) : new BtcXpubDeriver(key, chain);
    deriver.derive(0); // proves the key actually derives, not just that it parses
    return deriver;
  } catch (err) {
    if (err instanceof Error && /PRIVATE/.test(err.message)) {
      throw new Error(`The ${family} wallet must be a PUBLIC key. A private key was supplied — do not share it; use ${KEY_HINT[family]} instead.`);
    }
    throw new Error(`Invalid ${family} wallet key: expected ${KEY_HINT[family]}.`);
  }
}
