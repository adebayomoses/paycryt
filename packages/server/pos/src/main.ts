/**
 * The till. A phone-sized, touch-first app that keeps selling when the network does not work.
 *
 * All the logic that matters (offline pricing, the queue, leases, syncing) lives in device.ts and @paycryt/core and is
 * tested against a real server. This file is only screens.
 */
import { IndexedDbStore } from '@paycryt/adapters';
import { ASSETS, CURRENCIES, type Asset } from '@paycryt/core';
import { qrMatrix } from '../../ui/qr.js';
import { formatUnits } from '../../ui/util.js';
import { copyText, h, toast, type Child } from './dom.js';
import { ApiError, NetworkError, PosDevice, type DeviceStatus, type Sale } from './device.js';

type Screen = 'sell' | 'sales' | 'settings' | 'pay';

const ui = {
  screen: 'sell' as Screen,
  amount: '',
  assetKey: undefined as string | undefined,
  busy: false,
  error: '' as string,
  viewing: undefined as string | undefined,
  sales: [] as Sale[],
  status: undefined as DeviceStatus | undefined,
};

const root = document.getElementById('pos')!;
let device: PosDevice;
let lastRates = 0;

const ASSET_TABLE = ASSETS as Record<string, Asset>;
const CHAIN_NAMES: Record<string, string> = { tron: 'Tron', ethereum: 'Ethereum', bsc: 'BNB Chain', base: 'Base', bitcoin: 'Bitcoin' };
const FINAL = ['paid', 'overpaid', 'expired', 'refund_required', 'manual_review'];

// ------------------------------------------------------------------ formatting

