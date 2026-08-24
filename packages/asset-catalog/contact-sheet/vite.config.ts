import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Standalone bundle for the contact sheet only — the package itself ships TS
 * source. It lives inside `contact-sheet/` so that vitest, which picks up any
 * vite config at the package root, is not re-rooted into this directory.
 */
export default defineConfig({
  // vite's root defaults to the cwd, not to the config file's directory.
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: '../.contact-sheet-dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
