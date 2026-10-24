// Paycryt dashboard. Plain ES modules, no framework, no build step, no third-party code.
//
// Security notes:
//  - The API key lives in this module's memory only: not localStorage, not a cookie. Reload = sign in again.
//  - Every value from the API is inserted with textContent / createTextNode, never innerHTML.
//  - The server sends a strict CSP, so there is no inline script and nothing is loaded from another origin.

import { qrMatrix } from './qr.js';
import { OPEN_STATUSES, formatUnits, shortId, statusLabel } from './util.js';

const appEl = document.getElementById('app');
const toastsEl = document.getElementById('toasts');

const state = {
  key: null, // API key, memory only
  role: null, // 'admin' | 'merchant'
  me: null,
  health: null, // { sandbox, mode } from the unauthenticated /health
  catalog: null, // { assets, currencies, chains } from /v1/assets
  tab: 'payments',
  adminTab: 'status',
  payments: [],
  selectedId: null,
  filter: 'all',
  loading: false,
};
let pollTimer = null;
let sessionGeneration = 0;

const CHAIN_NAMES = { tron: 'Tron (TRC20)', ethereum: 'Ethereum (ERC20)', bsc: 'BNB Chain (BEP20)', base: 'Base', bitcoin: 'Bitcoin' };
const SCENARIOS = [
  ['exact', 'Exact payment'],
  ['underpay', 'Underpay (50%)'],
  ['overpay', 'Overpay (120%)'],
  ['split', 'Split in two'],
  ['unconfirmed', 'Unconfirmed'],
  ['late', 'Late (after expiry)'],
];

// ------------------------------------------------------------------ tiny DOM helpers

