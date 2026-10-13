import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { PaycrytServer } from '@paycryt/server';
import { DashboardAssets } from '../src/ui.js';

const ADMIN = 'admin_key_0123456789abcdef';
const uiDir = new URL('../ui/', import.meta.url);
const built = existsSync(new URL('pos.js', uiDir));
let server: PaycrytServer | undefined;

async function boot() {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true });
  return `http://127.0.0.1:${await server.listen(0)}`;
}
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe.skipIf(!built)('offline POS serving (needs `npm run build`)', () => {
  it('serves the page, bundle, styles, worker, manifest and icon with the right types, no key needed', async () => {
    const url = await boot();
    for (const [path, type] of [
      ['/ui/pos.html', /text\/html/],
      ['/ui/pos.js', /javascript/],
      ['/ui/pos.css', /text\/css/],
      ['/ui/pos-sw.js', /javascript/],
      ['/ui/manifest.webmanifest', /application\/manifest\+json/],
      ['/ui/icon.svg', /image\/svg\+xml/],
    ] as const) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(type);
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'none'");
    }
  });

  it('lets the page register its worker and read its manifest under the strict CSP, and nothing wider', async () => {
    const url = await boot();
    const csp = (await fetch(url + '/ui/pos.html')).headers.get('content-security-policy')!;
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('sends /pos to the real address, so the worker (scope /ui/) controls the page', async () => {
    const url = await boot();
    const res = await fetch(url + '/pos', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/pos.html');
  });

  it('the bundle is browser-only and loads nothing from elsewhere', () => {
    const bundle = readFileSync(new URL('pos.js', uiDir), 'utf8');
    expect(bundle).not.toMatch(/from\s*["']node:|require\(["']node:|process\.getBuiltinModule\(["']node:(?!crypto)/);
    expect(bundle).not.toMatch(/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\//i); // no hard-coded remote endpoints
    expect(bundle.length).toBeGreaterThan(20_000); // it really contains the core library, not a stub
  });

  it('the page is wired to the manifest, worker scope and bundle it is served with', () => {
    const html = readFileSync(new URL('pos.html', uiDir), 'utf8');
    expect(html).toContain('href="/ui/manifest.webmanifest"');
    expect(html).toContain('src="/ui/pos.js"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', uiDir), 'utf8'));
    expect(manifest.start_url).toBe('/ui/pos.html');
    expect(manifest.scope).toBe('/ui/');
    expect(manifest.display).toBe('standalone');
  });
});

describe('without the generated bundle', () => {
  it('still serves the dashboard and simply does not offer the POS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paycryt-ui-'));
    try {
      for (const f of ['index.html', 'app.js', 'qr.js', 'util.js', 'style.css']) writeFileSync(join(dir, f), `/* ${f} */`);
      const assets = DashboardAssets.load(pathToFileURL(dir + '/'));
      expect(assets).toBeDefined();
      expect(assets!.hasPos).toBe(false);
      expect(assets!.lookup('/')).toBeDefined();
      expect(assets!.lookup('/ui/pos.js')).toBeUndefined();
      expect(assets!.lookup('/ui/pos.html')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches the whole UI off when the dashboard files themselves are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paycryt-ui-'));
    try {
      expect(DashboardAssets.load(pathToFileURL(dir + '/'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the service worker', () => {
  /** Runs pos-sw.js against fake browser globals and hands back what its fetch handler does with a request. */
  function harness() {
    const handlers: Record<string, (e: any) => void> = {};
    const cache = new Map<string, any>();
    const network = { up: true, calls: [] as string[] };
    const self = {
      location: { origin: 'https://till.example' },
      addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    };
    const caches = {
      open: async () => ({ put: async (req: any, res: any) => void cache.set(req.url, res), addAll: async () => undefined }),
      match: async (req: any) => cache.get(req.url),
      keys: async () => [],
      delete: async () => true,
    };
    const fetchFn = async (req: any) => {
      network.calls.push(req.url);
      if (!network.up) throw new TypeError('network down');
      return { ok: true, status: 200, body: `net:${req.url}`, clone() { return this; } };
    };
    runInNewContext(readFileSync(new URL('pos-sw.js', uiDir), 'utf8'), { self, caches, fetch: fetchFn, URL, AbortSignal, Promise });
    const dispatch = async (req: { url: string; method?: string }) => {
      let responded: Promise<any> | undefined;
      handlers.fetch!({ request: { method: 'GET', ...req }, respondWith: (p: Promise<any>) => (responded = p) });
      return { intercepted: !!responded, response: responded ? await responded : undefined };
    };
    return { dispatch, network, cache };
  }

  it('never intercepts an API call, a write, or another origin, so a sale cannot be answered from a cache', async () => {
    const { dispatch, network } = harness();
    for (const req of [
      { url: 'https://till.example/v1/payments' },
      { url: 'https://till.example/v1/sync', method: 'POST' },
      { url: 'https://till.example/v1/rates/USDT-NGN' },
      { url: 'https://till.example/v1/me' },
      { url: 'https://till.example/health' },
      { url: 'https://till.example/ui/pos.js', method: 'POST' },
      { url: 'https://other.example/ui/pos.js' },
      { url: 'https://till.example/' },
    ]) {
      expect((await dispatch(req)).intercepted, `${req.method ?? 'GET'} ${req.url}`).toBe(false);
    }
    expect(network.calls).toEqual([]); // not even looked at
  });

  it('serves the app from the network when it can, and from its cache when the till is offline', async () => {
    const { dispatch, network } = harness();
    network.up = true;
    expect((await dispatch({ url: 'https://till.example/ui/pos.js' })).response.body).toBe('net:https://till.example/ui/pos.js');
    network.up = false; // the connection drops
    const offline = await dispatch({ url: 'https://till.example/ui/pos.js' });
    expect(offline.intercepted).toBe(true);
    expect(offline.response.body).toBe('net:https://till.example/ui/pos.js'); // the copy kept from before
  });

  it('fails cleanly, rather than inventing a page, for a file it has never seen while offline', async () => {
    const { dispatch, network } = harness();
    network.up = false;
    await expect(dispatch({ url: 'https://till.example/ui/never-seen.js' })).rejects.toThrow('network down');
  });
});

describe('POS source invariants', () => {
  // The till holds a merchant API key in IndexedDB, so injection is the threat that matters. Pin the properties.
  const files = readdirSync(new URL('../pos/src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  const sources = files.map((f) => [f, code(readFileSync(new URL(`../pos/src/${f}`, import.meta.url), 'utf8'))] as const);

  it('has source files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['device.ts', 'main.ts', 'dom.ts']));
  });

  it.each(sources)('%s never turns data into markup or code', (_name, src) => {
    expect(src).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*['"`]/);
    expect(src).not.toMatch(/\.setAttribute\(\s*['"]style['"]|\bstyle:\s*['"`]/);
  });

  it('keeps the API key in IndexedDB only, never in localStorage, cookies or the URL', () => {
    for (const [name, src] of sources) {
      expect(src, name).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.(hash|search)/);
    }
  });

  it('loads no third-party code at runtime', () => {
    for (const [name, src] of sources) expect(src, name).not.toMatch(/import\(\s*['"]https?:|importScripts|new WebSocket|\bXMLHttpRequest\b/);
  });
});
