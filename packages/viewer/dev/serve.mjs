#!/usr/bin/env node
/**
 * Static file server for map roots during viewer development:
 * `node serve.mjs <root> [port]` serves `<root>/**` with CORS and Range
 * support, plus three's Basis transcoder at `/basis/`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const [root = '.', portArg = '8787'] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const basisDir = path.dirname(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'));
const types = new Map([
  ['.json', 'application/json'], ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'], ['.bin', 'application/octet-stream'],
  ['.ktx2', 'image/ktx2'], ['.png', 'image/png'], ['.hdr', 'application/octet-stream'], ['.gz', 'application/gzip'],
  ['.js', 'text/javascript'], ['.wasm', 'application/wasm'],
]);

http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const file = pathname.startsWith('/basis/')
    ? path.join(basisDir, pathname.slice('/basis/'.length))
    : path.join(path.resolve(root), pathname);
  const base = pathname.startsWith('/basis/') ? basisDir : path.resolve(root);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (!file.startsWith(base)) { response.writeHead(403, cors); response.end(); return; }
  let info;
  try { info = await stat(file); } catch { response.writeHead(404, cors); response.end(); return; }
  if (!info.isFile()) { response.writeHead(404, cors); response.end(); return; }
  const headers = {
    'Content-Type': types.get(path.extname(file)) ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : info.size - 1;
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': info.size });
  createReadStream(file).pipe(response);
}).listen(Number(portArg), () => console.log(`serving ${path.resolve(root)} on http://localhost:${portArg}/ (+ /basis/)`));
