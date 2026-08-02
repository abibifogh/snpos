import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH lets the same build serve from a subfolder (GitHub Pages publishes
// each app under /<repo>/<app>/) or from a domain root, with no code change.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5176, host: true },
  optimizeDeps: { exclude: ['@snpos/core', '@snpos/ui'] },
  envDir: '../../',
});
