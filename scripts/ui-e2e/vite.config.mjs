import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A page that mounts the real screens from packages/ui, for scripts/ui-e2e.mjs.
 *
 * The source, not a build: the point is to run what is in the working tree.
 * The two aliases are what the apps' own configs get from the workspace, and
 * the two defines stop client.ts throwing over a missing .env — nothing here
 * ever reaches a server.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@snpos/core': join(root, 'packages/core/src/index.ts'),
      '@snpos/ui': join(root, 'packages/ui/src/index.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_APPWRITE_ENDPOINT': '"https://example.invalid/v1"',
    'import.meta.env.VITE_APPWRITE_PROJECT': '"ui-e2e"',
  },
  optimizeDeps: { exclude: ['@snpos/core', '@snpos/ui'] },
  server: { host: '127.0.0.1', fs: { allow: [root] } },
  logLevel: 'silent',
});
