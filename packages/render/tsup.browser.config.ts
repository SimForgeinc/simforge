import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'web/headless': 'src/web/headless.ts' },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  noExternal: [
    '@simforge/asset-catalog',
    '@simforge/engine',
    '@simforge/openscenario',
    '@simforge/playback',
    '@simforge/scenario',
    '@simforge/viewer',
    'fflate',
    'three',
    'zod',
  ],
  external: ['zlib'],
  clean: false,
  outDir: 'dist',
});
