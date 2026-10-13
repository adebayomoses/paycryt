import { readFileSync } from 'node:fs';

/** One static file of the dashboard. */
export interface UiAsset {
  body: Buffer;
  type: string;
}

const FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'qr.js': 'text/javascript; charset=utf-8',
  'util.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

/** URL path -> file. An allow-list, so no request path is ever turned into a filesystem path. */
const ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/ui': 'index.html',
  '/ui/index.html': 'index.html',
  '/ui/app.js': 'app.js',
  '/ui/qr.js': 'qr.js',
  '/ui/util.js': 'util.js',
  '/ui/style.css': 'style.css',
};

/**
 * The dashboard holds an API key in page memory, so its headers are strict: only same-origin scripts and styles
 * (no inline script, nothing third-party), no framing, no form posts, no referrer.
 */
export const UI_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

export class DashboardAssets {
  private constructor(private readonly files: Map<string, UiAsset>) {}

  /**
   * Reads the dashboard files from `packages/server/ui`. That folder sits beside both `src/` and `dist/`, so the
   * same relative path works from source (tests) and from the build. Returns undefined, with a warning, if the
   * files are missing, so an API-only deployment that dropped them still starts.
   */
  static load(dir: URL = new URL('../ui/', import.meta.url)): DashboardAssets | undefined {
    const files = new Map<string, UiAsset>();
    try {
      for (const [name, type] of Object.entries(FILES)) files.set(name, { body: readFileSync(new URL(name, dir)), type });
    } catch (err) {
      console.warn(`[paycryt] dashboard files not found, the web UI is disabled (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
    return new DashboardAssets(files);
  }

  /** The asset for a request path, or undefined if this path isn't part of the dashboard. */
  lookup(path: string): UiAsset | undefined {
    const name = Object.prototype.hasOwnProperty.call(ROUTES, path) ? ROUTES[path] : undefined;
    return name ? this.files.get(name) : undefined;
  }
}
