import { afterEach, describe, expect, it } from 'vitest';
import { ASSETS, EvmXpubDeriver, MemoryStore, OfflinePOS, StaticRateProvider, evmAccountXpub, toJson, type FetchLike, type RateSnapshot } from '@paycryt/core';
import { EsploraChainAdapter, EvmRpcChainAdapter, TronGridChainAdapter } from '@paycryt/adapters';
import { PaycrytServer } from '@paycryt/server';
import { PosDevice } from '../pos/src/device.js';

/**
 * A live server must never take a payment in something its chain watcher cannot see. Native ETH is in the asset table
 * (it has a price) but EvmRpcChainAdapter only watches ERC-20 transfer logs, so a customer who paid ETH to the address
 * would never be detected: the payment would sit "awaiting" forever while the watcher errors on every poll.
 */

const ADMIN = 'admin_key_0123456789abcdef';
const MNEMONIC = 'test test test test test test test test test test test junk';
const XPUB = evmAccountXpub(MNEMONIC);

/** A stand-in Ethereum node: answers eth_blockNumber and returns no logs. Enough for the real adapter to run. */
const rpc: FetchLike = async (_url, init) => {
  const answer = (r: { id: number; method: string }) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_blockNumber' ? '0x100' : [] });
  const body = JSON.parse(init!.body!);
  const out = Array.isArray(body) ? body.map(answer) : answer(body);
  return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
};

let server: PaycrytServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function liveEthereumServer() {
  server = await PaycrytServer.create({
    apiKey: ADMIN,
    sandbox: false,
    chains: [new EvmRpcChainAdapter({ fetch: rpc, rpcUrl: 'https://rpc.example', chain: 'ethereum' })],
    rateProviders: [new StaticRateProvider('feed', { 'USDT/NGN': '1500', 'ETH/NGN': '4000000' })],
    pollIntervalMs: 50,
  });
  const url = `http://127.0.0.1:${await server.listen(0)}`;
  const call = async (key: string, method: string, path: string, body?: unknown, raw?: string) => {
    const r = await fetch(url + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const m = await call(ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada', wallets: { evm: XPUB } });
  return { url, call, key: m.body.apiKey as string };
}

describe('a live server only offers what its chain watcher can actually see', () => {
  it('lists USDT on Ethereum but not native ETH in /v1/assets', async () => {
    const { call, key } = await liveEthereumServer();
    const r = (await call(key, 'GET', '/v1/assets')).body;
    expect(r.assets.USDT_ERC20).toBeDefined();
    expect(r.assets.ETH).toBeUndefined();
    expect(r.chains).toEqual(['ethereum']);
  });

  it('refuses to create a payment in native ETH with a clear 400, not a vague 503', async () => {
    const { call, key } = await liveEthereumServer();
    const r = await call(key, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'ETH' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot watch|can't watch|not supported/i);
    expect((await call(key, 'GET', '/v1/payments')).body).toEqual([]);
  });

  it('still creates a payment in USDT on Ethereum', async () => {
    const { call, key } = await liveEthereumServer();
    const r = await call(key, 'POST', '/v1/payments', { amount: '15000', currency: 'NGN', asset: 'USDT_ERC20' });
    expect(r.status).toBe(201);
  });

  it('refuses a till that syncs an ETH sale, instead of watching an address it can never see paid', async () => {
    const { call, key } = await liveEthereumServer();
    // A till (an older app, or a modified one) prices and sells ETH offline. ETH has a live rate, so this works on the device.
    const lease = (await call(key, 'POST', '/v1/leases', { deviceId: 'till-1', size: 10 })).body as { start: number; end: number };
    const snapshot = (await call(key, 'GET', '/v1/rates/ETH-NGN')).body as RateSnapshot;
    const pos = new OfflinePOS({ deviceId: 'till-1', deriver: new EvmXpubDeriver(XPUB), lease, store: new MemoryStore() });
    await pos.cacheSnapshot(snapshot);
    await pos.createPayment({ fiat: { currency: 'NGN', amountMinor: 1_500_000n }, asset: ASSETS.ETH });
    const [op] = await pos.pending();

    const r = await call(key, 'POST', '/v1/sync', undefined, toJson(op));
    expect(r.body.status).toBe('rejected');
    expect(r.body.reason).toMatch(/asset ETH/);
    expect((await call(key, 'GET', '/v1/payments')).body).toEqual([]); // nothing is being watched that cannot be
  });
});

describe('the till follows the server', () => {
  it('never offers native ETH, so a cashier cannot sell something the server would refuse after the customer paid', async () => {
    const { url, key } = await liveEthereumServer();
    const device = await PosDevice.open({ store: new MemoryStore(), baseUrl: url });
    await device.pair({ apiKey: key, currency: 'NGN' });
    expect(device.candidateKeys()).toEqual(['USDT_ERC20']); // ETH has a live price and a wallet, but cannot be watched
    expect(device.sellableKeys()).toEqual(['USDT_ERC20']);
    await expect(device.sell({ amount: '1000', assetKey: 'ETH' })).rejects.toThrow(/not set up/);
    expect(await device.sales()).toEqual([]);
  });
});

describe('each real adapter says honestly what it can watch', () => {
  it('EvmRpcChainAdapter: ERC-20s it has a contract for, never native ETH', () => {
    const eth = new EvmRpcChainAdapter({ fetch: rpc, rpcUrl: 'https://rpc.example', chain: 'ethereum' });
    expect(eth.supportsAsset(ASSETS.USDT_ERC20)).toBe(true);
    expect(eth.supportsAsset(ASSETS.ETH)).toBe(false);
    expect(eth.supportsAsset(ASSETS.USDT_TRC20)).toBe(false); // wrong chain
    expect(eth.supportsAsset(ASSETS.USDC_BASE)).toBe(false); // right symbol, other chain
    const base = new EvmRpcChainAdapter({ fetch: rpc, rpcUrl: 'https://rpc.example', chain: 'base' });
    expect(base.supportsAsset(ASSETS.USDC_BASE)).toBe(true);
    // A different contract under the same symbol is a different token: never treat it as watched.
    expect(eth.supportsAsset({ ...ASSETS.USDT_ERC20, contract: '0x0000000000000000000000000000000000000001' })).toBe(false);
  });

  it('TronGridChainAdapter: TRC20 USDT only', () => {
    const tron = new TronGridChainAdapter({ fetch: rpc });
    expect(tron.supportsAsset(ASSETS.USDT_TRC20)).toBe(true);
    expect(tron.supportsAsset(ASSETS.USDT_ERC20)).toBe(false);
  });

  it('EsploraChainAdapter: BTC only', () => {
    const btc = new EsploraChainAdapter({ fetch: rpc });
    expect(btc.supportsAsset(ASSETS.BTC)).toBe(true);
    expect(btc.supportsAsset(ASSETS.ETH)).toBe(false);
  });
});
