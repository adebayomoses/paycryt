import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASSETS,
  BtcXpubDeriver,
  EvmXpubDeriver,
  FakeChain,
  MemoryStore,
  OfflinePOS,
  TronXpubDeriver,
  btcAccountZpub,
  evmAccountXpub,
  toJson,
  tronAccountXpub,
  type RateSnapshot,
  type SyncOp,
  type SyncResponse,
} from '@paycryt/core';
import { PaycrytServer } from '@paycryt/server';

// Two unrelated development mnemonics. Never use either for real funds.
const DEV_A = 'test test test test test test test test test test test junk';
const DEV_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_A = { evm: evmAccountXpub(DEV_A), tron: tronAccountXpub(DEV_A), bitcoin: btcAccountZpub(DEV_A) };
const WALLET_B = { evm: evmAccountXpub(DEV_B), tron: tronAccountXpub(DEV_B), bitcoin: btcAccountZpub(DEV_B) };

const ADMIN = 'admin_key';
let server: PaycrytServer;
let base: string;

async function call(key: string | undefined, method: string, path: string, body?: unknown, url = base) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function newMerchant(name: string, extra: Record<string, unknown> = {}, url = base) {
  const r = await call(ADMIN, 'POST', '/v1/admin/merchants', { name, ...extra }, url);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.merchant.id as string, key: r.body.apiKey as string };
}

const pay = (asset: string) => ({ amount: '15000', currency: 'NGN', asset });

beforeEach(async () => {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, spreadBps: 100 });
  base = `http://127.0.0.1:${await server.listen(0)}`;
});
afterEach(() => server.close());

