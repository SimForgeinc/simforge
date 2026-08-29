#!/usr/bin/env bash
set -euo pipefail

SUMO_TAG=v1_27_1
SUMO_COMMIT=7717f2379d9e314a0c81c5cec748444de06a2a91
XERCES_TAG=v3.2.5
XERCES_COMMIT=53c16411466bf90c62617831fe92ed0f41e70882

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
SPIKE_DIR="$ROOT_DIR/research/sumo-wasm"
CACHE_DIR="${SUMO_WASM_CACHE:-$SPIKE_DIR/.cache}"
OUTPUT_DIR="${SUMO_WASM_OUTPUT:-$SPIKE_DIR/dist}"
PREFIX_DIR="$CACHE_DIR/prefix"

for command in git emcc emcmake cmake ninja python3; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }
done

mkdir -p "$CACHE_DIR" "$OUTPUT_DIR"

clone_pinned() {
  local url=$1 tag=$2 commit=$3 destination=$4
  if [[ ! -d "$destination/.git" ]]; then
    git clone --depth 1 --branch "$tag" "$url" "$destination"
  fi
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$commit" ]] || {
    echo "Unexpected commit in $destination" >&2
    exit 3
  }
}

clone_pinned https://github.com/apache/xerces-c.git "$XERCES_TAG" "$XERCES_COMMIT" "$CACHE_DIR/xerces-c"
clone_pinned https://github.com/eclipse-sumo/sumo.git "$SUMO_TAG" "$SUMO_COMMIT" "$CACHE_DIR/sumo"

if git -C "$CACHE_DIR/sumo" apply --unidiff-zero --check "$SPIKE_DIR/patches/sumo-1.27.1-emscripten.patch" 2>/dev/null; then
  git -C "$CACHE_DIR/sumo" apply --unidiff-zero "$SPIKE_DIR/patches/sumo-1.27.1-emscripten.patch"
elif ! git -C "$CACHE_DIR/sumo" apply --unidiff-zero --reverse --check "$SPIKE_DIR/patches/sumo-1.27.1-emscripten.patch" 2>/dev/null; then
  echo "SUMO WebAssembly patch does not apply cleanly" >&2
  exit 4
fi

emcmake cmake -S "$CACHE_DIR/xerces-c" -B "$CACHE_DIR/xerces-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_INSTALL_PREFIX="$PREFIX_DIR" \
  -DBUILD_SHARED_LIBS=OFF \
  -Dnetwork=OFF \
  -Dmessage-loader=inmemory \
  -Dtranscoder=iconv
cmake --build "$CACHE_DIR/xerces-build" --target xerces-c --parallel
# Xerces' install target also builds browser-inapplicable samples/tests. Stage
# only the static library and public/generated headers needed by SUMO.
mkdir -p "$PREFIX_DIR/lib" "$PREFIX_DIR/include"
cp "$CACHE_DIR/xerces-build/src/libxerces-c.a" "$PREFIX_DIR/lib/libxerces-c.a"
cmake -E copy_directory "$CACHE_DIR/xerces-c/src/xercesc" "$PREFIX_DIR/include/xercesc"
cmake -E copy_directory "$CACHE_DIR/xerces-build/src/xercesc" "$PREFIX_DIR/include/xercesc"

emcmake cmake -S "$CACHE_DIR/sumo" -B "$CACHE_DIR/sumo-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_CXX_FLAGS=-fexceptions \
  -DCMAKE_EXE_LINKER_FLAGS=-fexceptions \
  -DXercesC_LIBRARY="$PREFIX_DIR/lib/libxerces-c.a" \
  -DXercesC_INCLUDE_DIR="$PREFIX_DIR/include" \
  -DSIMFORGE_SUMO_WASM_TARGET="$SPIKE_DIR/cmake/wasm-target.cmake" \
  -DSIMFORGE_SUMO_WASM_BRIDGE="$SPIKE_DIR/bridge/sumo_wasm_bridge.cpp" \
  -DENABLE_FMI=OFF \
  -DENABLE_NETEDIT=OFF \
  -DENABLE_PYTHON_BINDINGS=OFF \
  -DENABLE_JAVA_BINDINGS=OFF \
  -DENABLE_CS_BINDINGS=OFF \
  -DENABLE_C_BINDINGS=OFF \
  -DENABLE_TCMALLOC=OFF \
  -DENABLE_PARQUET=OFF \
  -DENABLE_PROJ=OFF \
  -DENABLE_FOX=OFF \
  -DENABLE_EIGEN=OFF \
  -DENABLE_FMT=OFF \
  -DENABLE_GTEST=OFF \
  -DENABLE_GDAL=OFF \
  -DENABLE_FFMPEG=OFF \
  -DENABLE_OSG=OFF \
  -DENABLE_GL2PS=OFF \
  -DENABLE_JUPEDSIM=OFF \
  -DENABLE_BOOST=OFF
cmake --build "$CACHE_DIR/sumo-build" --target simforge-sumo-wasm --parallel

cp "$CACHE_DIR/sumo-build/wasm/sumo.mjs" "$OUTPUT_DIR/sumo.mjs"
cp "$CACHE_DIR/sumo-build/wasm/sumo.wasm" "$OUTPUT_DIR/sumo.wasm"
gzip -9 -kf "$OUTPUT_DIR/sumo.wasm"
node "$SPIKE_DIR/write-runtime-manifest.mjs" \
  "$OUTPUT_DIR" "$CACHE_DIR/sumo" "$CACHE_DIR/xerces-c"
wc -c "$OUTPUT_DIR/sumo.mjs" "$OUTPUT_DIR/sumo.wasm" "$OUTPUT_DIR/sumo.wasm.gz"
