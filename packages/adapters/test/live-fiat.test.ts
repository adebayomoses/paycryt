import { describe, expect, it } from 'vitest';
import { FlutterwaveAdapter, PaystackAdapter } from '@paycryt/adapters';

/**
 * Opt-in checks against the REAL Paystack/Flutterwave sandbox APIs — not mocked HTTP. Skipped entirely
 * unless PAYSTACK_TEST_KEY / FLUTTERWAVE_TEST_KEY are set, so CI and everyone else's `npm test` never
 * need real credentials.
 *
 *   PAYSTACK_TEST_KEY=sk_test_...        npx vitest run live-fiat
 *   FLUTTERWAVE_TEST_KEY=FLWSECK_TEST-... npx vitest run live-fiat
 *
 * Only the parts stable across any developer's own test account are asserted. A payout's actual success
 * depends on account-specific settings Paystack/Flutterwave gate behind their dashboards (see adapters.md)
 * — those are exercised manually, not asserted here, because a fresh test account would fail them by
 * default through no fault of the adapter.
 */
const paystackKey = process.env.PAYSTACK_TEST_KEY;
const flutterwaveKey = process.env.FLUTTERWAVE_TEST_KEY;

describe.skipIf(!paystackKey)('PaystackAdapter, live sandbox', () => {
  const ps = new PaystackAdapter(paystackKey!, globalThis.fetch as never);

  it('getPayout on a reference never sent to Paystack reports a failed status, not a thrown error', async () => {
    const r = await ps.getPayout(`nonexistent_${Date.now()}`);
    expect(r).toMatchObject({ status: 'failed', failureReason: 'unknown reference' });
  });

  it('rejects a malformed collect() request instead of silently succeeding', async () => {
    await expect(ps.collect({ reference: `bad_${Date.now()}`, currency: 'GHS', amountMinor: 1000n, email: 'not-an-email' })).rejects.toThrow();
  });
});

describe.skipIf(!flutterwaveKey)('FlutterwaveAdapter, live sandbox', () => {
  const fw = new FlutterwaveAdapter(flutterwaveKey!, globalThis.fetch as never);

  it('getCollection on a reference never sent to Flutterwave reports a failed status, not a thrown error', async () => {
    const r = await fw.getCollection(`nonexistent_${Date.now()}`);
    expect(r).toMatchObject({ status: 'failed', failureReason: 'unknown reference' });
  });

  it('starts a real M-Pesa (KES) mobile-money charge end to end', async () => {
    const r = await fw.collect({
      reference: `live_mpesa_${Date.now()}`,
      currency: 'KES',
      amountMinor: 100_000n, // 1,000.00 KES
      email: 'test@example.com',
      mobileMoney: { operator: 'MPS', phone: '254708374149' }, // Safaricom Daraja's published sandbox test number
    });
    expect(r.status).toBe('pending_customer_action'); // the customer approves a real STK push prompt; we stop here
    expect(r.providerRef).toBeTruthy();
  });
});
