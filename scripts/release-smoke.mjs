// Installs the three PACKED packages into a clean, empty project the way a user would, then proves they work.
//
//   npm run build && npm run release:smoke        (needs network: it installs the packages' own dependencies)
//
// This is the test that matters before a publish: unit tests run against source, so they cannot notice a missing file
// in the tarball, a wrong `exports` map, a `bin` that does not run, or a UI folder that does not resolve once the
// package lives in node_modules. It also extracts the quickstart code from each README and RUNS it, so the examples on
// the npm pages cannot rot.
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const tmp = mkdtempSync(join(tmpdir(), 'paycryt-smoke-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};
const run = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let server;
try {
  // 1. Pack exactly what `npm publish` would upload.
  const tarballs = {};
  mkdirSync(join(tmp, 'tarballs'));
  for (const name of ['core', 'adapters', 'server']) {
    const out = JSON.parse(run(`npm pack --json --pack-destination "${join(tmp, 'tarballs')}"`, `${repo}/packages/${name}`))[0];
    tarballs[name] = join(tmp, 'tarballs', out.filename);
  }
  check('packed all three packages', Object.keys(tarballs).length === 3, Object.values(tarballs).map((t) => t.split(/[\\/]/).pop()).join(', '));

  // 2. A clean project that has never heard of this repo.
  const app = join(tmp, 'consumer');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  // Installed together, so the server's dependency on the other two resolves to these tarballs, not to the registry
  // (where they do not exist yet).
  run(`npm install --no-audit --no-fund "${tarballs.core}" "${tarballs.adapters}" "${tarballs.server}"`, app);
  check('installed from tarballs into an empty project', existsSync(join(app, 'node_modules/@paycryt/server/package.json')));
  const installed = (n) => JSON.parse(readFileSync(join(app, `node_modules/@paycryt/${n}/package.json`), 'utf8'));
  check('the three packages resolved each other, no registry lookups needed', installed('server').version === installed('core').version && !existsSync(join(app, 'node_modules/@paycryt/server/node_modules/@paycryt')));
  check('the `paycryt` command was linked', existsSync(join(app, 'node_modules/.bin/paycryt')) || existsSync(join(app, 'node_modules/.bin/paycryt.cmd')));

  // 3. Run the README quickstarts, verbatim.
  const quickstart = (pkg) => {
    const readme = readFileSync(`${repo}/packages/${pkg}/README.md`, 'utf8');
    const m = /```js quickstart\r?\n([\s\S]*?)```/.exec(readme);
    if (!m) throw new Error(`packages/${pkg}/README.md has no "js quickstart" code block`);
    return m[1];
  };
  for (const [pkg, expect] of [['core', [/send [\d.]+ USDT to 0x[0-9a-fA-F]{40}/, /partially_paid/]], ['adapters', [/tron ethereum coingecko function/]]]) {
    const file = join(app, `quickstart-${pkg}.mjs`);
    writeFileSync(file, quickstart(pkg));
    let out = '';
    let ok = true;
    try { out = run(`node "${file}"`, app); } catch (e) { ok = false; out = String(e.stderr || e.message); }
    check(`@paycryt/${pkg} README quickstart runs against the packed package`, ok && expect.every((re) => re.test(out)), out.trim().split('\n').slice(0, 2).join(' | ').slice(0, 140));
  }

  // 4. Embed the server through its public API.
  writeFileSync(join(app, 'embed.mjs'), `
    import { PaycrytServer } from '@paycryt/server';
    const server = await PaycrytServer.create({ apiKey: 'smoke-admin-key-0123456789', sandbox: true });
    const port = await server.listen(0);
    const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
    const page = await fetch('http://127.0.0.1:' + port + '/');
    const pos = await fetch('http://127.0.0.1:' + port + '/ui/pos.js', { method: 'HEAD' });
    await server.close();
    console.log(JSON.stringify({ mode: health.mode, page: page.status, pos: pos.status }));
  `);
  const embedded = JSON.parse(run('node embed.mjs', app).trim().split('\n').pop());
  check('PaycrytServer works when imported from node_modules, and finds its UI files', embedded.mode === 'sandbox' && embedded.page === 200 && embedded.pos === 200, JSON.stringify(embedded));

  // 5. Run the installed CLI (the `paycryt` bin's target) and use it like a user would.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cli = join(app, 'node_modules/@paycryt/server', installed('server').bin.paycryt);
  server = spawn(process.execPath, [cli], { cwd: app, env: { ...process.env, PORT: String(port), PAYCRYT_API_KEY: 'smoke-admin-key-0123456789' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ } await sleep(250); }
  const get = async (path, init) => fetch(base + path, init);
  const health = await (await get('/health')).json();
  check('installed CLI starts a sandbox server', health.ok === true && health.mode === 'sandbox');
  const html = await (await get('/')).text();
  check('dashboard is served from the installed package', html.includes('<div id="app"'));
  const posJs = await get('/ui/pos.js');
  const posLen = (await posJs.arrayBuffer()).byteLength;
  check('POS bundle is served and is the full bundle', posJs.status === 200 && posLen > 80_000, `${(posLen / 1024).toFixed(0)} kB`);
  for (const path of ['/ui/pos.html', '/ui/pos-sw.js', '/ui/manifest.webmanifest', '/ui/icon.svg', '/ui/qr.js']) {
    check(`${path} is served`, (await get(path)).status === 200);
  }
  const redirect = await get('/pos', { redirect: 'manual' });
  check('/pos redirects to the app', redirect.status === 302 && redirect.headers.get('location') === '/ui/pos.html');
  const merchant = await get('/v1/admin/merchants', { method: 'POST', headers: { authorization: 'Bearer smoke-admin-key-0123456789', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Test Shop' }) });
  const key = (await merchant.json()).apiKey;
  const pay = await get('/v1/payments', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1500', currency: 'NGN', asset: 'USDT_TRC20' }) });
  const payment = await pay.json();
  check('a merchant can be onboarded and a payment created end to end', pay.status === 201 && payment.status === 'awaiting_payment', `${payment.amountDue} units due`);
} catch (err) {
  check('smoke test completed without an unexpected error', false, String((err && (err.stderr || err.stack)) || err).slice(0, 600));
} finally {
  try { server?.kill(); } catch { /* already gone */ }
  await sleep(500);
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a handle may linger on Windows */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
