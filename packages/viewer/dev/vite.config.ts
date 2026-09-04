import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  server: { port: 5177, strictPort: true, fs: { allow: ['../..', '../../..'] } },
});
