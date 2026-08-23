#!/usr/bin/env bash
# Local stand-in for the native-golden GitHub Actions workflow (WSB6).
# Runs the exact same steps the self-hosted 5080 runner will execute:
#   1. build native renderer (release)
#   2. corpus availability check
#   3. verify goldens (hash drift + >10% frame-time budget gate)
# Usage: qualification/golden-harness/ci-local.sh [record]   # 'record' re-records goldens first
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

echo "=== step 1/3: build native renderer ==="
cargo build --release -p render-core --bin native-render --manifest-path renderer/Cargo.toml

echo "=== step 2/3: corpus availability check ==="
if [ -n "${SCEN_SENSOR_CORPUS:-}" ]; then
  CORPUS="$SCEN_SENSOR_CORPUS"
elif [ -d scripts/renderer-spike/corpus ]; then
  CORPUS="scripts/renderer-spike/corpus"
else
  echo "::error::No corpus found: set SCEN_SENSOR_CORPUS or provide scripts/renderer-spike/corpus" >&2
  exit 1
fi
echo "corpus root: $CORPUS"
ls "$CORPUS" | head -3 >/dev/null   # non-empty

echo "=== step 3/3: golden suite ==="
if [ "${1:-verify}" = "record" ]; then
  for scene in qualification/golden-harness/scenes/*.json; do
    node qualification/golden-harness/golden.mjs record "$(basename "$scene" .json)"
  done
fi
node qualification/golden-harness/golden.mjs verify all

echo "=== native-golden local run: PASS ==="