describe("deposit addresses come from the merchant's own wallet", () => {
  it('derives real EVM, Tron and Bitcoin addresses from the merchant keys, in order', async () => {
    const a = await newMerchant('Ada', { wallets: WALLET_A });
    const evm = new EvmXpubDeriver(WALLET_A.evm);
    const tron = new TronXpubDeriver(WALLET_A.tron);
    const btc = new BtcXpubDeriver(WALLET_A.bitcoin);

    const e0 = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    expect(e0.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'); // the well-known Hardhat account 0
    expect(e0.address).toBe(evm.derive(0));
    expect((await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body.address).toBe(evm.derive(1));

    expect((await call(a.key, 'POST', '/v1/payments', pay('USDT_TRC20'))).body.address).toBe(tron.derive(0));
    const b0 = (await call(a.key, 'POST', '/v1/payments', pay('BTC'))).body;
    expect(b0.address).toBe('bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te'); // checked against bitcoinjs-lib elsewhere
    expect(b0.address).toBe(btc.derive(0));
  });

  it('chains that share a wallet family share one index sequence, so no address repeats', async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const evm = new EvmXpubDeriver(WALLET_A.evm);
    const onEthereum = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    const onBsc = (await call(a.key, 'POST', '/v1/payments', pay('USDT_BEP20'))).body;
    expect(onEthereum.address).toBe(evm.derive(0));
    expect(onBsc.address).toBe(evm.derive(1));
  });

  it('two merchants get addresses from different wallets, each starting at their own index 0', async () => {
    const a = await newMerchant('Ada', { wallets: WALLET_A });
    const b = await newMerchant('Bola', { wallets: WALLET_B });
    const pa = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    const pb = (await call(b.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    expect(pa.address).toBe(new EvmXpubDeriver(WALLET_A.evm).derive(0));
    expect(pb.address).toBe(new EvmXpubDeriver(WALLET_B.evm).derive(0));
    expect(pa.address).not.toBe(pb.address);
  });

  it("a customer's payment to the merchant's derived address is detected and settled", async () => {
    const a = await newMerchant('Ada', { wallets: WALLET_A });
    const p = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: p.id, scenario: 'exact' });
    expect((await call(a.key, 'GET', `/v1/payments/${p.id}`)).body.status).toBe('paid');
  });

  it('without a wallet, the sandbox falls back to its shared fake addresses (unchanged behaviour)', async () => {
    const a = await newMerchant('Ada');
    const p = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    expect(p.address).toMatch(/^fake:sandbox:/);
  });

  it('outside the sandbox, a merchant with no wallet for the chain cannot take payments; one with a wallet can', async () => {
    const prod = await PaycrytServer.create({ apiKey: ADMIN, sandbox: false });
    const url = `http://127.0.0.1:${await prod.listen(0)}`;
    try {
      const bare = await newMerchant('Bare', {}, url);
      const refused = await call(bare.key, 'POST', '/v1/payments', pay('USDT_ERC20'), url);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain('No evm wallet is configured');

      const wallet = await newMerchant('Walleted', { wallets: { evm: WALLET_A.evm } }, url);
      const ok = await call(wallet.key, 'POST', '/v1/payments', pay('USDT_ERC20'), url);
      expect(ok.status).toBe(201);
      expect(ok.body.address).toBe(new EvmXpubDeriver(WALLET_A.evm).derive(0));
      // ...but that wallet covers EVM only:
      expect((await call(wallet.key, 'POST', '/v1/payments', pay('USDT_TRC20'), url)).status).toBe(400);
    } finally {
      await prod.close();
    }
  });
});

describe('wallet management', () => {
  it('sets, changes and clears wallets; only the admin may; new payments follow the change', async () => {
    const a = await newMerchant('Ada');
    expect((await call(a.key, 'POST', `/v1/admin/merchants/${a.id}/wallets`, { evm: WALLET_A.evm })).status).toBe(403); // a merchant can't redirect their own funds

    const set = await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/wallets`, { evm: WALLET_A.evm });
    expect(set.status).toBe(200);
    expect(set.body.wallets).toEqual({ evm: WALLET_A.evm });
    const first = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    expect(first.address).toBe(new EvmXpubDeriver(WALLET_A.evm).derive(0));

    await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/wallets`, { evm: WALLET_B.evm }); // changed to a new wallet
    const second = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;
    expect(second.address).toBe(new EvmXpubDeriver(WALLET_B.evm).derive(1)); // new wallet; index keeps moving forward, never reused
    expect((await call(a.key, 'GET', `/v1/payments/${first.id}`)).body.address).toBe(first.address); // the old payment is untouched

    const cleared = await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/wallets`, { evm: null });
    expect(cleared.body.wallets).toBeUndefined();
    expect((await call(ADMIN, 'POST', `/v1/admin/merchants/${a.id}/wallets`, { evm: WALLET_A.evm })).status).toBe(200); // re-setting one's own key is fine
    expect((await call(ADMIN, 'POST', '/v1/admin/merchants/mch_deadbeef/wallets', { evm: WALLET_A.evm })).status).toBe(404);
  });

  it('shows the merchant their own wallet keys (public keys, not secrets)', async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    expect((await call(a.key, 'GET', '/v1/me')).body.merchant.wallets).toEqual({ evm: WALLET_A.evm });
  });

  it('refuses a key already registered to another merchant, since their customers would share addresses', async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const b = await newMerchant('Bola');
    const dup = await call(ADMIN, 'POST', `/v1/admin/merchants/${b.id}/wallets`, { evm: WALLET_A.evm });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('already registered to another merchant');
    expect((await call(ADMIN, 'POST', '/v1/admin/merchants', { name: 'Copycat', wallets: { evm: WALLET_A.evm } })).status).toBe(409);
    expect((await call(ADMIN, 'GET', `/v1/admin/merchants/${a.id}`)).body.wallets.evm).toBe(WALLET_A.evm);
  });

  it('rejects private keys, garbage, the wrong key type and unknown families, without echoing the input', async () => {
    const b = await newMerchant('Bola');
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(DEV_A)).derive("m/44'/60'/0'").privateExtendedKey;
    const set = (wallets: unknown) => call(ADMIN, 'POST', `/v1/admin/merchants/${b.id}/wallets`, wallets);

    const priv = await set({ evm: xprv });
    expect(priv.status).toBe(400);
    expect(priv.body.error).toContain('PUBLIC key');
    expect(JSON.stringify(priv.body)).not.toContain(xprv); // a pasted secret must never come back out in a response

    expect((await set({ evm: 'not-a-key' })).body.error).toContain('Invalid evm wallet key');
    expect((await set({ bitcoin: WALLET_A.evm })).status).toBe(400); // an ordinary xpub is not a native-SegWit zpub
    expect((await set({ solana: WALLET_A.evm })).body.error).toContain('Unknown wallet family');
    expect((await set([])).status).toBe(400);
    expect((await call(ADMIN, 'GET', `/v1/admin/merchants/${b.id}`)).body.wallets).toBeUndefined(); // nothing was half-applied
  });
});

describe('addresses are never reissued across a restart', () => {
  it('resumes each merchant wallet at the next unused index', async () => {
    const store = new MemoryStore();
    const first = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store });
    const url1 = `http://127.0.0.1:${await first.listen(0)}`;
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } }, url1);
    const evm = new EvmXpubDeriver(WALLET_A.evm);
    expect((await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'), url1)).body.address).toBe(evm.derive(0));
    expect((await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'), url1)).body.address).toBe(evm.derive(1));
    await first.close();

    const second = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store });
    const url2 = `http://127.0.0.1:${await second.listen(0)}`;
    try {
      const next = (await call(a.key, 'POST', '/v1/payments', pay('USDT_ERC20'), url2)).body;
      expect(next.address).toBe(evm.derive(2)); // not derive(0) or derive(1) again
    } finally {
      await second.close();
    }
  });
});