/** h('div', { class: 'x', onclick }, child, 'text', ...) — children are always inserted as nodes or text. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clear = (el) => el.replaceChildren();
const view = () => document.getElementById('view');

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  toastsEl.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = old), 1200);
  } catch {
    toast('Could not copy automatically. Select the text and copy it.', 'error');
  }
}
const copyBtn = (text, label = 'Copy') => h('button', { class: 'btn small', type: 'button', onclick: (e) => copyText(text, e.currentTarget) }, label);

// ------------------------------------------------------------------ API

class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function api(method, path, body, { keepSession = false } = {}) {
  const headers = { authorization: `Bearer ${state.key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && state.key && !keepSession) {
    signOut('That API key was rejected. Please sign in again.');
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const msg = res.status === 429 ? `Too many requests. Try again in ${retry ?? 'a few'} seconds.` : data?.error || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, retry);
  }
  return data;
}

// ------------------------------------------------------------------ formatting

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fiat = (f) => `${f.currency} ${formatUnits(f.amountMinor, 2, { minFraction: 2 })}`;
const coin = (minor, asset) => `${formatUnits(minor, asset.decimals)} ${asset.symbol}`;
const isZero = (v) => v === undefined || v === null || /^-?0+$/.test(String(v));
const badge = (status) => h('span', { class: `badge ${status}` }, statusLabel(status));
const chainName = (c) => CHAIN_NAMES[c] ?? c;

function errorBox(err) {
  const hint = err?.status === 503 ? ' This usually means a price source or the blockchain node is unreachable right now. Nothing was created.' : '';
  return h('div', { class: 'callout error', role: 'alert' }, (err?.message || String(err)) + hint);
}

// ------------------------------------------------------------------ boot, login, sign-out

async function boot() {
  try {
    const res = await fetch('/health');
    state.health = await res.json();
  } catch {
    state.health = null;
  }
  renderLogin();
}

function renderLogin(message) {
  stopPolling();
  document.title = 'Paycryt dashboard';
  appEl.className = 'app';
  clear(appEl);
  const sandbox = state.health?.sandbox;
  const input = h('input', { class: 'input', id: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'API key', 'aria-describedby': 'key-hint' });
  const error = h('div', { id: 'login-error', class: 'callout error hidden', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.classList.add('hidden');
        try {
          await signIn(input.value.trim());
        } catch (err) {
          error.textContent = err.status === 401 ? 'That API key was not accepted.' : `Could not sign in: ${err.message}`;
          error.classList.remove('hidden');
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'key' }, 'API key'), input, h('p', { class: 'hint', id: 'key-hint' }, 'Kept in this page’s memory only. It is never stored in the browser.')),
    error,
    submit,
  );
  if (message) {
    error.textContent = message;
    error.classList.remove('hidden');
  }
  appEl.append(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'card stack' },
        h('div', {}, h('h1', {}, 'Paycryt'), h('p', { class: 'muted' }, 'Open-source, self-hosted crypto payments.')),
        state.health
          ? h('div', {}, h('span', { class: `pill ${sandbox ? 'sandbox' : 'live'}` }, sandbox ? 'SANDBOX · fake money' : 'LIVE · real funds'))
          : h('div', { class: 'callout warn' }, 'Cannot reach the server’s /health endpoint.'),
        sandbox
          ? h(
              'div',
              { class: 'callout info' },
              'Sandbox mode: the default API key is ',
              h('code', {}, 'sandbox_key'),
              '. ',
              h('button', { class: 'btn small', type: 'button', onclick: () => (input.value = 'sandbox_key') }, 'Use it'),
            )
          : null,
        form,
      ),
    ),
  );
  input.focus();
}

async function signIn(key) {
  if (!key) {
    const e = new ApiError(401, 'Enter an API key');
    throw e;
  }
  sessionGeneration += 1;
  state.key = key;
  try {
    state.me = await api('GET', '/v1/me', undefined, { keepSession: true });
    state.role = state.me.role;
    state.catalog = await api('GET', '/v1/assets');
  } catch (err) {
    state.key = null;
    throw err;
  }
  state.tab = 'payments';
  state.selectedId = null;
  renderShell();
}

function signOut(message) {
  sessionGeneration += 1;
  state.key = null;
  state.me = null;
  state.role = null;
  state.payments = [];
  state.selectedId = null;
  renderLogin(message);
}

// ------------------------------------------------------------------ shell and navigation

function renderShell() {
  const sandbox = state.health?.sandbox;
  document.title = `Paycryt · ${sandbox ? 'sandbox' : 'live'}`;
  appEl.className = `app ${sandbox ? 'sandbox' : 'live'}`;
  clear(appEl);
  const tabs = [
    ['payments', 'Payments'],
    ['new', 'New payment'],
    ['rates', 'Rates & audit'],
    [state.role === 'admin' ? 'admin' : 'account', state.role === 'admin' ? 'Admin' : 'Account'],
  ];
  // A till opens the POS app; show the link only when this server actually has it built.
  const posLink = h('a', { class: 'btn small hidden', href: '/ui/pos.html' }, 'Open POS');
  if (state.role === 'merchant') {
    fetch('/ui/pos.js', { method: 'HEAD' }).then((r) => r.ok && posLink.classList.remove('hidden')).catch(() => undefined);
  }
  appEl.append(
    h(
      'header',
      { class: 'topbar' },
      h('span', { class: 'brand' }, 'Paycryt'),
      h('span', { class: `pill ${sandbox ? 'sandbox' : 'live'}`, title: sandbox ? 'Fake chain and simulated deposits. No real money moves.' : 'Real chains and real prices.' }, sandbox ? 'SANDBOX · fake money' : 'LIVE · real funds'),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted small' }, state.role === 'admin' ? 'Signed in as operator' : `Signed in as ${state.me.merchant?.name ?? 'merchant'}`),
      posLink,
      h('button', { class: 'btn small', type: 'button', onclick: () => signOut() }, 'Sign out'),
    ),
    h(
      'nav',
      { class: 'tabs', role: 'tablist' },
      tabs.map(([id, label]) => h('button', { class: `tab ${state.tab === id ? 'active' : ''}`, 'data-tab': id, role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', type: 'button', onclick: () => setTab(id) }, label)),
    ),
    h('main', { id: 'view' }),
  );
  renderTab();
  startPolling();
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderTab();
}

function renderTab() {
  const v = view();
  clear(v);
  if (state.tab === 'payments') viewPayments();
  else if (state.tab === 'new') viewNewPayment();
  else if (state.tab === 'rates') viewRates();
  else if (state.tab === 'admin') viewAdmin();
  else viewAccount();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || !state.key || state.tab !== 'payments') return;
    loadPayments(true);
  }, 4000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------ payments

async function downloadPayments(button) {
  const generation = sessionGeneration;
  const key = state.key;
  const current = () => generation === sessionGeneration && key === state.key;
  if (!key || button.disabled) return;
  button.disabled = true;
  try {
    const res = await fetch('/v1/payments.csv', {
      headers: { authorization: `Bearer ${key}` }, cache: 'no-store', redirect: 'error',
    });
    if (!current()) return;
    if (!res.ok) {
      let data;
      try { data = await res.json(); } catch { /* a non-JSON error still has a status */ }
      if (!current()) return;
      if (res.status === 401) {
        signOut('That API key was rejected. Please sign in again.');
        return;
      }
      const retry = res.headers.get('retry-after');
      throw new Error(res.status === 429 ? `Too many requests. Try again in ${retry ?? 'a few'} seconds.` : data?.error || `Download failed (${res.status}).`);
    }
    if (!/^text\/csv(?:;|$)/i.test(res.headers.get('content-type') ?? '')) throw new Error('The server did not return a CSV file.');
    const blob = await res.blob();
    if (!current()) return;
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: 'paycryt-payments.csv' });
    document.body.append(link);
    try { link.click(); } finally {
      link.remove();
      // Give the browser time to consume the download before releasing its temporary URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (err) {
    if (current()) toast(err.message || 'Could not download payments.', 'error');
  } finally {
    button.disabled = false;
  }
}

