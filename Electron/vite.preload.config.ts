import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The preload script runs in a sandbox that cannot load other files, so it is built as one self-contained file.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./main/preload.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: { external: ['electron'] },
  },
});
