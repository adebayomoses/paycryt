import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSETS, DEFAULT_POLICY, FakeChain, MemoryStore, type PaymentRequest } from '@paycryt/core';
import { PaycrytServer, type ServerConfig } from '@paycryt/server';

const ADMIN = 'csv_synthetic_admin';
const CREATED = Date.parse('2026-10-18T10:20:30.123Z');
const COLUMNS = ['id', 'created', 'status', 'fiat_currency', 'fiat_amount', 'asset', 'chain', 'amount_due', 'received', 'address', 'rate_snapshot_hash', 'note'];
const HEADER = COLUMNS.map((name) => `"${name}"`).join(',') + '\r\n';
let server: PaycrytServer;
let base: string;

async function boot(overrides: Partial<ServerConfig> = {}) {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, store: new MemoryStore(), pollIntervalMs: 60_000, ...overrides });
  base = `http://127.0.0.1:${await server.listen(0)}`;
}
beforeEach(() => boot());
afterEach(() => server.close());

function request(path = '/v1/payments.csv', key: string | null = ADMIN) {
  return fetch(base + path, { headers: key === null ? {} : { authorization: `Bearer ${key}` } });
}

async function action(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}

async function merchant(name: string) {
  const result = await action('/v1/admin/merchants', { name });
  return { id: result.merchant.id as string, key: result.apiKey as string };
}

function seed(id: string, overrides: Partial<PaymentRequest> = {}) {
  const payment: PaymentRequest = {
    id, fiat: { currency: 'NGN', amountMinor: 10025n }, asset: ASSETS.USDT_TRC20,
    address: `fake:csv:${id}`, amountDue: 12345678n, rateSnapshotHash: 'snapshot_csv',
    effectiveRate: '1500', createdAt: CREATED, expiresAt: CREATED + 365 * 24 * 60 * 60_000,
    policy: DEFAULT_POLICY, ...overrides,
  };
  server.watcher.watch(payment);
  return payment;
}

// A strict consumer: every field must be quoted and every record must end with CRLF.
// Quoted embedded commas, quotes and line breaks remain part of the original cell.
function readCsv(text: string): string[][] {
  const token = /"((?:""|[^"])*)"(,|\r\n)/gy;
  const rows: string[][] = [];
  let row: string[] = [];
  let position = 0;
  while (position < text.length) {
    token.lastIndex = position;
    const match = token.exec(text);
    expect(match, `invalid CSV at byte ${position}`).not.toBeNull();
    row.push(match![1]!.replace(/""/g, '"'));
    position = token.lastIndex;
    if (match![2] === '\r\n') {
      rows.push(row);
      row = [];
    }
  }
  expect(row).toEqual([]);
  expect(rows[0]).toEqual(COLUMNS);
  for (const record of rows) expect(record).toHaveLength(COLUMNS.length);
  return rows;
}

async function exported(path = '/v1/payments.csv', key = ADMIN) {
  const response = await request(path, key);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/csv\s*;\s*charset=utf-8$/i);
  return readCsv(await response.text());
}

function record(row: string[]) {
  return Object.fromEntries(COLUMNS.map((name, index) => [name, row[index]]));
}