function viewPayments() {
  const filter = h(
    'select',
    { 'aria-label': 'Filter payments', class: 'input w-auto', onchange: (e) => { state.filter = e.target.value; renderRows(); } },
    [['all', 'All payments'], ['open', 'Open'], ['paid', 'Paid'], ['attention', 'Needs attention']].map(([v, l]) => h('option', { value: v, selected: state.filter === v }, l)),
  );
  const list = h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'row' }, h('h2', {}, 'Payments'), h('span', { class: 'muted small', id: 'count' }), h('span', { class: 'grow' }), filter,
      h('button', { class: 'btn small', type: 'button', title: 'Download all accessible payments, regardless of the screen filter or 200-row limit.', onclick: (e) => downloadPayments(e.currentTarget) }, 'Download CSV'),
      h('button', { class: 'btn small', type: 'button', onclick: () => loadPayments() }, 'Refresh')),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Status', 'Amount', 'Due', 'Received', 'Payment'].map((c, i) => h('th', { scope: 'col', class: i >= 3 ? 'hide-sm' : '' }, c)))),
        h('tbody', { id: 'rows' }),
      ),
    ),
    h('div', { id: 'list-empty', class: 'empty hidden' }, 'No payments yet. Create one from the “New payment” tab.'),
    h('div', { id: 'list-error' }),
  );
  view().append(h('div', { class: 'split' }, list, h('aside', { class: 'detail card', id: 'detail' }, h('div', { class: 'empty' }, 'Select a payment to see its address, QR code and history.'))));
  renderRows();
  loadPayments();
}

async function loadPayments(quiet = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const list = await api('GET', '/v1/payments');
    state.payments = list.slice().reverse(); // newest first
    const errEl = document.getElementById('list-error');
    if (errEl) clear(errEl);
    renderRows();
    if (state.selectedId) await renderDetail(state.selectedId);
  } catch (err) {
    if (err.status === 401) return;
    const errEl = document.getElementById('list-error');
    if (errEl && !quiet) errEl.replaceChildren(errorBox(err));
  } finally {
    state.loading = false;
  }
}

function matchesFilter(p) {
  if (state.filter === 'open') return OPEN_STATUSES.includes(p.status);
  if (state.filter === 'paid') return p.status === 'paid' || p.status === 'overpaid';
  if (state.filter === 'attention') return ['refund_required', 'manual_review', 'overpaid', 'partially_paid'].includes(p.status);
  return true;
}

