import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/**
 * Derives deposit addresses without needing the network or any private key.
 * This is what lets a POS device create payment requests offline.
 */
export interface AddressDeriver {
  readonly chain: string;
  derive(index: number): string;
}

/** EIP-55 checksummed address from an uncompressed secp256k1 public key. */
export function evmAddressFromPublicKey(compressedOrUncompressed: Uint8Array): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressedOrUncompressed).toRawBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  const addr = bytesToHex(hash.slice(-20));
  const checksum = bytesToHex(keccak_256(new TextEncoder().encode(addr)));
  let out = '0x';
  for (let i = 0; i < addr.length; i++) out += parseInt(checksum[i]!, 16) >= 8 ? addr[i]!.toUpperCase() : addr[i]!;
  return out;
}

/**
 * Non-custodial EVM address derivation (Ethereum, Base, BNB Chain, ...).
 * Give it the *account-level* extended public key (m/44'/60'/0'); it derives external addresses 0/index.
 * Only the xpub is needed on the server or device. Keep the seed offline.
 */
export class EvmXpubDeriver implements AddressDeriver {
  private readonly external: HDKey;

  constructor(
    xpub: string,
    readonly chain = 'evm',
  ) {
    const key = HDKey.fromExtendedKey(xpub);
    if (key.privateKey) throw new Error('Refusing to load an extended PRIVATE key. Pass an xpub, never an xprv.');
    this.external = key.deriveChild(0);
  }

  derive(index: number): string {
    const child = this.external.deriveChild(index);
    if (!child.publicKey) throw new Error('derivation failed');
    return evmAddressFromPublicKey(child.publicKey);
  }
}

/**
 * Helpers for creating wallets. Use these at setup time on a secure machine, not in production servers.
 */
export function generateWalletMnemonic(strength: 128 | 256 = 256): string {
  return generateMnemonic(wordlist, strength);
}

/** Account-level xpub for EVM chains, m/44'/60'/0'. Safe to give to servers and POS devices. */
export function evmAccountXpub(mnemonic: string, passphrase = ''): string {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase));
  return root.derive("m/44'/60'/0'").publicExtendedKey;
}