describe('offline devices are held to the merchant wallet and to the server policy', () => {
  const NGN_15K = { currency: 'NGN', amountMinor: 1_500_000n };

  async function device(deviceId: string, key: string, deriver: { chain: string; derive(i: number): string }) {
    const lease = (await call(key, 'POST', '/v1/leases', { deviceId, size: 20 })).body;
    const rate = (await call(key, 'GET', '/v1/rates/USDT-NGN')).body as RateSnapshot;
    const pos = new OfflinePOS({ deviceId, deriver, lease, store: new MemoryStore() });
    await pos.cacheSnapshot(rate);
    return { pos, lease };
  }
  const push = (key: string, edit?: (op: SyncOp) => void) => ({
    push: async (op: SyncOp) => {
      edit?.(op);
      return (await call(key, 'POST', '/v1/sync', toJson(op))).body as SyncResponse;
    },
  });

  it("accepts a sale whose address derives from the merchant's wallet, and it settles", async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const { pos, lease } = await device('till-a', a.key, new EvmXpubDeriver(WALLET_A.evm));
    const { request } = await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
    expect(request.address).toBe(new EvmXpubDeriver(WALLET_A.evm).derive(lease.start));

    expect(await pos.sync(push(a.key))).toMatchObject({ accepted: 1, rejected: 0 });
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: request.id, scenario: 'exact' });
    expect((await call(a.key, 'GET', `/v1/payments/${request.id}`)).body.status).toBe('paid');
  });

  it("rejects a device deriving from someone else's wallet, or from the sandbox fake, once the merchant has a wallet", async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    for (const wrong of [new EvmXpubDeriver(WALLET_B.evm), new FakeChain('sandbox')]) {
      const { pos } = await device(`till-${Math.random().toString(36).slice(2, 8)}`, a.key, wrong);
      await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
      expect(await pos.sync(push(a.key))).toMatchObject({ accepted: 0, rejected: 1 });
      expect((await pos.rejected())[0]!.reason).toContain('does not derive');
    }
    expect((await call(a.key, 'GET', '/v1/payments')).body).toEqual([]);
  });

  it("runs a synced payment under the merchant's policy, not the one the device wrote for itself", async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const { pos } = await device('till-a', a.key, new EvmXpubDeriver(WALLET_A.evm));
    const { request } = await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });

    await pos.sync(
      push(a.key, (op) => {
        op.request.policy.underpayment.toleranceBps = 10_000; // "forgive everything"
        op.request.policy.minConfirmations = 0;
      }),
    );
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: request.id, scenario: 'underpay', percent: 50 });
    // Under the device's forged policy this would already count as paid.
    expect((await call(a.key, 'GET', `/v1/payments/${request.id}`)).body.status).toBe('partially_paid');
  });

  it('applies the merchant policy to synced payments too', async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm }, policy: { underpayment: { toleranceBps: 1000 } } });
    const { pos } = await device('till-a', a.key, new EvmXpubDeriver(WALLET_A.evm));
    const { request } = await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
    await pos.sync(push(a.key));
    await call(a.key, 'POST', '/v1/sandbox/deposit', { paymentId: request.id, scenario: 'underpay', percent: 95 });
    expect((await call(a.key, 'GET', `/v1/payments/${request.id}`)).body.status).toBe('paid'); // inside the merchant's 10% tolerance
  });

  it("refuses a falsified asset description and a request that outlives its rate", async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const { pos } = await device('till-a', a.key, new EvmXpubDeriver(WALLET_A.evm));
    await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
    const summary = await pos.sync(
      push(a.key, (op) => {
        op.request.asset = { ...op.request.asset, decimals: 0 };
      }),
    );
    expect(summary.rejected).toBe(1);
    expect((await pos.rejected())[0]!.reason).toContain('not one this server prices');

    await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
    await pos.sync(push(a.key, (op) => void (op.request.expiresAt += 86_400_000)));
    expect((await pos.rejected()).map((r) => r.reason).join('|')).toContain('outlives the rate');
  });

  it("cannot hijack another merchant's payment id, and leaves that payment untouched", async () => {
    const a = await newMerchant('Ada', { wallets: { evm: WALLET_A.evm } });
    const b = await newMerchant('Bola', { wallets: { evm: WALLET_B.evm } });
    const victim = (await call(b.key, 'POST', '/v1/payments', pay('USDT_ERC20'))).body;

    const { pos } = await device('till-a', a.key, new EvmXpubDeriver(WALLET_A.evm));
    await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
    const summary = await pos.sync(push(a.key, (op) => void (op.request.id = victim.id))); // collide with Bola's payment
    expect(summary.rejected).toBe(1);
    expect((await pos.rejected())[0]!.reason).toContain('id is already in use');

    const after = (await call(b.key, 'GET', `/v1/payments/${victim.id}`)).body;
    expect(after).toMatchObject({ id: victim.id, merchantId: b.id, address: victim.address, amountDue: victim.amountDue });
  });

  it('outside the sandbox, a merchant without a wallet cannot sync devices either', async () => {
    const prod = await PaycrytServer.create({ apiKey: ADMIN, sandbox: false });
    const url = `http://127.0.0.1:${await prod.listen(0)}`;
    try {
      const bare = await newMerchant('Bare', {}, url);
      const lease = (await call(bare.key, 'POST', '/v1/leases', { deviceId: 'till-x', size: 10 }, url)).body;
      const rate = (await call(bare.key, 'GET', '/v1/rates/USDT-NGN', undefined, url)).body as RateSnapshot;
      const pos = new OfflinePOS({ deviceId: 'till-x', deriver: new FakeChain('sandbox'), lease, store: new MemoryStore() });
      await pos.cacheSnapshot(rate);
      await pos.createPayment({ fiat: NGN_15K, asset: ASSETS.USDT_ERC20 });
      const summary = await pos.sync({ push: async (op) => (await call(bare.key, 'POST', '/v1/sync', toJson(op), url)).body as SyncResponse });
      expect(summary.rejected).toBe(1);
      expect((await pos.rejected())[0]!.reason).toContain('no wallet is configured');
    } finally {
      await prod.close();
    }
  });
});