describe('reconciliation CSV', () => {
  it('returns only the fixed quoted header for an empty snapshot', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HEADER);
  });

  it('exports UTC creation, current status, exact six-decimal units and absent metadata', async () => {
    seed('pay_csv');
    const rows = await exported();
    expect(rows).toHaveLength(2);
    expect(record(rows[1]!)).toEqual({
      id: 'pay_csv', created: '2026-10-18T10:20:30.123Z', status: 'awaiting_payment',
      fiat_currency: 'NGN', fiat_amount: '100.25', asset: 'USDT', chain: 'tron',
      amount_due: '12.345678', received: '0', address: 'fake:csv:pay_csv',
      rate_snapshot_hash: 'snapshot_csv', note: '',
    });
  });

  it('preserves bigint amounts beyond Number precision, including eighteen decimals and received value', async () => {
    const payment = seed('pay_big', {
      fiat: { currency: 'GHS', amountMinor: 900719925474099312345n },
      asset: ASSETS.USDT_BEP20, amountDue: 900719925474099300000000000000000001n,
    });
    const chain = server.chains.get(payment.asset.chain);
    expect(chain).toBeInstanceOf(FakeChain);
    (chain as FakeChain).simulateDeposit({ address: payment.address, assetSymbol: payment.asset.symbol, amount: 900719925474099300000000000000000000n, confirmations: 1 });
    await server.poll();
    const rows = await exported();
    expect(record(rows[1]!)).toMatchObject({ fiat_currency: 'GHS', fiat_amount: '9007199254740993123.45', asset: 'USDT', chain: 'bsc', amount_due: '900719925474099300.000000000000000001', received: '900719925474099300', status: 'paid' });
  });

  it('does not round a large six-decimal amount or emit exponent notation', async () => {
    seed('pay_big_six', { amountDue: 9007199254740993123456n });
    const rows = await exported();
    expect(record(rows[1]!)).toMatchObject({ amount_due: '9007199254740993.123456', received: '0' });
  });

  it('quotes commas, embedded quotes, CRLF and Unicode without adding CSV records', async () => {
    seed('pay_text', { metadata: { note: 'Café, "账单"\r\nsecond line' } });
    const response = await request();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"Café, ""账单""\r\nsecond line"\r\n');
    const rows = readCsv(text);
    expect(rows).toHaveLength(2);
    expect(record(rows[1]!).note).toBe('Café, "账单"\r\nsecond line');
  });

  it('neutralizes formula prefixes after whitespace/controls and initial tab/CR/LF, preserving original text', async () => {
    const dangerous = ['=1+1', '+SUM(1,2)', '-1', '@SUM(1,2)', '  =1', '\u00a0+1', '\u0000=1', '\u001f@x', '\tordinary', '\rordinary', '\nordinary', ' \t-1'];
    dangerous.forEach((note, index) => seed(`pay_formula_${index}`, { metadata: { note } }));
    const rows = await exported();
    expect(rows.slice(1).map((row) => record(row).note)).toEqual(dangerous.map((note) => "'" + note));
  });

  it('preserves safe notes, apostrophes and empty metadata without unnecessary prefixes', async () => {
    const notes = ['', 'plain', "'already text", '  ordinary', 'name=value', 'Café\nsecond line'];
    notes.forEach((note, index) => seed(`pay_safe_${index}`, { metadata: { note } }));
    seed('pay_empty_metadata', { metadata: {} });
    const rows = await exported();
    expect(rows.slice(1).map((row) => record(row).note)).toEqual([...notes, '']);
  });

  it('protects other textual cells as well as customer notes', async () => {
    seed('=synthetic-id', { address: '+synthetic,address', rateSnapshotHash: '@synthetic-hash', metadata: { note: 'safe' } });
    const rows = await exported();
    expect(record(rows[1]!)).toMatchObject({ id: "'=synthetic-id", address: "'+synthetic,address", rate_snapshot_hash: "'@synthetic-hash", note: 'safe' });
  });
});

