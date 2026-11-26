import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const main = (name: string) => fileURLToPath(new URL(`./main/${name}.ts`, import.meta.url));

// Electron Main and its worker threads are compiled to CommonJS, one output file per source module,
// so workers can still be started by file name next to main.js.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    lib: {
      entry: Object.fromEntries([
        'main', 'ipc_manager', 'log_manager', 'message', 'message_router', 'message_worker',
        'network_worker', 'thread_manager',
      ].map((name) => [name, main(name)]).concat([
        ['outgoing_router', fileURLToPath(new URL('./shared/outgoing_router.ts', import.meta.url))],
      ])),
      formats: ['cjs'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ['electron', 'protobufjs', /^node:/, ...builtinModules],
      output: { preserveModules: true, preserveModulesRoot: 'main', exports: 'named' },
    },
  },
});
