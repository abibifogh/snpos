import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, host: true },
  // The workspace packages ship TypeScript source rather than a build step, so
  // one `vite dev` rebuilds everything without a watch-and-compile dance.
  optimizeDeps: { exclude: ['@snpos/core', '@snpos/ui'] },
  envDir: '../../',
});
