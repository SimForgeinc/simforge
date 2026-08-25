#!/usr/bin/env node
// Static server for the web-spike harness (NON-PRODUCT).
// Serves www/ at / and $ASSET_DIR at /assets/. Precompressed .br served when accepted.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, 'www');
const ASSETS = process.env.ASSET_DIR || '/home/path/tmp/wasmgate-assets';
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname.startsWith('/assets/')) {
    file = path.join(ASSETS, path.normalize(url.pathname.slice(8)));
  } else {
    file = path.join(ROOT, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)));
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found: ' + url.pathname);
    return;
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  const acceptBr = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  if (acceptBr && fs.existsSync(file + '.br')) {
    headers['content-encoding'] = 'br';
    file += '.br';
  }
  headers['content-length'] = fs.statSync(file).size;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`web-spike server ready on http://127.0.0.1:${PORT} (assets: ${ASSETS})`));
