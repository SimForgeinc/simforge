#!/usr/bin/env bash
# web-spike build (NON-PRODUCT): wasm32 release + wasm-bindgen + size report.
# Requires: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.127.
set -euo pipefail
cd "$(dirname "$0")"

WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"

cargo build --target wasm32-unknown-unknown --release
"$WASM_BINDGEN" --target web --out-dir www/pkg \
  target/wasm32-unknown-unknown/release/web_spike.wasm

# brotli via node zlib (no system brotli on this machine)
node -e '
const z = require("zlib"), fs = require("fs");
for (const f of ["www/pkg/web_spike_bg.wasm", "www/pkg/web_spike.js"]) {
  const raw = fs.readFileSync(f);
  const br = z.brotliCompressSync(raw, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11 } });
  fs.writeFileSync(f + ".br", br);
  console.log(`${f}: raw=${raw.length} brotli=${br.length}`);
}'
