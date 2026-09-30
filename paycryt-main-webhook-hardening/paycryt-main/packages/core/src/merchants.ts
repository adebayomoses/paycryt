import { bytesToHex } from '@noble/hashes/utils';
import { randomId, sha256Hex } from './hash.js';
import type { DeepPartial, PaymentPolicy } from './payments/policy.js';
import type { KVStore } from './serialize.js';
import { WALLET_FAMILIES, type WalletFamily, deriverForWallet } from './wallet/family.js';

/** A merchant's wallet public keys by family. Public keys only: the server can never spend from them. */
export type MerchantWallets = Partial<Record<WalletFamily, string>>;

/** Thrown when a wallet key is already in use by a different merchant. */
export class WalletConflictError extends Error {
  constructor(readonly family: WalletFamily) {
    super(`That ${family} wallet key is already registered to another merchant. Each merchant needs their own, or their customers' payments would share addresses.`);
    this.name = 'WalletConflictError';
  }
}

/** A tenant of a multi-tenant Paycryt server: one business with its own API key, settings and data. */
export interface Merchant {
  id: string;
  name: string;
  createdAt: number;
  /** SHA-256 of the API key. The key itself is shown once at creation and never stored. */
  keyHash: string;
  /** First characters of the key, so an operator can tell keys apart in a list without exposing them. */
  keyPrefix: string;
  /** A disabled merchant's key stops working immediately; its data is kept. */
  disabled?: boolean;
  /** Where this merchant's signed payment events go. Their events never reach anyone else's endpoint. */
  webhookUrl?: string;
  /** HMAC secret for `webhookUrl`. Must be stored in plaintext because signing needs it. */
  webhookSecret?: string;
  /** This merchant's margin against customers, in bps. Falls back to the server default. */
  spreadBps?: number;
  /** Policy defaults for this merchant's payments; a per-request `policy` overrides them field by field. */
  policy?: DeepPartial<PaymentPolicy>;
  /**
   * Where this merchant's customers pay: deposit addresses are derived from these keys, so funds settle
   * to the merchant's own wallet. Set by the operator, never by the merchant.
   */
  wallets?: MerchantWallets;
}

/** What is safe to show an admin or the merchant themselves: everything except the secrets. */
export type MerchantView = Omit<Merchant, 'keyHash' | 'webhookSecret'> & { hasWebhookSecret: boolean };

export interface CreateMerchantInput {
  name: string;
  webhookUrl?: string;
  /** Supply your own, or leave it out and one is generated when `webhookUrl` is set. */
  webhookSecret?: string;
  spreadBps?: number;
  policy?: DeepPartial<PaymentPolicy>;
  wallets?: MerchantWallets;
  now?: number;
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `pk_${bytesToHex(bytes)}`;
}

export function toMerchantView(m: Merchant): MerchantView {
  const { keyHash: _k, webhookSecret, ...rest } = m;
  return { ...rest, hasWebhookSecret: !!webhookSecret };
}

/**
 * Durable merchant records over any `KVStore`. API keys are 256-bit random values, so a plain SHA-256 is
 * enough to store them safely (there is no password-guessing to slow down); a database leak reveals
 * hashes, not usable keys.
 */
export class MerchantStore {
  constructor(private readonly store: KVStore) {}

