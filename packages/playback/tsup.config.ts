import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/traffic/index.ts', 'src/traffic-provider/sumoWasmWorker.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
