import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const KEY = 'synthetic_dashboard_csv_key';
const IMPORTS = ["import { qrMatrix } from './qr.js';", "import { OPEN_STATUSES, formatUnits, shortId, statusLabel } from './util.js';"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  // Evaluate the entire real module except its two checked imports and final boot call.
  // Only unrelated renderers/toasts are replaced; auth/session/download code stays intact.
  expect(source.match(/^import .*;$/gm)).toEqual(IMPORTS);
  let script = source;
  for (const line of IMPORTS) {
    expect(script.split(line)).toHaveLength(2);
    script = script.replace(line, '');
  }
  expect(script.match(/^boot\(\);$/gm)).toHaveLength(1);
  expect(script.trimEnd().endsWith('boot();')).toBe(true);
  script = script.replace(/^boot\(\);$/gm, '');

  const clicks: Array<{ href: string; filename: string }> = [];
  const created: Element[] = [];
  class Element {
    attrs: Record<string, string> = {};
    children: unknown[] = [];
    disabled = false;
    removed = false;
    textContent = '';
    constructor(readonly tag: string) {}
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener() {}
    append(...children: unknown[]) { this.children.push(...children); }
    remove() { this.removed = true; }
    click() { clicks.push({ href: this.attrs.href!, filename: this.attrs.download! }); }
  }
  const nodes = { app: new Element('div'), toasts: new Element('div') };
  const document = {
    body: new Element('body'),
    getElementById: (id: keyof typeof nodes) => nodes[id],
    createElement: (tag: string) => { const node = new Element(tag); created.push(node); return node; },
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const blobs: Blob[] = [];
  const objectURLs = {
    createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:synthetic-csv'; }),
    revokeObjectURL: vi.fn(),
  };
  const renderLogin = vi.fn();
  const renderShell = vi.fn();
  const toast = vi.fn();
  const fetch = vi.fn(async (path: string, _options?: RequestInit): Promise<Response> => {
    if (path === '/v1/me') return Response.json({ role: 'merchant', merchant: { id: 'synthetic_merchant' } });
    if (path === '/v1/assets') return Response.json({ assets: {}, currencies: {}, chains: [] });
    throw new Error('Unexpected mocked route: ' + path);
  });
  const context = createContext({
    document, Node: Element, URL: objectURLs, fetch,
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
    setInterval: () => { throw new Error('Unrelated polling must not run'); },
    clearInterval: vi.fn(), clearTimeout: vi.fn(),
    OPEN_STATUSES: [], formatUnits: vi.fn(), shortId: vi.fn(), statusLabel: vi.fn(), qrMatrix: vi.fn(),
    hooks: { renderLogin, renderShell, toast },
  });
  runInContext(script + `
    renderLogin = hooks.renderLogin;
    renderShell = hooks.renderShell;
    toast = hooks.toast;
    globalThis.subject = { state, downloadPayments, signIn, signOut, generation: () => sessionGeneration };
  `, context, { filename: 'actual-dashboard-app.js' });
  const subject = context.subject as {
    state: { key: string | null; role: string | null; me: unknown; payments: unknown[]; selectedId: string | null; filter: string };
    downloadPayments: (button: { disabled: boolean }) => Promise<void>;
    signIn: (key: string) => Promise<void>;
    signOut: (message?: string) => void;
    generation: () => number;
  };
  return { ...subject, fetch, clicks, created, document, timers, blobs, objectURLs, renderLogin, renderShell, toast };
}

async function signedIn() {
  const app = harness();
  await app.signIn(KEY);
  app.fetch.mockClear();
  return app;
}

function csv(body = '"id","note"\r\n"synthetic","Café 账单"\r\n') {
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
}

describe('actual dashboard CSV download', () => {
  it('uses the full CSV blob, fixed same-origin path/auth header, safe request options, exact filename and temporary URL cleanup', async () => {
    const app = await signedIn();
    const body = '"id","note"\r\n' + Array.from({ length: 250 }, (_, index) => `"${index}","Café, ""账单""\r\nline"\r\n`).join('');
    app.state.filter = 'paid'; // The download is the server snapshot, not the screen's filter/200-row limit.
    app.fetch.mockResolvedValueOnce(csv(body));
    const button = { disabled: false };
    const pending = app.downloadPayments(button);
    expect(button.disabled).toBe(true);
    await pending;
    expect(app.fetch).toHaveBeenCalledTimes(1);
    expect(app.fetch).toHaveBeenCalledWith('/v1/payments.csv', { headers: { authorization: `Bearer ${KEY}` }, cache: 'no-store', redirect: 'error' });
    expect(app.blobs).toHaveLength(1);
    expect(await app.blobs[0]!.text()).toBe(body);
    expect(app.clicks).toEqual([{ href: 'blob:synthetic-csv', filename: 'paycryt-payments.csv' }]);
    expect(app.created.filter((element) => element.tag === 'a')).toHaveLength(1);
    expect(app.created.find((element) => element.tag === 'a')!.removed).toBe(true);
    expect(app.objectURLs.revokeObjectURL).not.toHaveBeenCalled();
    expect(app.timers).toHaveLength(1);
    expect(app.timers[0]!.delay).toBe(1000);
    app.timers[0]!.callback();
    expect(app.objectURLs.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-csv');
    expect(button.disabled).toBe(false);
    expect(app.toast).not.toHaveBeenCalled();
  });

  it('ignores a duplicate click while the first request is pending', async () => {
    const app = await signedIn();
    const response = deferred<Response>();
    app.fetch.mockReturnValueOnce(response.promise);
    const button = { disabled: false };
    const first = app.downloadPayments(button);
    await app.downloadPayments(button);
    expect(button.disabled).toBe(true);
    expect(app.fetch).toHaveBeenCalledTimes(1);
    response.resolve(csv());
    await first;
    expect(app.clicks).toHaveLength(1);
    expect(button.disabled).toBe(false);
  });

  it('does not request a CSV without a signed-in key', async () => {
    const app = harness();
    const button = { disabled: false };
    await app.downloadPayments(button);
    expect(app.fetch).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
    expect(button.disabled).toBe(false);
  });

  it('clears the current session on401 through the actual signOut function', async () => {
    const app = await signedIn();
    app.state.payments = [{ id: 'synthetic' }];
    app.state.selectedId = 'synthetic';
    const generation = app.generation();
    app.fetch.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const button = { disabled: false };
    await app.downloadPayments(button);
    expect(app.generation()).toBe(generation + 1);
    expect(app.state.key).toBeNull();
    expect(app.state.role).toBeNull();
    expect(app.state.me).toBeNull();
    expect(app.state.payments).toEqual([]);
    expect(app.state.selectedId).toBeNull();
    expect(app.renderLogin).toHaveBeenCalledExactlyOnceWith('That API key was rejected. Please sign in again.');
    expect(app.clicks).toEqual([]);
    expect(button.disabled).toBe(false);
  });

  it.each([
    ['rate limit', () => Response.json({ error: 'limited' }, { status: 429, headers: { 'retry-after': '17' } }), 'Too many requests. Try again in 17 seconds.'],
    ['JSON failure', () => Response.json({ error: 'synthetic error' }, { status: 500 }), 'synthetic error'],
    ['non-JSON failure', () => new Response('unavailable', { status: 503 }), 'Download failed (503).'],
    ['wrong success content type', () => Response.json({ not: 'CSV' }), 'The server did not return a CSV file.'],
  ] as const)('does not download on%s and restores the button', async (_name, response, expected) => {
    const app = await signedIn();
    app.fetch.mockResolvedValueOnce(response());
    const button = { disabled: false };
    await app.downloadPayments(button);
    expect(app.objectURLs.createObjectURL).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
    expect(app.state.key).toBe(KEY);
    expect(app.toast).toHaveBeenCalledTimes(1);
    expect(app.toast).toHaveBeenCalledExactlyOnceWith(expected, 'error');
    expect(button.disabled).toBe(false);
  });

  it('reports a current-session fetch failure without downloading or clearing the key', async () => {
    const app = await signedIn();
    app.fetch.mockRejectedValueOnce(new Error('synthetic offline'));
    const button = { disabled: false };
    await app.downloadPayments(button);
    expect(app.toast).toHaveBeenCalledExactlyOnceWith('synthetic offline', 'error');
    expect(app.state.key).toBe(KEY);
    expect(app.clicks).toEqual([]);
    expect(button.disabled).toBe(false);
  });
});

describe('actual dashboard session-generation races', () => {
  it('increments generations with actual signIn/signOut, including reuse of the identical key', async () => {
    const app = harness();
    expect(app.generation()).toBe(0);
    await app.signIn(KEY);
    expect(app.generation()).toBe(1);
    app.signOut();
    expect(app.generation()).toBe(2);
    await app.signIn(KEY);
    expect(app.generation()).toBe(3);
    expect(app.state.key).toBe(KEY);
    expect(app.renderShell).toHaveBeenCalledTimes(2);
  });

  it('discards a stale successful fetch after logout and identical-key sign-in', async () => {
    const app = await signedIn();
    const response = deferred<Response>();
    app.fetch.mockReturnValueOnce(response.promise);
    const button = { disabled: false };
    const pending = app.downloadPayments(button);
    app.signOut();
    await app.signIn(KEY);
    const generation = app.generation();
    response.resolve(csv());
    await pending;
    expect(app.state.key).toBe(KEY);
    expect(app.generation()).toBe(generation);
    expect(app.objectURLs.createObjectURL).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
    expect(app.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  it.each([KEY, 'different_synthetic_key'])('ignores a late401 after logout and sign-in with%s', async (nextKey) => {
    const app = await signedIn();
    const response = deferred<Response>();
    app.fetch.mockReturnValueOnce(response.promise);
    const pending = app.downloadPayments({ disabled: false });
    app.signOut();
    await app.signIn(nextKey);
    const generation = app.generation();
    response.resolve(Response.json({ error: 'old session' }, { status: 401 }));
    await pending;
    expect(app.state.key).toBe(nextKey);
    expect(app.state.role).toBe('merchant');
    expect(app.generation()).toBe(generation);
    expect(app.renderLogin).toHaveBeenCalledTimes(1);
    expect(app.toast).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
  });

  it('discards a stale blob after logout and identical-key sign-in', async () => {
    const app = await signedIn();
    const contents = deferred<Blob>();
    const started = deferred<void>();
    const response = csv();
    response.blob = vi.fn(() => { started.resolve(); return contents.promise; });
    app.fetch.mockResolvedValueOnce(response);
    const button = { disabled: false };
    const pending = app.downloadPayments(button);
    await started.promise;
    app.signOut();
    await app.signIn(KEY);
    const generation = app.generation();
    contents.resolve(new Blob(['synthetic stale data']));
    await pending;
    expect(app.state.key).toBe(KEY);
    expect(app.generation()).toBe(generation);
    expect(app.objectURLs.createObjectURL).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
    expect(app.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  it('ignores a401 whose JSON body finishes after an identical-key replacement session', async () => {
    const app = await signedIn();
    const body = deferred<unknown>();
    const started = deferred<void>();
    const response = Response.json({ error: 'old' }, { status: 401 });
    response.json = vi.fn(() => { started.resolve(); return body.promise; });
    app.fetch.mockResolvedValueOnce(response);
    const pending = app.downloadPayments({ disabled: false });
    await started.promise;
    app.signOut();
    await app.signIn(KEY);
    const generation = app.generation();
    body.resolve({ error: 'old401' });
    await pending;
    expect(app.state.key).toBe(KEY);
    expect(app.generation()).toBe(generation);
    expect(app.renderLogin).toHaveBeenCalledTimes(1);
    expect(app.toast).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
  });

  it('suppresses a stale fetch error after a replacement session', async () => {
    const app = await signedIn();
    const response = deferred<Response>();
    app.fetch.mockReturnValueOnce(response.promise);
    const pending = app.downloadPayments({ disabled: false });
    app.signOut();
    await app.signIn(KEY);
    response.reject(new Error('stale network error'));
    await pending;
    expect(app.state.key).toBe(KEY);
    expect(app.toast).not.toHaveBeenCalled();
    expect(app.clicks).toEqual([]);
  });
});