function renderRows() {
  const rows = document.getElementById('rows');
  if (!rows) return;
  const shown = state.payments.filter(matchesFilter);
  const LIMIT = 200;
  clear(rows);
  for (const p of shown.slice(0, LIMIT)) {
    const open = () => selectPayment(p.id);
    rows.append(
      h('tr', { class: `pick ${p.id === state.selectedId ? 'selected' : ''}`, tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
        h('td', {}, badge(p.status), p.offline ? h('span', { class: 'badge tag ml' }, 'offline') : null),
        h('td', {}, fiat(p.fiat)),
        h('td', {}, coin(p.amountDue, p.asset), h('div', { class: 'muted small' }, chainName(p.asset.chain))),
        h('td', { class: `hide-sm ${isZero(p.received) ? 'muted' : ''}` }, isZero(p.received) ? '—' : coin(p.received, p.asset)),
        h('td', { class: 'hide-sm mono small' }, shortId(p.id)),
      ),
    );
  }
  const count = document.getElementById('count');
  if (count) count.textContent = shown.length > LIMIT ? `showing ${LIMIT} of ${shown.length}` : `${shown.length} shown`;
  document.getElementById('list-empty')?.classList.toggle('hidden', state.payments.length > 0);
}

function selectPayment(id) {
  state.selectedId = id;
  state.detailSig = null;
  renderRows();
  renderDetail(id);
}

async function renderDetail(id) {
  const box = document.getElementById('detail');
  if (!box) return;
  const p = state.payments.find((x) => x.id === id);
  if (!p) {
    box.replaceChildren(h('div', { class: 'empty' }, 'That payment is no longer in the list.'));
    return;
  }
  let events = [];
  try {
    events = (await api('GET', '/v1/events')).filter((e) => e.paymentId === id);
  } catch {
    /* the timeline is optional */
  }
  if (state.selectedId !== id || !document.getElementById('detail')) return; // selection moved while loading
  const sig = JSON.stringify([p.status, p.received, p.pending, p.shortfall, p.excess, p.late, events.length]);
  if (state.detailSig === `${id}:${sig}` && box.childNodes.length) return;
  state.detailSig = `${id}:${sig}`;

  const open = OPEN_STATUSES.includes(p.status);
  const parts = [];
  parts.push(h('div', { class: 'row' }, badge(p.status), h('span', { class: 'mono small' }, p.id), h('span', { class: 'grow' }), copyBtn(p.id, 'Copy ID')));

  if (open) {
    const remaining = isZero(p.shortfall) ? p.amountDue : p.shortfall;
    const remainingLabel = isZero(p.received) ? 'Send exactly' : 'Still to send';
    let qr;
    try {
      qr = drawQr(p.address);
    } catch {
      qr = null; // address too long for the built-in encoder; the text below is still there
    }
    parts.push(
      h('div', { class: 'pay-box' },
        qr,
        h('div', { class: 'stack' },
          h('div', {}, h('div', { class: 'muted small' }, remainingLabel), h('div', { class: 'big' }, coin(remaining, p.asset)), h('div', { class: 'muted small' }, `on ${chainName(p.asset.chain)}`)),
          h('div', {}, h('div', { class: 'muted small' }, 'To this address'), h('div', { class: 'mono break' }, p.address)),
          h('div', { class: 'row' }, copyBtn(p.address, 'Copy address'), copyBtn(formatUnits(remaining, p.asset.decimals, { group: false }), 'Copy amount')),
        ),
      ),
    );
  }

  const kv = [
    ['Customer pays', fiat(p.fiat)],
    ['Rate', `1 ${p.asset.symbol} = ${p.fiat.currency} ${p.effectiveRate}`],
    ['Amount due', coin(p.amountDue, p.asset)],
    ['Received', coin(p.received, p.asset), isZero(p.received)],
    ['Awaiting confirmation', coin(p.pending, p.asset), isZero(p.pending)],
    ['Shortfall', coin(p.shortfall, p.asset), isZero(p.shortfall)],
    ['Excess', coin(p.excess, p.asset), isZero(p.excess)],
    ['Arrived late', coin(p.late, p.asset), isZero(p.late)],
    ['Expires', when(p.expiresAt)],
    ['Created via', p.offline ? 'Offline POS device' : 'Server'],
  ];
  if (state.role === 'admin' && p.merchantId) kv.push(['Merchant', p.merchantId]);
  parts.push(h('dl', { class: 'kv' }, kv.map(([k, v, dim]) => [h('dt', {}, k), h('dd', { class: dim ? 'zero' : '' }, v)])));

  if (p.actions?.length) {
    parts.push(
      h('div', { class: 'stack' }, h('h3', {}, 'What you need to do'),
        p.actions.map((a) => h('div', { class: 'callout warn' }, h('strong', {}, a.type.replace(/_/g, ' ')), a.reason ? ` · ${String(a.reason).replace(/_/g, ' ')}` : '', a.amount !== undefined ? ` · ${coin(a.amount, p.asset)}` : '', a.remaining !== undefined ? ` · ${coin(a.remaining, p.asset)} remaining` : '')),
      ),
    );
  }

  parts.push(snapshotDetails(p.rateSnapshotHash));

  if (events.length) {
    parts.push(
      h('div', { class: 'stack' }, h('h3', {}, 'History'),
        h('ul', { class: 'timeline' }, events.map((e) => h('li', {}, h('strong', {}, e.type.replace('payment.', '').replace(/_/g, ' ')), ` · ${statusLabel(e.status)}`, h('div', { class: 'muted small' }, `${when(e.createdAt)} · received ${coin(e.data.received, p.asset)}`)))),
      ),
    );
  }

  if (state.health?.sandbox) parts.push(sandboxTools(p));
  box.replaceChildren(h('div', { class: 'stack' }, parts));
}

function drawQr(text, px = 6) {
  const m = qrMatrix(text, { ecc: 'M' });
  const quiet = 4;
  const n = m.size + quiet * 2;
  const c = document.createElement('canvas');
  c.width = c.height = n * px;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000000';
  m.modules.forEach((row, y) => row.forEach((dark, x) => dark && g.fillRect((x + quiet) * px, (y + quiet) * px, px, px)));
  c.className = 'qr';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'QR code of the deposit address');
  return c;
}

