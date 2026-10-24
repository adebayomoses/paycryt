import { CURRENCIES, formatUnits, type Currency, type WatchedPayment } from '@paycryt/core';

const COLUMNS = ['id', 'created', 'status', 'fiat_currency', 'fiat_amount', 'asset', 'chain', 'amount_due', 'received', 'address', 'rate_snapshot_hash', 'note'];

/** Quote every cell, retaining commas, quotes and line breaks as data. */
const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Spreadsheet programs can ignore leading whitespace before a formula marker. */
function text(value: string): string {
  return /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
}

function boundary(params: URLSearchParams, name: 'from' | 'to'): number | undefined {
  const values = params.getAll(name);
  if (!values.length) return undefined;
  if (values.length !== 1) throw new Error(`${name} must be supplied at most once`);
  // Deliberately reject locale-dependent dates, absent timezones and normalized impossible dates.
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z)?$/.exec(values[0]!);
  if (!match) throw new Error(`${name} must be a UTC date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:mm:ss[.SSS]Z)`);
  const canonical = `${match[1]}T${match[2] ?? '00:00:00'}.${(match[3] ?? '').padEnd(3, '0')}Z`;
  const time = Date.parse(canonical);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw new Error(`${name} is not a valid UTC date or timestamp`);
  return time;
}

/** The caller must pass only payments visible to its already authenticated principal. */
export function paymentsCsv(payments: WatchedPayment[], params: URLSearchParams): string {
  const from = boundary(params, 'from');
  const to = boundary(params, 'to');
  if (from !== undefined && to !== undefined && from >= to) throw new Error('from must be earlier than to (to is exclusive)');
  const rows = [COLUMNS.map(cell).join(',')];
  for (const { request, status, evaluation } of payments) {
    if ((from !== undefined && request.createdAt < from) || (to !== undefined && request.createdAt >= to)) continue;
    const currency = (CURRENCIES as Record<string, Currency>)[request.fiat.currency];
    if (!currency) throw new Error('Cannot export an unsupported fiat currency');
    const values = [
      text(request.id),
      new Date(request.createdAt).toISOString(),
      text(status),
      text(request.fiat.currency),
      formatUnits(request.fiat.amountMinor, currency.decimals),
      text(request.asset.symbol),
      text(request.asset.chain),
      formatUnits(request.amountDue, request.asset.decimals),
      formatUnits(evaluation.received, request.asset.decimals),
      text(request.address),
      text(request.rateSnapshotHash),
      text(request.metadata?.note ?? ''),
    ];
    rows.push(values.map(cell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