const decimalsOf = (cur: string) => CURRENCIES[cur as keyof typeof CURRENCIES]?.decimals ?? 2;
const fiatText = (cur: string, minor: bigint) => `${cur} ${formatUnits(minor.toString(), decimalsOf(cur), { minFraction: decimalsOf(cur) })}`;
const coinText = (units: bigint, a: Asset) => `${formatUnits(units.toString(), a.decimals)} ${a.symbol}`;
const assetLabel = (key: string) => {
  const a = ASSET_TABLE[key]!;
  return `${a.symbol} · ${CHAIN_NAMES[a.chain] ?? a.chain}`;
};
const timeText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (ms: number) => (ms < 90_000 ? 'just now' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)} h ago`);

/** What the cashier should read for a sale, in plain words, and how loudly. */
function describe(s: Sale): { label: string; kind: string } {
  if (s.status === 'rejected') return { label: 'Refused by server', kind: 'refund_required' };
  if (s.status === 'queued') return { label: 'Not sent yet', kind: 'confirming' };
  switch (s.serverStatus) {
    case 'paid': return { label: 'Paid', kind: 'paid' };
    case 'overpaid': return { label: 'Paid (extra received)', kind: 'paid' };
    case 'confirming': return { label: 'Payment seen, confirming', kind: 'confirming' };
    case 'partially_paid': return { label: 'Part paid', kind: 'partially_paid' };
    case 'expired': return { label: 'Expired', kind: 'expired' };
    case 'refund_required': return { label: 'Refund needed', kind: 'refund_required' };
    case 'manual_review': return { label: 'Needs review', kind: 'manual_review' };
    default: return { label: 'Waiting for payment', kind: 'awaiting_payment' };
  }
}

// ------------------------------------------------------------------ QR

function qrCanvas(text: string, px = 6): HTMLCanvasElement | null {
  let m;
  try {
    m = qrMatrix(text, { ecc: 'M' });
  } catch {
    return null; // too long for the built-in encoder; the address text is still shown
  }
  const quiet = 4;
  const n = m.size + quiet * 2;
  const c = document.createElement('canvas');
  c.width = c.height = n * px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000000';
  m.modules.forEach((row: boolean[], y: number) => row.forEach((dark, x) => dark && g.fillRect((x + quiet) * px, (y + quiet) * px, px, px)));
  c.className = 'qr pos-qr';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'QR code of the deposit address');
  return c;
}

// ------------------------------------------------------------------ screens

function pairScreen(): HTMLElement {
  const key = h('input', { class: 'input', id: 'k', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'pk_…' });
  const cur = h('select', { class: 'input', id: 'c' }, Object.keys(CURRENCIES).map((c) => h('option', { value: c }, c)));
  const name = h('input', { class: 'input', id: 'n', placeholder: 'Front counter', maxlength: '30' });
  const err = h('div', { class: `callout error ${ui.error ? '' : 'hidden'}`, role: 'alert' }, ui.error);
  const go = h('button', { class: 'btn primary pos-wide', type: 'submit' }, 'Connect this till');
  return h('div', { class: 'pos-center' },
    h('form', { class: 'card stack pos-card', onsubmit: async (e: Event) => {
      e.preventDefault();
      go.disabled = true;
      go.textContent = 'Connecting…';
      err.classList.add('hidden');
      try {
        await device.pair({ apiKey: key.value, currency: cur.value, deviceName: name.value });
        lastRates = Date.now();
        ui.error = '';
        await reload();
        toast('Till connected');
      } catch (ex) {
        err.textContent = ex instanceof NetworkError ? 'Cannot reach the server. Check the connection and try again. A till has to connect once to get set up.' : (ex as Error).message;
        err.classList.remove('hidden');
      } finally {
        go.disabled = false;
        go.textContent = 'Connect this till';
      }
    } },
      h('div', {}, h('h1', {}, 'Paycryt POS'), h('p', { class: 'muted' }, 'Connect this device once. After that it keeps selling even with no internet.')),
      h('div', { class: 'field' }, h('label', { for: 'k' }, 'Merchant API key'), key, h('p', { class: 'hint' }, 'Stored on this device so it can send sales later. Use “Forget this device” in Settings to remove it.')),
      h('div', { class: 'field' }, h('label', { for: 'c' }, 'Shop currency'), cur),
      h('div', { class: 'field' }, h('label', { for: 'n' }, 'Name this till (optional)'), name),
      err, go,
    ),
  );
}

function keypad(): HTMLElement {
  const dec = decimalsOf(device.deviceConfig!.currency);
  const press = (k: string) => {
    ui.error = '';
    if (k === 'back') ui.amount = ui.amount.slice(0, -1);
    else if (k === 'clear') ui.amount = '';
    else if (k === '.') {
      if (dec > 0 && !ui.amount.includes('.')) ui.amount = (ui.amount || '0') + '.';
    } else {
      const [whole = '', frac] = ui.amount.split('.');
      if (frac !== undefined && frac.length >= dec) return;
      if (frac === undefined && whole.length >= 10) return;
      ui.amount = whole === '0' && frac === undefined ? k : ui.amount + k;
    }
    render();
  };
  const key = (k: string, label: string = k) => h('button', { class: 'pos-key', type: 'button', 'aria-label': k === 'back' ? 'Delete' : label, onclick: () => press(k) }, label);
  return h('div', { class: 'pos-keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d)), key('.', dec > 0 ? '.' : ''), key('0'), key('back', '⌫'));
}

function sellScreen(): HTMLElement {
  const cfg = device.deviceConfig!;
  const sellable = device.sellableKeys();
  if (!ui.assetKey || !sellable.includes(ui.assetKey)) ui.assetKey = sellable[0];
  const valid = !!ui.assetKey && /^\d+(\.\d+)?$/.test(ui.amount) && Number(ui.amount) > 0;
  const rejected = ui.sales.filter((s) => s.status === 'rejected').length;
  const refused = rejected
    ? h('button', { class: 'callout error pos-banner', type: 'button', onclick: () => go('sales') }, `${rejected} sale${rejected === 1 ? ' was' : 's were'} refused by the server. A customer may have paid. Tap to review.`)
    : null;
  return h('div', { class: 'pos-sell' },
    refused,
    h('div', { class: 'pos-amount', 'aria-live': 'polite' },
      h('span', { class: 'pos-cur' }, cfg.currency),
      h('span', { class: ui.amount ? '' : 'muted' }, ui.amount ? groupInput(ui.amount) : '0'),
    ),
    sellable.length
      ? h('div', { class: 'pos-chips', role: 'radiogroup', 'aria-label': 'Customer pays in' },
          sellable.map((k) => h('button', { class: `pos-chip ${k === ui.assetKey ? 'on' : ''}`, type: 'button', role: 'radio', 'aria-checked': k === ui.assetKey ? 'true' : 'false', onclick: () => { ui.assetKey = k; render(); } }, assetLabel(k))))
      : h('div', { class: 'callout warn' }, device.candidateKeys().length
          ? 'No exchange rate is saved yet. Connect to the internet once so this till can price sales.'
          : 'Nothing can be sold yet: this merchant has no wallet set up for a chain the server accepts. Ask the operator.'),
    ui.error ? h('div', { class: 'callout error', role: 'alert' }, ui.error) : null,
    keypad(),
    h('button', { class: 'btn primary pos-charge', type: 'button', disabled: !valid || ui.busy, onclick: charge }, ui.busy ? 'Working…' : valid ? `Charge ${cfg.currency} ${groupInput(ui.amount)}` : 'Enter an amount'),
  );
}

const groupInput = (s: string) => {
  const [w = '', f] = s.split('.');
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f !== undefined ? '.' + f : '');
};

async function charge(): Promise<void> {
  if (ui.busy || !ui.assetKey) return;
  ui.busy = true;
  ui.error = '';
  render();
  try {
    const sale = await device.sell({ amount: ui.amount, assetKey: ui.assetKey });
    ui.amount = '';
    ui.viewing = sale.id;
    ui.screen = 'pay';
    await reload();
    if (device.online) void device.sync().catch(() => undefined).then(reload); // get it in front of the server's watcher now
  } catch (ex) {
    ui.error = (ex as Error).message;
  } finally {
    ui.busy = false;
    render();
  }
}

function payScreen(): HTMLElement {
  const s = ui.sales.find((x) => x.id === ui.viewing);
  if (!s) return h('div', { class: 'empty' }, 'That sale is no longer here.', h('div', {}, h('button', { class: 'btn', type: 'button', onclick: () => go('sell') }, 'Back')));
  const d = describe(s);
  const open = s.status !== 'rejected' && !FINAL.includes(s.serverStatus ?? '');
  const qr = open ? qrCanvas(s.address) : null;
  return h('div', { class: 'pos-pay stack' },
    h('div', { class: 'row' }, h('span', { class: `badge ${d.kind}` }, d.label), h('span', { class: 'grow' }), h('span', { class: 'muted small' }, timeText(s.createdAt))),
    h('div', { class: 'pos-due' }, h('div', { class: 'muted small' }, open ? 'Customer sends exactly' : 'Amount'), h('div', { class: 'big' }, coinText(s.amountDue, s.asset)), h('div', { class: 'muted' }, `${fiatText(s.fiat.currency, s.fiat.amountMinor)} · on ${CHAIN_NAMES[s.asset.chain] ?? s.asset.chain}`)),
    qr ? h('div', { class: 'pos-qrbox' }, qr) : null,
    open ? h('div', { class: 'stack' }, h('div', { class: 'mono break pos-addr' }, s.address), h('div', { class: 'row' }, copyBtn(s.address, 'Copy address'), copyBtn(formatUnits(s.amountDue.toString(), s.asset.decimals, { group: false }), 'Copy amount'))) : null,
    s.status === 'queued'
      ? h('div', { class: 'callout warn' }, s.pricedOffline
          ? 'Priced offline, so the amount includes a small safety margin. It will be sent to the server automatically when the connection is back. The customer can pay now.'
          : 'Not sent to the server yet. It will go automatically.')
      : null,
    s.status === 'rejected' ? h('div', { class: 'callout error' }, `The server refused this sale: ${s.reason ?? 'no reason given'}. If the customer already paid, tell the operator.`) : null,
    s.received !== undefined && s.received > 0n && s.serverStatus !== 'paid' ? h('div', { class: 'callout info' }, `Received so far: ${coinText(s.received, s.asset)}`) : null,
    s.note ? h('div', { class: 'muted small' }, `Note: ${s.note}`) : null,
    h('button', { class: 'btn primary pos-wide', type: 'button', onclick: () => { ui.viewing = undefined; go('sell'); } }, 'New sale'),
  );
}

const copyBtn = (text: string, label: string) => h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => void copyText(text, e.currentTarget as HTMLElement) }, label);

function salesScreen(): HTMLElement {
  if (!ui.sales.length) return h('div', { class: 'empty' }, 'No sales on this till yet.');
  return h('div', { class: 'stack' }, ui.sales.slice(0, 100).map((s) => {
    const d = describe(s);
    return h('button', { class: 'pos-sale', type: 'button', onclick: () => { ui.viewing = s.id; go('pay'); } },
      h('div', { class: 'row' }, h('strong', {}, fiatText(s.fiat.currency, s.fiat.amountMinor)), h('span', { class: 'grow' }), h('span', { class: `badge ${d.kind}` }, d.label)),
      h('div', { class: 'muted small' }, `${coinText(s.amountDue, s.asset)} · ${timeText(s.createdAt)}${s.note ? ' · ' + s.note : ''}`),
      s.status === 'rejected' ? h('div', { class: 'small pos-reason' }, s.reason ?? '') : null,
    );
  }));
}

function settingsScreen(): HTMLElement {
  const cfg = device.deviceConfig!;
  const st = ui.status;
  const row = (k: string, v: Child) => [h('dt', {}, k), h('dd', {}, v)];
  const offline = h('input', { type: 'checkbox', id: 'fo', checked: cfg.forceOffline ? true : null, onchange: async (e: Event) => {
    await device.setForceOffline((e.target as HTMLInputElement).checked);
    await reload();
  } });
  return h('div', { class: 'stack' },
    h('section', { class: 'card stack' },
      h('h2', {}, 'This till'),
      h('dl', { class: 'kv' },
        row('Shop', cfg.merchant.name),
        row('Till', h('span', { class: 'mono' }, cfg.deviceId)),
        row('Sells in', cfg.currency),
        row('Connection', st?.online ? 'Online' : cfg.forceOffline ? 'Offline mode (switched on)' : 'Offline'),
        row('Waiting to send', String(st?.queued ?? 0)),
        row('Addresses left', st ? String(st.leaseRemaining) : '…'),
        row('Last sent', st?.lastSyncAt ? timeText(st.lastSyncAt) : '—'),
        st?.lastError ? row('Problem', st.lastError) : [],
      ),
    ),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Saved exchange rates'),
      st?.rates.length
        ? h('dl', { class: 'kv' }, st.rates.map((r) => row(r.pair, ago(r.ageMs))))
        : h('p', { class: 'muted' }, 'None saved yet.'),
      h('p', { class: 'hint' }, 'Rates are signed with a hash by the server. While offline the till sells at the saved rate plus a safety margin, and refuses to sell on one older than 6 hours.'),
    ),
    h('section', { class: 'card stack' },
      h('label', { class: 'row pos-switch', for: 'fo' }, offline, h('span', {}, h('strong', {}, 'Work offline'), h('div', { class: 'hint' }, 'Sell without using the connection even if there is one (for example to save data). Sales are sent when you switch this off.'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: manualSync }, 'Send sales now'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { await device.refresh(); lastRates = Date.now(); toast('Rates updated'); } catch (ex) { toast(friendly(ex), 'error'); }
          await reload();
        } }, 'Refresh rates'),
      ),
    ),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Remove from this device'),
      h('button', { class: 'btn danger', type: 'button', onclick: forget }, 'Forget this device'),
      h('p', { class: 'hint' }, 'Deletes the API key and every saved sale from this device. Refuses while sales have not reached the server.'),
    ),
  );
}

async function manualSync(): Promise<void> {
  try {
    const r = await device.sync();
    toast(!r.attempted ? 'No connection. Sales are kept safe on this till.' : r.remaining ? `Sent ${r.accepted + r.duplicates}. ${r.remaining} still waiting.` : r.accepted + r.duplicates ? `Sent ${r.accepted + r.duplicates} sale(s)` : 'Everything is already sent');
  } catch (ex) {
    toast(friendly(ex), 'error');
  }
  await reload();
}

async function forget(): Promise<void> {
  if (!confirm('Remove this till’s API key and all saved sales from this device?')) return;
  try {
    await device.forget();
  } catch (ex) {
    if (!confirm(`${(ex as Error).message}\n\nDiscard them anyway? They will be lost.`)) return;
    await device.forget({ discardUnsynced: true });
  }
  ui.screen = 'sell';
  ui.sales = [];
  await reload();
}

const friendly = (ex: unknown) => (ex instanceof NetworkError ? 'No connection right now.' : ex instanceof ApiError || ex instanceof Error ? ex.message : String(ex));

// ------------------------------------------------------------------ frame

function go(screen: Screen): void {
  ui.screen = screen;
  ui.error = '';
  render();
}

function frame(content: HTMLElement): HTMLElement {
  const cfg = device.deviceConfig!;
  const st = ui.status;
  const online = !!st?.online;
  const queued = st?.queued ?? 0;
  const tab = (s: Screen, label: string, badge?: number) =>
    h('button', { class: `pos-tab ${ui.screen === s || (s === 'sales' && ui.screen === 'pay') ? 'on' : ''}`, type: 'button', onclick: () => go(s) }, label, badge ? h('span', { class: 'pos-count' }, String(badge)) : null);
  return h('div', { class: 'pos-frame' },
    h('header', { class: 'pos-top' },
      h('span', { class: 'brand' }, 'Paycryt'),
      h('span', { class: 'muted small pos-shop' }, cfg.merchant.name),
      h('span', { class: 'grow' }),
      cfg.sandbox ? h('span', { class: 'pill sandbox' }, 'SANDBOX') : null,
      h('span', { class: `pos-net ${online ? 'on' : 'off'}`, role: 'status' }, online ? 'Online' : 'Offline'),
    ),
    !online
      ? h('div', { class: 'pos-offline' }, cfg.forceOffline ? 'Offline mode is on. Sales are saved on this till and sent when you switch it off.' : 'No connection. You can keep selling. Sales are saved on this till and sent when the connection is back.')
      : queued > 0 ? h('div', { class: 'pos-sending' }, `Sending ${queued} sale${queued === 1 ? '' : 's'}…`) : null,
    h('main', { class: 'pos-main' }, content),
    h('nav', { class: 'pos-tabs' }, tab('sell', 'Sell'), tab('sales', 'Sales', queued), tab('settings', 'Settings')),
  );
}

function render(): void {
  root.replaceChildren(device.paired ? frame(ui.screen === 'sell' ? sellScreen() : ui.screen === 'pay' ? payScreen() : ui.screen === 'sales' ? salesScreen() : settingsScreen()) : pairScreen());
  document.title = device.paired ? `Paycryt POS${device.online ? '' : ' (offline)'}` : 'Paycryt POS';
}

async function reload(): Promise<void> {
  if (device.paired) {
    ui.sales = await device.sales();
    ui.status = await device.status();
  }
  render();
}

// ------------------------------------------------------------------ background work

async function cycle(): Promise<void> {
  if (!device.paired) return;
  await device.probe();
  if (device.online) {
    const queued = (await device.status()).queued;
    const waiting = (await device.sales()).some((s) => s.status === 'synced' && !FINAL.includes(s.serverStatus ?? ''));
    if (queued > 0 || waiting) await device.sync().catch(() => undefined);
    if (Date.now() - lastRates > 5 * 60_000) {
      lastRates = Date.now();
      await device.refresh().catch(() => undefined);
    }
  }
  await reload();
}

async function start(): Promise<void> {
  device = await PosDevice.open({ store: new IndexedDbStore({ dbName: 'paycryt-pos' }) });
  await reload();
  if (device.paired) {
    await device.probe();
    await reload();
    void cycle();
  }
  setInterval(() => void cycle(), 8_000);
  window.addEventListener('online', () => void cycle());
  window.addEventListener('offline', () => void cycle());
  document.addEventListener('keydown', (e) => {
    if (ui.screen !== 'sell' || !device.paired || (e.target as HTMLElement)?.closest('input,select,textarea')) return;
    if (/^[0-9.]$/.test(e.key) || e.key === 'Backspace') (document.querySelector(`.pos-key[aria-label="${e.key === 'Backspace' ? 'Delete' : e.key}"]`) as HTMLElement | null)?.click();
    else if (e.key === 'Enter') (document.querySelector('.pos-charge') as HTMLButtonElement | null)?.click();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/ui/pos-sw.js', { scope: '/ui/' }).catch(() => undefined); // app still works without it, just not offline-reload
  }
}

void start();
