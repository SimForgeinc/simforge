import { defineConfig } from 'tsup';
import path from 'node:path';

export default defineConfig({
  entry: { index: 'compat-entry.ts' },
  format: ['esm'],
  dts: { resolve: ['@simforge-oss/viewer'] },
  sourcemap: true,
  clean: true,
  outDir: 'dist-compat',
  external: ['three', '@simforge-oss/scenario', '@simforge-oss/engine', '@simforge-oss/asset-catalog'],
  noExternal: ['@simforge-oss/viewer'],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      '@simforge-oss/viewer': path.resolve(__dirname, 'compat-viewer-shim.ts'),
    };
  },
});
