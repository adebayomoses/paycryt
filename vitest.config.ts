import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@paycryt/core': src('core'),
      '@paycryt/adapters': src('adapters'),
      '@paycryt/server': src('server'),
    },
  },
  test: { include: ['packages/**/test/**/*.test.ts', 'examples/**/test/**/*.test.ts'] },
});
