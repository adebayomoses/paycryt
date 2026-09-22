import { describe, expect, it } from 'vitest';
import { RateEngine, rateToString, type FetchLike } from '@paycryt/core';
import { BinanceRateProvider, CoinGeckoRateProvider, FlutterwaveAdapter, PaystackAdapter, ParallelMarketRateProvider } from '@paycryt/adapters';

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

/** Fake fetch: replies from a queue of canned responses and records each call. */
function mockFetch(...responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift() ?? { json: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, calls };
}

describe('rate adapters', () => {
  it('CoinGecko: parses the simple-price response', async () => {
    const { fetch, calls } = mockFetch({ json: { tether: { ngn: 1502.5, last_updated_at: 1_700_000_000 } } });
    const q = await new CoinGeckoRateProvider(fetch).getRate('USDT', 'NGN');
    expect(rateToString(q.price)).toBe('1502.5');
    expect(q.asOf).toBe(1_700_000_000_000);
    expect(calls[0]!.url).toContain('ids=tether&vs_currencies=ngn');
  });

  it('CoinGecko: throws on unknown asset and HTTP errors', async () => {
    const { fetch } = mockFetch({ status: 429, json: {} });
    await expect(new CoinGeckoRateProvider(fetch).getRate('USDT', 'NGN')).rejects.toThrow('429');
    await expect(new CoinGeckoRateProvider(fetch).getRate('WAT', 'NGN')).rejects.toThrow('unknown asset');
  });

  it('Binance: reads the ticker price', async () => {
    const { fetch, calls } = mockFetch({ json: { symbol: 'USDTNGN', price: '1498.10' } });
    const q = await new BinanceRateProvider(fetch, { clock: () => 5 }).getRate('USDT', 'NGN');
    expect(rateToString(q.price)).toBe('1498.1');
    expect(calls[0]!.url).toContain('symbol=USDTNGN');
  });

  it('parallel-market provider accepts any async source and feeds the engine next to others', async () => {
    const now = () => 1_700_000_000_000;
    const parallel = new ParallelMarketRateProvider('street', async () => 1510, now);
    const bad = new ParallelMarketRateProvider('typo', async () => 15100, now);
    const official = new ParallelMarketRateProvider('official', async () => 1500, now);
    const engine = new RateEngine({ providers: [parallel, official, bad], now });
    const s = await engine.getSnapshot({ base: 'USDT', quote: 'NGN', direction: 'CRYPTO_TO_FIAT' });
    expect(s.mid).toBe('1505'); // typo rate rejected as outlier; median of the two sane sources
    expect(s.rejected.map((r) => r.source)).toEqual(['typo']);
  });
});

