import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import pbjs from 'protobufjs-cli/pbjs.js';

const schemaPath = fileURLToPath(new URL('../Schemas/fray.proto', import.meta.url));
const schemaDirectory = path.dirname(schemaPath);
const schemaModule = '\0virtual:fray-schema';

/** Serves the shared protobuf schema to the renderer as the virtual module `virtual:fray-schema`. */
export function fraySchema(): Plugin {
  return {
    name: 'fray-schema',
    resolveId(id) {
      if (id === 'virtual:fray-schema') return schemaModule;
    },
    load(id) {
      if (id !== schemaModule) return;
      this.addWatchFile(schemaPath);
      return new Promise<string>((resolve, reject) => {
        pbjs.main(['-t', 'static-module', '-w', 'esm', '-p', schemaDirectory, schemaPath],
          (error: Error | null, output?: string) => error ? reject(error) : resolve(output ?? ''));
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