function snapshotDetails(hash) {
  const body = h('div');
  const det = h('details', { ontoggle: async () => {
    if (!det.open || body.childNodes.length) return;
    try {
      const s = await api('GET', `/v1/audit/rates/${hash}`);
      body.append(snapshotView(s));
    } catch (err) {
      body.append(errorBox(err));
    }
  } }, h('summary', {}, 'How this price was set'), body);
  return det;
}

function snapshotView(s) {
  return h('div', { class: 'stack mt' },
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Source', 'Price', 'As of'].map((c) => h('th', {}, c)))),
        h('tbody', {}, s.quotes.map((q) => h('tr', {}, h('td', {}, q.source), h('td', { class: 'mono' }, q.price), h('td', { class: 'small' }, when(q.asOf))))),
      ),
    ),
    s.rejected?.length ? h('div', { class: 'callout warn' }, 'Ignored: ', s.rejected.map((r) => `${r.source} (${r.reason})`).join('; ')) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Median'), h('dd', { class: 'mono' }, s.mid),
      h('dt', {}, 'Spread'), h('dd', {}, `${s.spreadBps} bps against the customer`),
      h('dt', {}, 'Charged rate'), h('dd', { class: 'mono' }, s.effectiveRate),
      h('dt', {}, 'Record hash'), h('dd', { class: 'mono small' }, shortId(s.hash, 14, 8)),
    ),
  );
}

function sandboxTools(p) {
  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await loadPayments(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const buttons = SCENARIOS.map(([scenario, label]) =>
    h('button', { class: 'btn small', type: 'button', onclick: () => run(() => api('POST', '/v1/sandbox/deposit', { paymentId: p.id, scenario }), `Simulated: ${label.toLowerCase()}`) }, label),
  );
  const admin =
    state.role === 'admin'
      ? h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => run(() => api('POST', '/v1/sandbox/mine', { blocks: 1 }), 'Mined a block') }, 'Mine a block'),
          h('button', { class: 'btn small', type: 'button', onclick: () => run(() => api('POST', '/v1/sandbox/time', { advanceMs: 10 * 60_000 }), 'Moved the clock forward 10 minutes') }, '+10 min'),
          h('button', { class: 'btn small', type: 'button', onclick: () => run(() => api('POST', '/v1/sandbox/time', { advanceMs: 30 * 60_000 }), 'Moved the clock forward 30 minutes') }, '+30 min'),
        )
      : null;
  return h('div', { class: 'stack' }, h('h3', {}, 'Sandbox: simulate the customer'), h('div', { class: 'row' }, buttons), admin,
    h('p', { class: 'hint' }, 'These act on the fake chain. They do not exist in live mode.'));
}

// ------------------------------------------------------------------ new payment

