import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { fraySchema } from './vite.schema';

export default defineConfig({
  root: fileURLToPath(new URL('./renderer', import.meta.url)),
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  // Declared up front so Vite does not discover them mid-load and reload the page after startup.
  optimizeDeps: {
    include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'],
  },
  server: {
    port: 5173,
  },
  worker: {
    plugins: () => [fraySchema()],
  },
  plugins: [react(), fraySchema()],
});