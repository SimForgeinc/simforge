import { defineConfig } from 'tsup';

export default defineConfig({
  // The SUMO worker is emitted beside index.js so sumoWasmProvider can load it
  // with one relative URL in both the source tree and the packed bundle.
  entry: {
    index: 'src/index.ts',
    'traffic/index': 'src/traffic/index.ts',
    sumoWasmWorker: 'src/traffic-provider/sumoWasmWorker.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
