#!/usr/bin/env bash
set -euo pipefail

ASSET_ROOT=${1:?usage: package-assets.sh /absolute/path/to/dev-assets}
[[ "$ASSET_ROOT" = /* && -d "$ASSET_ROOT" ]] || { echo "Asset root must be an existing absolute directory" >&2; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
"$SCRIPT_DIR/build.sh"
RUNTIME_SOURCE="$SCRIPT_DIR/dist"
RUNTIME_TARGET="$ASSET_ROOT/sumo-runtime"
mkdir -p "$RUNTIME_TARGET"
for runtime_file in sumo.mjs sumo.wasm runtime-manifest.json THIRD_PARTY_NOTICES.md; do
  [[ -f "$RUNTIME_SOURCE/$runtime_file" ]] || { echo "Missing runtime artifact $runtime_file" >&2; exit 4; }
  cmake -E copy "$RUNTIME_SOURCE/$runtime_file" "$RUNTIME_TARGET/$runtime_file"
done
cmake -E copy_directory "$RUNTIME_SOURCE/licenses" "$RUNTIME_TARGET/licenses"

SUMO_HOME=${SUMO_HOME:-$SCRIPT_DIR/.cache/sumo}
export SUMO_HOME
command -v netconvert >/dev/null || { echo "netconvert 1.27.1 must be available on PATH" >&2; exit 5; }
command -v duarouter >/dev/null || { echo "duarouter 1.27.1 must be available on PATH" >&2; exit 5; }
for map_id in yale-street belmont-research-center el-camino-road easterbrook-discovery-school richmond-field-station; do
  map_root="$ASSET_ROOT/$map_id"
  [[ -f "$map_root/map.xodr" ]] || { echo "Missing $map_root/map.xodr" >&2; exit 3; }
  node "$SCRIPT_DIR/prepare-map.mjs" "$map_root/map.xodr" "$map_root/derived/sumo" "$map_id"
done
