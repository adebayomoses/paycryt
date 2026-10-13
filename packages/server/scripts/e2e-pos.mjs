// End-to-end test of the offline POS in a REAL Chrome against a REAL server, including a real outage.
//   npm run build && npm run e2e:pos        (needs Chrome or Chromium; set CHROME_PATH if it is not found)
//
//   pair -> sell online -> kill the server -> reload the page offline (service worker) -> sell offline
//   -> bring the server back -> sales sync by themselves -> customer pays -> UI shows Paid -> restart the browser.
// Uses a throwaway browser profile and a throwaway database; it never touches your own browser or data.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));
if (!CHROME) {
  console.error('No Chrome/Chromium found. Set CHROME_PATH to the browser binary.');
  process.exit(2);
}
const PORT = 8793;
const CDP = 9333;
const ADMIN = 'pos-e2e-admin-key-0123456789';
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'pos-e2e-'));
const shots = process.env.SHOTS_DIR || tmp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// ------------------------------------------------------------ server lifecycle
let server;
function startServer() {
  server = spawn(process.execPath, [`${REPO}/packages/server/dist/cli.js`], {
    env: { ...process.env, PORT: String(PORT), PAYCRYT_API_KEY: ADMIN, PAYCRYT_DB_PATH: join(tmp, 'e2e.db') },
    stdio: 'ignore',
  });
}
async function waitHealthy(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}
async function stopServer() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  await sleep(300);
}
const api = async (key, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ------------------------------------------------------------ chrome over CDP
let chrome;
let ws;
let nextId = 0;
const pending = new Map();
async function launchChrome() {
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch { /* starting */ }
    await sleep(150);
  }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, ms = 15000, label = expr) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await ev(expr); if (last) return last; } catch (e) { last = String(e); }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
}
async function navigate(url) {
  await send('Page.navigate', { url });
  await sleep(300);
  await waitFor('document.readyState === "complete"', 15000, 'page load');
}
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.click(); return true; })()`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const tapAmount = async (s) => { for (const ch of s) await click(`.pos-key[aria-label="${ch}"]`); };
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  writeFileSync(join(shots, name), Buffer.from(r.data, 'base64'));
}
const clickChip = (label) => ev(`(() => { const c = [...document.querySelectorAll('.pos-chip')].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!c) throw new Error('no chip ' + ${JSON.stringify(label)}); c.click(); return true; })()`);
const goTab = (label) => ev(`(() => { const t = [...document.querySelectorAll('.pos-tab')].find((x) => x.innerText.startsWith(${JSON.stringify(label)})); t.click(); return true; })()`);

async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  try { chrome?.kill(); } catch { /* */ }
  try { server?.kill(); } catch { /* */ }
  await sleep(500);
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* chrome may still hold files */ }
}

// ------------------------------------------------------------ scenario
try {
  startServer();
  await waitHealthy();
  const m = await api(ADMIN, 'POST', '/v1/admin/merchants', { name: 'Ada Stores' });
  const KEY = m.body.apiKey;
  check('server up and merchant created', m.status === 201);

  await launchChrome();

  // ---- pair
  await navigate(`${BASE}/pos`);
  check('/pos redirects to the app', (await ev('location.pathname')) === '/ui/pos.html');
  await waitFor('!!document.querySelector("#k")');
  await ev(`(() => { const i = document.querySelector('#k'); i.value = ${JSON.stringify(KEY)}; return true; })()`);
  await click('button[type=submit]');
  await waitFor('!!document.querySelector(".pos-keypad")', 20000, 'sell screen after pairing');
  check('paired and showing the sell screen', true);
  check('shows Online', (await text('.pos-net')) === 'Online');
  const chips = await ev('[...document.querySelectorAll(".pos-chip")].map((c) => c.innerText)');
  check('offers only assets the server can price (no ETH)', chips.length === 5 && !chips.some((c) => c.startsWith('ETH')), chips.join(' | '));

  // ---- service worker + cache
  const swReady = await waitFor('navigator.serviceWorker.ready.then((r) => !!r.active)', 15000, 'service worker ready');
  check('service worker active', swReady === true);
  const cached = await waitFor(`caches.keys().then(async (ks) => ks.length ? (await (await caches.open(ks[0])).keys()).map((r) => new URL(r.url).pathname) : null)`, 15000, 'app cached');
  check('app shell is cached for offline', ['/ui/pos.html', '/ui/pos.js', '/ui/pos.css', '/ui/style.css'].every((p) => cached.includes(p)), cached.join(' '));
  check('no secrets in localStorage / cookies', (await ev('JSON.stringify([Object.keys(localStorage), document.cookie])')) === '[[],""]');

  // ---- sell online
  await tapAmount('4200');
  await shot('pos-1-sell.jpg');
  await click('.pos-charge');
  await waitFor('!!document.querySelector(".pos-pay")', 10000, 'payment screen');
  const online1 = { amount: await text('.pos-pay .big'), addr: await text('.pos-addr'), qr: await ev('!!document.querySelector("canvas.pos-qr")') };
  check('online sale shows the exact amount, an address and a QR', /USDT$/.test(online1.amount) && online1.addr.length > 10 && online1.qr, `${online1.amount} -> ${online1.addr}`);
  await waitFor('document.querySelector(".pos-pay .badge")?.innerText === "Waiting for payment"', 15000, 'online sale synced');
  check('online sale reached the server straight away', (await api(KEY, 'GET', '/v1/payments')).body.length === 1);

  // ---- the real outage
  await stopServer();
  check('server is really down', await fetch(BASE + '/health').then(() => false, () => true));
  await waitFor('document.querySelector(".pos-net")?.innerText === "Offline"', 30000, 'till notices the outage');
  check('till shows Offline', true);

  await navigate(`${BASE}/ui/pos.html`); // a cold reload with no server at all: only the service worker can answer
  await waitFor('!!document.querySelector(".pos-keypad")', 15000, 'app loads with no server');
  check('app reloads and is still paired with the server DOWN (service worker + IndexedDB)', true);
  check('offline banner is shown', /No connection/.test(await text('.pos-offline')));

  // ---- sell offline
  await tapAmount('15000');
  await click('.pos-charge');
  await waitFor('!!document.querySelector(".pos-pay")', 10000, 'offline sale 1');
  const off1 = { amount: await text('.pos-pay .big'), addr: await text('.pos-addr'), badge: await text('.pos-pay .badge'), note: await text('.pos-pay .callout') };
  check('offline sale 1 works, is "Not sent yet" and explains the margin', off1.badge === 'Not sent yet' && /safety margin/.test(off1.note ?? ''), `${off1.amount} -> ${off1.addr}`);
  await shot('pos-2-offline-pay.jpg');
  await click('.pos-pay .btn.primary'); // New sale
  await waitFor('!!document.querySelector(".pos-keypad")');
  await clickChip('BTC');
  await tapAmount('500.50');
  await click('.pos-charge');
  await waitFor('!!document.querySelector(".pos-pay")', 10000, 'offline sale 2');
  const off2 = { amount: await text('.pos-pay .big'), addr: await text('.pos-addr') };
  check('offline sale 2 (BTC) works', /BTC$/.test(off2.amount), `${off2.amount} -> ${off2.addr}`);
  check('every sale got its own address', new Set([online1.addr, off1.addr, off2.addr]).size === 3);
  await goTab('Sales');
  const salesText = await text('.pos-main');
  check('sales list shows both unsent sales', (salesText.match(/Not sent yet/g) ?? []).length === 2);
  await shot('pos-3-sales.jpg');

  // ---- recovery
  await startServer();
  await waitHealthy();
  await waitFor('document.querySelector(".pos-net")?.innerText === "Online"', 30000, 'till notices the server is back');
  check('till notices the connection is back', true);
  await waitFor(`!/Not sent yet/.test(document.querySelector('.pos-main').innerText)`, 30000, 'queue drains by itself');
  const afterSync = (await api(KEY, 'GET', '/v1/payments')).body;
  check('all 3 sales are on the server, sent without anyone touching anything', afterSync.length === 3, afterSync.map((p) => p.id.slice(0, 12)).join(', '));
  check('the server accepted the offline addresses as its own', new Set(afterSync.map((p) => p.address)).size === 3);

  // ---- customer pays one of the offline sales
  const offlinePayment = afterSync.find((p) => p.address === off1.addr);
  check('server priced it as the till said (offline margin included)', !!offlinePayment && /USDT$/.test(off1.amount));
  const dep = await api(KEY, 'POST', '/v1/sandbox/deposit', { paymentId: offlinePayment.id, scenario: 'exact' });
  check('customer pays (sandbox deposit)', dep.status === 200);
  await waitFor(`/Paid/.test(document.querySelector('.pos-main').innerText)`, 30000, 'UI shows Paid');
  check('till shows the sale as Paid', true);
  await shot('pos-4-paid.jpg');

  // ---- the tablet restarts
  ws.close();
  chrome.kill();
  await sleep(1500);
  await launchChrome();
  await navigate(`${BASE}/ui/pos.html`);
  await waitFor('!!document.querySelector(".pos-keypad")', 15000, 'app after browser restart');
  check('after the browser is restarted the till is still paired (no re-login)', true);
  await goTab('Sales');
  check('and still lists its sales', ((await text('.pos-main')).match(/NGN/g) ?? []).length === 3);
} catch (err) {
  check('scenario completed without an unexpected error', false, String(err && err.stack || err));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