describe('PaystackAdapter', () => {
  it('creates a recipient then a transfer in minor units, with the idempotent reference', async () => {
    const { fetch, calls } = mockFetch(
      { json: { status: true, data: { recipient_code: 'RCP_1' } } },
      { json: { status: true, data: { status: 'success', transfer_code: 'TRF_1' } } },
    );
    const res = await new PaystackAdapter('sk_test_x', fetch).payout({
      reference: 'settle_pay_1',
      currency: 'NGN',
      amountMinor: 1_485_000n,
      destination: { type: 'bank', bankCode: '058', accountNumber: '0123456789', accountName: 'Ada' },
    });
    expect(res).toEqual({ reference: 'settle_pay_1', status: 'succeeded', providerRef: 'TRF_1', failureReason: undefined });
    expect(calls[0]).toMatchObject({ url: 'https://api.paystack.co/transferrecipient', body: { type: 'nuban', bank_code: '058', account_number: '0123456789' } });
    expect(calls[1]!.body).toMatchObject({ amount: 1_485_000, recipient: 'RCP_1', reference: 'settle_pay_1', currency: 'NGN' });
    expect(calls[1]!.headers!.authorization).toBe('Bearer sk_test_x');
  });

  it('maps mobile-money payouts and pending/failed states', async () => {
    const { fetch, calls } = mockFetch(
      { json: { status: true, data: { recipient_code: 'RCP_2' } } },
      { json: { status: true, data: { status: 'pending', transfer_code: 'TRF_2' } } },
    );
    const res = await new PaystackAdapter('k', fetch).payout({
      reference: 'r2',
      currency: 'GHS',
      amountMinor: 5_000n,
      destination: { type: 'mobile_money', operator: 'MTN', phone: '233240000000' },
    });
    expect(res.status).toBe('processing');
    expect(calls[0]!.body).toMatchObject({ type: 'mobile_money', bank_code: 'MTN', account_number: '233240000000' });
  });

  it('surfaces provider errors instead of swallowing them', async () => {
    const { fetch } = mockFetch({ status: 400, json: { status: false, message: 'Invalid key' } });
    await expect(
      new PaystackAdapter('bad', fetch).payout({ reference: 'r', currency: 'NGN', amountMinor: 100n, destination: { type: 'bank', bankCode: '1', accountNumber: '2' } }),
    ).rejects.toThrow('Invalid key');
  });

  it('starts a mobile-money charge', async () => {
    const { fetch, calls } = mockFetch({ json: { status: true, data: { status: 'pay_offline', display_text: 'Approve on your phone' } } });
    const res = await new PaystackAdapter('k', fetch).collect({
      reference: 'c1',
      currency: 'GHS',
      amountMinor: 10_000n,
      email: 'a@b.co',
      mobileMoney: { operator: 'MTN', phone: '233240000000' },
    });
    expect(res).toMatchObject({ status: 'pending_customer_action', instruction: 'Approve on your phone' });
    expect(calls[0]!.body).toMatchObject({ amount: 10_000, mobile_money: { provider: 'mtn' } });
  });
});

describe('FlutterwaveAdapter', () => {
  it('sends payouts in MAJOR units to the right bank/mobile-money code', async () => {
    const { fetch, calls } = mockFetch({ json: { status: 'success', data: { id: 777, status: 'NEW' } } }, { json: { status: 'success', data: { id: 777, status: 'SUCCESSFUL' } } });
    const fw = new FlutterwaveAdapter('FLWSECK_TEST-x', fetch);
    const res = await fw.payout({
      reference: 'settle_pay_9',
      currency: 'KES',
      amountMinor: 250_050n,
      destination: { type: 'mobile_money', operator: 'MPS', phone: '254700000000' },
    });
    expect(calls[0]!.body).toMatchObject({ account_bank: 'MPS', account_number: '254700000000', amount: 2500.5, currency: 'KES', reference: 'settle_pay_9' });
    expect(res).toMatchObject({ status: 'pending', providerRef: '777' });

    const later = await fw.getPayout('settle_pay_9', '777');
    expect(later.status).toBe('succeeded');
    expect(calls[1]!.url).toBe('https://api.flutterwave.com/v3/transfers/777');
  });

  it('requires the provider id to check a payout', async () => {
    const { fetch } = mockFetch();
    await expect(new FlutterwaveAdapter('k', fetch).getPayout('r')).rejects.toThrow('providerRef');
  });

  it('starts an M-Pesa charge for KES and rejects unmapped currencies', async () => {
    const { fetch, calls } = mockFetch({ json: { status: 'success', data: { id: 5, status: 'pending' }, meta: { authorization: { note: 'Enter your M-Pesa PIN' } } } });
    const fw = new FlutterwaveAdapter('k', fetch);
    const res = await fw.collect({ reference: 'c9', currency: 'KES', amountMinor: 10_000n, email: 'a@b.co', mobileMoney: { operator: 'MPS', phone: '254700000000' } });
    expect(res).toMatchObject({ status: 'pending_customer_action', instruction: 'Enter your M-Pesa PIN' });
    expect(calls[0]!.url).toContain('/charges?type=mpesa');
    await expect(fw.collect({ reference: 'c10', currency: 'NGN', amountMinor: 1n, email: 'a@b.co', mobileMoney: { operator: 'X', phone: '1' } })).rejects.toThrow('mapped');
  });
});
