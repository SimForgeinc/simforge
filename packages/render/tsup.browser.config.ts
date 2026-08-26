import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'web/headless': 'src/web/headless.ts' },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  noExternal: [
    '@simforge-oss/asset-catalog',
    '@simforge-oss/engine',
    '@simforge-oss/openscenario',
    '@simforge-oss/playback',
    '@simforge-oss/scenario',
    '@simforge-oss/viewer',
    'fflate',
    'three',
    'zod',
  ],
  external: ['zlib'],
  clean: false,
  outDir: 'dist',
});