function viewNewPayment() {
  const cat = state.catalog;
  const result = h('div');
  const amount = h('input', { class: 'input', id: 'amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '4200.00', required: true });
  const currency = h('select', { class: 'input', id: 'currency' }, Object.keys(cat.currencies).map((c) => h('option', { value: c }, c)));
  const assetSel = h('select', { class: 'input', id: 'asset' },
    Object.entries(cat.assets).map(([key, a]) => {
      const available = cat.chains.includes(a.chain);
      return h('option', { value: key, disabled: !available }, `${a.symbol} · ${chainName(a.chain)}${available ? '' : ' (not configured on this server)'}`);
    }),
  );
  const first = Object.entries(cat.assets).find(([, a]) => cat.chains.includes(a.chain));
  if (first) assetSel.value = first[0];
  const note = h('input', { class: 'input', id: 'note', placeholder: 'e.g. order #1042 (optional)', maxlength: '500' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create payment');
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    clear(result);
    submit.disabled = true;
    try {
      const body = { amount: amount.value.trim(), currency: currency.value, asset: assetSel.value };
      if (note.value.trim()) body.metadata = { note: note.value.trim() };
      const p = await api('POST', '/v1/payments', body);
      toast('Payment created');
      state.selectedId = p.id;
      state.filter = 'all';
      setTab('payments');
    } catch (err) {
      result.replaceChildren(errorBox(err));
    } finally {
      submit.disabled = false;
    }
  } },
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'field' }, h('label', { for: 'amount' }, 'Amount the customer owes'), amount, h('p', { class: 'hint' }, 'In the currency on the right, e.g. 4200 or 4200.50.')),
      h('div', { class: 'field' }, h('label', { for: 'currency' }, 'Currency'), currency),
    ),
    h('div', { class: 'field' }, h('label', { for: 'asset' }, 'Customer pays in'), assetSel, h('p', { class: 'hint' }, 'The exchange rate is fixed when you create the payment and is recorded in the audit trail.')),
    h('div', { class: 'field' }, h('label', { for: 'note' }, 'Reference'), note),
    result,
    h('div', {}, submit),
  );
  view().append(h('div', { class: 'card stack narrow' }, h('h2', {}, 'New payment'), form));
  amount.focus();
}

// ------------------------------------------------------------------ rates and audit

function viewRates() {
  const cat = state.catalog;
  const symbols = [...new Set(Object.values(cat.assets).map((a) => a.symbol))];
  const out = h('div');
  const base = h('select', { class: 'input w-auto', 'aria-label': 'Asset' }, symbols.map((s) => h('option', { value: s }, s)));
  const quote = h('select', { class: 'input w-auto', 'aria-label': 'Currency' }, Object.keys(cat.currencies).map((c) => h('option', { value: c }, c)));
  const lookup = async (e) => {
    e?.preventDefault();
    out.replaceChildren(h('p', { class: 'muted' }, 'Looking up…'));
    try {
      const s = await api('GET', `/v1/rates/${base.value}-${quote.value}`);
      out.replaceChildren(h('div', { class: 'stack' }, h('div', { class: 'big' }, `1 ${s.base} = ${s.quote} ${s.effectiveRate}`), h('p', { class: 'hint' }, 'After your spread. Each lookup is recorded in the audit trail.'), snapshotView(s)));
      loadAudit(audit);
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  };
  const audit = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Checking…'));
  view().append(
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card stack' }, h('h2', {}, 'Look up a rate'),
        h('form', { class: 'row', onsubmit: lookup }, base, quote, h('button', { class: 'btn primary', type: 'submit' }, 'Look up')), out),
      h('section', { class: 'card stack' }, h('h2', {}, 'Rate audit trail'), audit),
    ),
  );
  loadAudit(audit);
}

async function loadAudit(into) {
  try {
    const { verification, snapshots } = await api('GET', '/v1/audit/rates');
    const latest = snapshots.slice(-8).reverse();
    into.replaceChildren(
      verification.ok
        ? h('div', { class: 'callout ok' }, `Hash chain intact: ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} verified. Nothing has been edited or removed.`)
        : h('div', { class: 'callout error' }, `Chain BROKEN at snapshot ${verification.index}: ${verification.reason}`),
      latest.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, ['When', 'Pair', 'Charged', 'Sources'].map((c) => h('th', {}, c)))),
            h('tbody', {}, latest.map((s) => h('tr', {}, h('td', { class: 'small' }, when(s.createdAt)), h('td', {}, `${s.base}/${s.quote}`), h('td', { class: 'mono small' }, s.effectiveRate), h('td', {}, String(s.quotes.length))))),
          ))
        : h('p', { class: 'muted' }, 'No rates have been issued yet.'),
    );
  } catch (err) {
    into.replaceChildren(errorBox(err));
  }
}

// ------------------------------------------------------------------ account (merchant)

function viewAccount() {
  const m = state.me.merchant;
  const wallets = Object.keys(m.wallets ?? {});
  view().append(
    h('div', { class: 'card stack narrow' },
      h('h2', {}, 'Your account'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Name'), h('dd', {}, m.name),
        h('dt', {}, 'Merchant ID'), h('dd', { class: 'mono' }, m.id),
        h('dt', {}, 'API key'), h('dd', { class: 'mono' }, `${m.keyPrefix}…`),
        h('dt', {}, 'Wallets'), h('dd', {}, wallets.length ? h('span', { class: 'chips' }, wallets.map((w) => h('span', { class: 'badge tag' }, w))) : h('span', { class: 'muted' }, 'None. Ask the operator to add one before taking payments.')),
        h('dt', {}, 'Spread'), h('dd', {}, m.spreadBps === undefined ? 'Server default' : `${m.spreadBps} bps`),
        h('dt', {}, 'Webhook'), h('dd', {}, m.webhookUrl ?? h('span', { class: 'muted' }, 'Not set')),
      ),
      h('p', { class: 'hint' }, 'Wallet keys, spread and webhook are set by the operator. Payments are settled straight to your own wallet.'),
    ),
  );
}

