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
    '@simforge/viewer',
    '@simforge/playback',
    '@simforge/render',
    '@simforge/scenario',
    'fflate',
    'three',
  ],
});
