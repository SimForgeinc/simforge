import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/headless.ts'],
  format: ['esm'],
  platform: 'browser',
  dts: true,
  sourcemap: true,
  outDir: 'dist',
  external: ['zlib'],
  noExternal: [
    '@uniscenarios/city-renderer',
    '@uniscenarios/playback',
    '@uniscenarios/render-runtime',
    '@uniscenarios/scenario-model',
    'fflate',
    'three',
  ],
});
