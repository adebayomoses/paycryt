// Pure helpers for the dashboard. No DOM access here, so they can be unit-tested in Node.

/**
 * Formats an integer amount in minor units (a decimal string, as the API returns bigints) as a decimal string.
 * Uses BigInt, never floats: "2982069" with 6 decimals is "2.982069".
 */
export function formatUnits(value, decimals, { minFraction = 0, group = true } = {}) {
  const raw = String(value ?? '0').trim();
  if (!/^-?\d+$/.test(raw)) return raw; // not a plain integer: show it unchanged rather than guess
  const negative = raw.startsWith('-');
  const digits = BigInt(negative ? raw.slice(1) : raw)
    .toString()
    .padStart(decimals + 1, '0');
  let whole = digits.slice(0, digits.length - decimals);
  let frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  while (frac.length < minFraction) frac += '0';
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** "pay_a17019cda1876e71b6c53fca" -> "pay_a17019…3fca" */
export function shortId(id, head = 10, tail = 4) {
  const s = String(id ?? '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** "refund_required" -> "Refund required" */
export function statusLabel(status) {
  const s = String(status ?? '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Statuses where a customer can still pay. */
export const OPEN_STATUSES = ['awaiting_payment', 'confirming', 'partially_paid'];

/** Statuses an operator should look at. */
export const ATTENTION_STATUSES = ['refund_required', 'manual_review', 'overpaid', 'partially_paid'];
