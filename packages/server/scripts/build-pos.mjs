// Builds the offline POS web app: type-checks packages/server/pos, then bundles it with esbuild into
// packages/server/ui/pos.js, the file the server serves. Run by `npm run build` after `tsc -b`.
//
// A bundle (rather than serving modules one by one) because the till runs the same core library as the server
// (HD address derivation, hashing, the offline queue), and that library has bare-specifier dependencies a
// browser cannot resolve on its own.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

// 1. Type-check the browser code against the real core types. esbuild itself does not.
const tsc = require.resolve('typescript/bin/tsc');
try {
  execFileSync(process.execPath, [tsc, '-p', `${root}pos/tsconfig.json`, '--noEmit'], { stdio: 'inherit' });
} catch {
  console.error('POS type-check failed.');
  process.exit(1);
}

// 2. Bundle.
const out = `${root}ui/pos.js`;
const result = await build({
  entryPoints: [`${root}pos/src/main.ts`],
  outfile: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

// 3. Refuse to ship a bundle that reaches for Node: it would fail in the browser at the till, not at build time.
const nodeImports = Object.values(result.metafile.outputs)
  .flatMap((o) => o.imports)
  .filter((i) => i.path.startsWith('node:') || i.external);
if (nodeImports.length) {
  console.error('POS bundle imports Node built-ins:', nodeImports.map((i) => i.path).join(', '));
  process.exit(1);
}
console.log(`built ui/pos.js (${(statSync(out).size / 1024).toFixed(0)} kB)`);