  /** Returns the new merchant and its API key. This is the only time the key is available in plaintext. */
  async create(input: CreateMerchantInput): Promise<{ merchant: Merchant; apiKey: string }> {
    if (!input.name?.trim()) throw new Error('Merchant name is required');
    if (input.spreadBps !== undefined && (!Number.isInteger(input.spreadBps) || input.spreadBps < 0 || input.spreadBps > 5_000)) {
      throw new Error('spreadBps must be an integer between 0 and 5000');
    }
    const wallets = input.wallets ? await this.checkWallets(undefined, input.wallets) : undefined;
    const apiKey = generateApiKey();
    const merchant: Merchant = {
      id: randomId('mch'),
      name: input.name.trim(),
      createdAt: input.now ?? Date.now(),
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 11),
      webhookUrl: input.webhookUrl,
      webhookSecret: input.webhookSecret ?? (input.webhookUrl ? `whsec_${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(24)))}` : undefined),
      spreadBps: input.spreadBps,
      policy: input.policy,
      wallets,
    };
    await this.store.set(`merchant:${merchant.id}`, merchant);
    await this.store.set(`merchant-key:${merchant.keyHash}`, merchant.id);
    return { merchant, apiKey };
  }

  /** The merchant that owns `apiKey`, or undefined if the key is unknown or the merchant is disabled. */
  async authenticate(apiKey: string): Promise<Merchant | undefined> {
    if (!apiKey.startsWith('pk_')) return undefined;
    const id = await this.store.get<string>(`merchant-key:${sha256Hex(apiKey)}`);
    if (!id) return undefined;
    const merchant = await this.get(id);
    return merchant && !merchant.disabled ? merchant : undefined;
  }

  async get(id: string): Promise<Merchant | undefined> {
    return this.store.get<Merchant>(`merchant:${id}`);
  }

  async list(): Promise<Merchant[]> {
    const keys = await this.store.keys('merchant:');
    const merchants = await Promise.all(keys.map((k) => this.store.get<Merchant>(k)));
    return merchants.filter((m): m is Merchant => !!m).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Issues a new key and invalidates the old one at once. Returns the new key, shown only here. */
  async rotateKey(id: string): Promise<{ merchant: Merchant; apiKey: string } | undefined> {
    const merchant = await this.get(id);
    if (!merchant) return undefined;
    const apiKey = generateApiKey();
    await this.store.delete(`merchant-key:${merchant.keyHash}`);
    const updated: Merchant = { ...merchant, keyHash: sha256Hex(apiKey), keyPrefix: apiKey.slice(0, 11) };
    await this.store.set(`merchant:${id}`, updated);
    await this.store.set(`merchant-key:${updated.keyHash}`, id);
    return { merchant: updated, apiKey };
  }

  /**
   * Sets or clears wallet keys. A key set to a string is validated and must be unique across merchants;
   * `null` removes that family. Families you don't mention are left alone.
   */
  async setWallets(id: string, changes: Partial<Record<WalletFamily, string | null>>): Promise<Merchant | undefined> {
    const merchant = await this.get(id);
    if (!merchant) return undefined;
    for (const k of Object.keys(changes)) {
      if (!(WALLET_FAMILIES as readonly string[]).includes(k)) throw new Error(`Unknown wallet family "${k}". Allowed: ${WALLET_FAMILIES.join(', ')}`);
    }
    const next: MerchantWallets = { ...merchant.wallets };
    const additions: MerchantWallets = {};
    for (const family of WALLET_FAMILIES) {
      const v = changes[family];
      if (v === null) delete next[family];
      else if (typeof v === 'string') additions[family] = v;
    }
    Object.assign(next, await this.checkWallets(id, additions));
    const updated: Merchant = { ...merchant, wallets: Object.keys(next).length ? next : undefined };
    await this.store.set(`merchant:${id}`, updated);
    return updated;
  }

  /** Validates each key and rejects one already used by a different merchant (`selfId` may re-set its own). */
  private async checkWallets(selfId: string | undefined, wallets: MerchantWallets): Promise<MerchantWallets> {
    const clean: MerchantWallets = {};
    const others = (await this.list()).filter((m) => m.id !== selfId);
    for (const family of WALLET_FAMILIES) {
      const key = wallets[family];
      if (key === undefined) continue;
      if (typeof key !== 'string') throw new Error(`${family} wallet must be a string`);
      deriverForWallet(family, key); // throws a clear error for a bad or private key
      if (others.some((m) => m.wallets?.[family] === key)) throw new WalletConflictError(family);
      clean[family] = key;
    }
    for (const k of Object.keys(wallets)) {
      if (!(WALLET_FAMILIES as readonly string[]).includes(k)) throw new Error(`Unknown wallet family "${k}". Allowed: ${WALLET_FAMILIES.join(', ')}`);
    }
    return clean;
  }

  async setDisabled(id: string, disabled: boolean): Promise<Merchant | undefined> {
    const merchant = await this.get(id);
    if (!merchant) return undefined;
    const updated = { ...merchant, disabled };
    await this.store.set(`merchant:${id}`, updated);
    return updated;
  }
}