// ------------------------------------------------------------------ admin

function viewAdmin() {
  const sections = [['status', 'Status'], ['merchants', 'Merchants'], ['audit', 'Audit log']];
  const body = h('div', { id: 'admin-body' });
  const nav = h('div', { class: 'row' }, sections.map(([id, label]) => h('button', { class: `btn ${state.adminTab === id ? 'primary' : ''}`, type: 'button', onclick: () => { state.adminTab = id; renderTab(); } }, label)));
  view().append(h('div', { class: 'stack' }, nav, body));
  if (state.adminTab === 'merchants') adminMerchants(body);
  else if (state.adminTab === 'audit') adminAudit(body);
  else adminStatus(body);
}

async function adminStatus(into) {
  into.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const s = await api('GET', '/v1/status');
    const byStatus = Object.entries(s.payments.byStatus);
    into.replaceChildren(
      h('div', { class: 'grid cols-2' },
        h('section', { class: 'card stack' }, h('h2', {}, 'Server'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Mode'), h('dd', {}, s.mode),
            h('dt', {}, 'Chains'), h('dd', {}, s.chains.map(chainName).join(', ')),
            h('dt', {}, 'Rate sources'), h('dd', {}, s.rateSources.join(', ')),
            h('dt', {}, 'Poll every'), h('dd', {}, `${s.pollIntervalMs / 1000}s`),
            h('dt', {}, 'Last poll'), h('dd', {}, s.lastPoll ? `${Math.round(s.lastPoll.agoMs / 1000)}s ago, took ${s.lastPoll.tookMs}ms` : h('span', { class: 'muted' }, 'not yet')),
          ),
        ),
        h('section', { class: 'card stack' }, h('h2', {}, `Payments (${s.payments.total})`),
          byStatus.length ? h('div', { class: 'chips' }, byStatus.map(([st, n]) => h('span', { class: `badge ${st}` }, `${statusLabel(st)} · ${n}`))) : h('p', { class: 'muted' }, 'None yet.'),
        ),
      ),
      s.chainErrors.length
        ? h('section', { class: 'card stack' }, h('h2', {}, 'Chain lookups failing right now'),
            h('div', { class: 'callout error' }, 'These payments cannot be checked until the chain API answers again. They are retried every poll.'),
            h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
              h('thead', {}, h('tr', {}, ['Payment', 'Chain', 'Error', 'Since'].map((c) => h('th', {}, c)))),
              h('tbody', {}, s.chainErrors.map((e) => h('tr', {}, h('td', { class: 'mono small' }, shortId(e.paymentId)), h('td', {}, chainName(e.chain)), h('td', {}, e.message), h('td', { class: 'small' }, when(e.at))))),
            )),
          )
        : h('div', { class: 'callout ok' }, 'No chain lookups are failing.'),
    );
  } catch (err) {
    into.replaceChildren(errorBox(err));
  }
}

