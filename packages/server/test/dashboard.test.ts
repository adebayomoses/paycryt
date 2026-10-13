import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '@paycryt/core';
import { PaycrytServer, type ServerConfig } from '@paycryt/server';
import { liveOptions } from './live-helpers.js';

const ADMIN = 'admin_key_0123456789abcdef';
let server: PaycrytServer | undefined;

async function boot(overrides: Partial<ServerConfig> = {}) {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, ...overrides });
  return `http://127.0.0.1:${await server.listen(0)}`;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const uiFile = (name: string) => readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
/** Source with whole-line and block comments removed, so a rule like "never use innerHTML" is checked against code only. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('dashboard serving', () => {
  it('serves the page at / and /ui with no API key, because it holds no data and no key', async () => {
    const url = await boot();
    for (const path of ['/', '/ui', '/ui/', '/ui/index.html']) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(await res.text()).toContain('<div id="app"');
    }
  });

  it('sends a strict CSP and anti-framing headers', async () => {
    const url = await boot();
    const res = await fetch(url + '/');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:\/\//); // nothing may be loaded from another origin
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('serves each script and the stylesheet with the right type, byte-for-byte what is on disk', async () => {
    const url = await boot();
    for (const [path, file, type] of [
      ['/ui/app.js', 'app.js', /javascript/],
      ['/ui/qr.js', 'qr.js', /javascript/],
      ['/ui/util.js', 'util.js', /javascript/],
      ['/ui/style.css', 'style.css', /text\/css/],
    ] as const) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(type);
      expect(await res.text(), path).toBe(uiFile(file));
    }
  });

  it('answers HEAD without a body', async () => {
    const url = await boot();
    const res = await fetch(url + '/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('only serves its allow-list: no traversal, no sibling files, no other methods', async () => {
    const url = await boot();
    for (const path of ['/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/..%2f..%2fsrc/app.ts', '/ui/app.js.map', '/ui/secret.txt', '/ui/.env', '/ui/qr.test.ts']) {
      const res = await fetch(url + path);
      expect(res.status, path).not.toBe(200); // falls through to the authenticated API: 401, never a file
    }
    const post = await fetch(url + '/', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(post.headers.get('content-security-policy')).toBeNull(); // POST / is not the page
  });

  it('can be switched off, leaving `/` to the authenticated API as before', async () => {
    const url = await boot({ ui: false });
    expect((await fetch(url + '/')).status).toBe(401);
    expect((await fetch(url + '/ui/app.js')).status).toBe(401);
    expect((await fetch(url + '/health')).status).toBe(200);
  });

  it('does not spend request-limiter tokens or trip the failed-auth limiter', async () => {
    const url = await boot({ requestsPerMinute: 60, requestBurst: 2, authFailuresPerMinute: 1 });
    for (let i = 0; i < 12; i++) expect((await fetch(url + '/ui/app.js')).status).toBe(200);
    const api = (key: string) => fetch(url + '/v1/payments', { headers: { authorization: `Bearer ${key}` } });
    expect((await api(ADMIN)).status).toBe(200); // the page loads did not use up the key's budget
    expect((await api(ADMIN)).status).toBe(200);
    expect((await api(ADMIN)).status).toBe(429); // the budget itself is still enforced
  });
});

describe('/v1/assets', () => {
  it('needs a key', async () => {
    const url = await boot();
    expect((await fetch(url + '/v1/assets')).status).toBe(401);
  });

  it('lists the catalogue and, in the sandbox, every chain', async () => {
    const url = await boot();
    const r = await (await fetch(url + '/v1/assets', { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(r.assets.USDT_TRC20).toMatchObject({ symbol: 'USDT', chain: 'tron', decimals: 6 });
    expect(Object.keys(r.currencies)).toEqual(expect.arrayContaining(['NGN', 'GHS', 'KES']));
    expect(r.chains.sort()).toEqual(['base', 'bitcoin', 'bsc', 'ethereum', 'tron']);
  });

  it('in live mode lists only the chains actually wired, so the UI cannot offer one that would fail', async () => {
    const url = await boot({ ...liveOptions({ chains: [new FakeChain('tron')] }), sandbox: false });
    const r = await (await fetch(url + '/v1/assets', { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(r.chains).toEqual(['tron']);
  });
});

describe('dashboard source invariants', () => {
  // The page holds an API key in memory, so XSS is the threat that matters. These pin the properties that make
  // the strict CSP and textContent-only rendering real, so a later edit can't quietly undo them.
  const html = uiFile('index.html');
  const js = ['app.js', 'qr.js', 'util.js'].map((f) => [f, code(uiFile(f))] as const);

  it('has no inline script, inline style or inline event handler for the CSP to forbid', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(src|href)=["']https?:/i); // nothing from another origin
  });

  it.each(js)('%s never turns data into markup or code', (_name, src) => {
    expect(src).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*['"`]/);
    expect(src).not.toMatch(/\.setAttribute\(\s*['"]style['"]|\bstyle:\s*['"`]/); // inline styles are blocked by the CSP anyway
  });

  it('keeps the API key out of persistent browser storage', () => {
    const app = code(uiFile('app.js'));
    expect(app).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('loads no third-party code', () => {
    for (const [name, src] of js) expect(src, name).not.toMatch(/from\s+['"]https?:|import\(\s*['"]https?:|importScripts|new WebSocket/);
  });
});
