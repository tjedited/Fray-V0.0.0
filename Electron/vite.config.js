import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pbjs from 'protobufjs-cli/pbjs.js';

const schemaPath = fileURLToPath(new URL('../Schemas/fray.proto', import.meta.url));
const schemaDirectory = path.dirname(schemaPath);
const schemaModule = '\0virtual:fray-schema';

function fraySchema() {
  return {
    name: 'fray-schema',
    resolveId(id) {
      if (id === 'virtual:fray-schema') return schemaModule;
    },
    load(id) {
      if (id !== schemaModule) return;
      this.addWatchFile(schemaPath);
      return new Promise((resolve, reject) => {
        pbjs.main(['-t', 'static-module', '-w', 'esm', '-p', schemaDirectory, schemaPath],
          (error, output) => error ? reject(error) : resolve(output));
      });
    },
    configureServer(server) {
      server.watcher.add(schemaDirectory);
    },
    handleHotUpdate({ file, server }) {
      if (file !== schemaPath) return;
      const schema = server.moduleGraph.getModuleById(schemaModule);
      if (schema) server.moduleGraph.invalidateModule(schema);
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./renderer', import.meta.url)),
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  worker: {
    plugins: () => [fraySchema()],
  },
  plugins: [react(), fraySchema()],
});