async function adminMerchants(into) {
  const secrets = h('div');
  const field = (id, label, placeholder, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { class: 'input', id, placeholder, autocomplete: 'off', spellcheck: 'false' }), hint ? h('p', { class: 'hint' }, hint) : null);
  const val = (id) => document.getElementById(id).value.trim();
  const listBox = h('div');
  const showSecret = (node) => secrets.replaceChildren(node);
  const create = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    clear(secrets);
    const body = { name: val('m-name') };
    const wallets = {};
    if (val('m-evm')) wallets.evm = val('m-evm');
    if (val('m-tron')) wallets.tron = val('m-tron');
    if (val('m-btc')) wallets.bitcoin = val('m-btc');
    if (Object.keys(wallets).length) body.wallets = wallets;
    if (val('m-hook')) body.webhookUrl = val('m-hook');
    if (val('m-spread')) body.spreadBps = Number(val('m-spread'));
    try {
      const r = await api('POST', '/v1/admin/merchants', body);
      secrets.replaceChildren(revealOnce('Merchant created. Copy these now: they are shown once and cannot be recovered.', [['API key', r.apiKey], r.webhookSecret ? ['Webhook secret', r.webhookSecret] : null]));
      e.target.reset();
      loadMerchantList(listBox, showSecret);
    } catch (err) {
      secrets.replaceChildren(errorBox(err));
    }
  } },
    h('h2', {}, 'Add a merchant'),
    h('div', { class: 'grid cols-2' },
      field('m-name', 'Name', 'Ada Stores'),
      field('m-spread', 'Spread (bps, optional)', '100', '100 bps = 1% margin against the customer.'),
      field('m-evm', 'EVM wallet (xpub)', 'xpub…', 'Ethereum, BNB Chain, Base.'),
      field('m-tron', 'Tron wallet (xpub)', 'xpub…'),
      field('m-btc', 'Bitcoin wallet (zpub)', 'zpub…'),
      field('m-hook', 'Webhook URL (optional)', 'https://example.com/hook'),
    ),
    h('p', { class: 'hint' }, 'Wallet keys must be extended public keys. A private key is refused. Customers pay straight into the merchant’s wallet.'),
    h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Create merchant')),
  );
  into.replaceChildren(h('div', { class: 'stack' }, h('section', { class: 'card stack' }, create, secrets), h('section', { class: 'card stack' }, h('h2', {}, 'Merchants'), listBox)));
  loadMerchantList(listBox, showSecret);
}

function revealOnce(message, pairs) {
  return h('div', { class: 'stack' }, h('div', { class: 'callout warn' }, message),
    pairs.filter(Boolean).map(([label, value]) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row' }, h('div', { class: 'secret grow' }, value), copyBtn(value)))));
}

async function loadMerchantList(into, showSecret) {
  try {
    const list = await api('GET', '/v1/admin/merchants');
    if (!list.length) return into.replaceChildren(h('p', { class: 'muted' }, 'No merchants yet.'));
    into.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Name', 'Key', 'Wallets', 'Webhook', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, list.map((m) => h('tr', {},
          h('td', {}, m.name, m.disabled ? h('span', { class: 'badge disabled ml' }, 'disabled') : null, h('div', { class: 'mono small muted' }, m.id)),
          h('td', { class: 'mono small' }, `${m.keyPrefix}…`),
          h('td', {}, Object.keys(m.wallets ?? {}).length ? h('span', { class: 'chips' }, Object.keys(m.wallets).map((w) => h('span', { class: 'badge tag' }, w))) : h('span', { class: 'muted' }, 'none')),
          h('td', { class: 'small' }, m.webhookUrl ?? '—'),
          h('td', { class: 'right' }, h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', onclick: async () => {
              try { await api('POST', `/v1/admin/merchants/${m.id}/${m.disabled ? 'enable' : 'disable'}`); loadMerchantList(into, showSecret); } catch (err) { toast(err.message, 'error'); }
            } }, m.disabled ? 'Enable' : 'Disable'),
            h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
              if (!confirm(`Rotate ${m.name}'s API key? The current key stops working immediately.`)) return;
              try {
                const r = await api('POST', `/v1/admin/merchants/${m.id}/rotate-key`);
                showSecret(revealOnce(`New API key for ${m.name}. Shown once.`, [['API key', r.apiKey]]));
              } catch (err) { toast(err.message, 'error'); }
            } }, 'Rotate key'),
          )),
        ))),
      )),
    );
  } catch (err) {
    into.replaceChildren(errorBox(err));
  }
}

async function adminAudit(into) {
  into.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const entries = await api('GET', '/v1/admin/audit?limit=200');
    into.replaceChildren(
      h('section', { class: 'card stack' }, h('h2', {}, 'Admin audit log'),
        entries.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
              h('thead', {}, h('tr', {}, ['When', 'Action', 'Merchant', 'Detail'].map((c) => h('th', {}, c)))),
              h('tbody', {}, entries.map((e) => h('tr', {}, h('td', { class: 'small' }, when(e.at)), h('td', {}, e.action), h('td', { class: 'mono small' }, shortId(e.merchantId)), h('td', { class: 'mono small' }, e.detail ? JSON.stringify(e.detail) : '—')))),
            ))
          : h('p', { class: 'muted' }, 'No admin actions recorded yet.'),
        h('p', { class: 'hint' }, 'Secrets are never recorded: wallet changes show which chain family was set or removed, not the key.'),
      ),
    );
  } catch (err) {
    into.replaceChildren(errorBox(err));
  }
}

boot();
