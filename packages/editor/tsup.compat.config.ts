import { defineConfig } from 'tsup';
import path from 'node:path';

export default defineConfig({
  entry: { index: 'compat-entry.ts' },
  format: ['esm'],
  dts: { resolve: ['@simforge/viewer'] },
  sourcemap: true,
  clean: true,
  outDir: 'dist-compat',
  external: ['three', '@simforge/scenario', '@simforge/engine', '@simforge/asset-catalog'],
  noExternal: ['@simforge/viewer'],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      '@simforge/viewer': path.resolve(__dirname, 'compat-viewer-shim.ts'),
    };
  },
});
