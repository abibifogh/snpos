import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, host: true },
  optimizeDeps: { exclude: ['@snpos/core', '@snpos/ui'] },
  envDir: '../../',
});