describe('CSV visibility and request guards', () => {
  it('matches the JSON-list scope for admin, two merchants, an empty merchant and unowned records', async () => {
    const a = await merchant('CSV A');
    const b = await merchant('CSV B');
    const empty = await merchant('CSV empty');
    seed('pay_a', { merchantId: a.id });
    seed('pay_b', { merchantId: b.id });
    seed('pay_unowned');
    for (const [key, wanted] of [[ADMIN, ['pay_a', 'pay_b', 'pay_unowned']], [a.key, ['pay_a']], [b.key, ['pay_b']], [empty.key, []]] as const) {
      const rows = await exported('/v1/payments.csv', key);
      expect(rows.slice(1).map((row) => row[0]).sort()).toEqual([...wanted].sort());
      const list = await (await request('/v1/payments', key)).json();
      expect(rows.slice(1).map((row) => row[0]).sort()).toEqual(list.map((payment: { id: string }) => payment.id).sort());
    }
  });

  it('rejects missing, invalid and disabled keys, including before range validation', async () => {
    expect((await request('/v1/payments.csv', null)).status).toBe(401);
    expect((await request('/v1/payments.csv', 'csv_invalid_key')).status).toBe(401);
    expect((await request('/v1/payments.csv?from=garbage', 'csv_invalid_key')).status).toBe(401);
    const disabled = await merchant('Disabled CSV');
    await action(`/v1/admin/merchants/${disabled.id}/disable`);
    expect((await request('/v1/payments.csv', disabled.key)).status).toBe(401);
  });

  it('shares the authenticated request budget with the existing JSON list', async () => {
    await server.close();
    await boot({ requestsPerMinute: 1, requestBurst: 1 });
    expect((await request('/v1/payments')).status).toBe(200);
    const response = await request();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('CSV UTC range filters', () => {
  it('uses inclusive from and exclusive to, intersected with merchant visibility', async () => {
    const a = await merchant('Range A');
    const b = await merchant('Range B');
    const boundary = Date.parse('2026-10-18T00:00:00Z');
    seed('pay_before', { merchantId: a.id, createdAt: boundary - 1 });
    seed('pay_at', { merchantId: a.id, createdAt: boundary });
    seed('pay_inside', { merchantId: a.id, createdAt: boundary + 1 });
    seed('pay_end', { merchantId: a.id, createdAt: boundary + 24 * 60 * 60_000 });
    seed('pay_other', { merchantId: b.id, createdAt: boundary });
    const rows = await exported('/v1/payments.csv?from=2026-10-18&to=2026-10-19', a.key);
    expect(rows.slice(1).map((row) => row[0]).sort()).toEqual(['pay_at', 'pay_inside']);
    const exact = await exported('/v1/payments.csv?from=2026-10-18T00%3A00%3A00.001Z&to=2026-10-19', a.key);
    expect(exact.slice(1).map((row) => row[0])).toEqual(['pay_inside']);
  });

  it.each(['2026-10-18', '2026-10-18T10:20:30Z', '2026-10-18T10:20:30.1Z', '2026-10-18T10:20:30.12Z', '2026-10-18T10:20:30.123Z'])('accepts supported UTC lower bound %s', async (from) => {
    seed('pay_date');
    const rows = await exported('/v1/payments.csv?' + new URLSearchParams({ from }));
    expect(rows.slice(1).map((row) => row[0])).toEqual(['pay_date']);
  });

  it('accepts a real leap day and a to-only filter', async () => {
    expect(await exported('/v1/payments.csv?from=2024-02-29&to=2024-03-01')).toEqual([COLUMNS]);
    seed('pay_date');
    expect((await exported('/v1/payments.csv?to=2026-10-19')).slice(1)).toHaveLength(1);
  });

  it.each([
    'from=2026-02-29', 'from=2026-04-31', 'from=2026-00-01', 'from=2026-13-01',
    'from=2026-10-00', 'from=2026-10-18T24:00:00Z', 'from=2026-10-18T10:60:00Z',
    'from=2026-10-18T10:00:60Z', 'from=2026-10-18T10:00:00',
    'from=2026-10-18T10:00:00%2B00:00', 'from=2026-10-18T10:00:00.1234Z',
    'from=2026-10-18T10:00:00.Z', 'from=2026-10-18garbage', 'from=12345', 'from=',
    'to=2026-02-30', 'to=not-a-date', 'to=',
    'from=2026-10-18&from=2026-10-19', 'to=2026-10-18&to=2026-10-19',
    'from=2026-10-18&to=2026-10-18', 'from=2026-10-19&to=2026-10-18',
  ])('rejects malformed, impossible, duplicate or reversed range %s', async (query) => {
    const response = await request('/v1/payments.csv?' + query);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).error).toBeTypeOf('string');
  });
});
