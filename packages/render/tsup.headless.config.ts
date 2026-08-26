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
    '@simforge-oss/viewer',
    '@simforge-oss/playback',
    '@simforge-oss/render',
    '@simforge-oss/scenario',
    'fflate',
    'three',
  ],
});
