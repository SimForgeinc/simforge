#!/bin/sh
# Images-last staged entrypoint. Mounted into an EXISTING baked worker image
# (the "chassis") together with a staged code directory; installs the staged
# bridge wheel(s) and runs the staged worker build at container start, so
# unreleased code is validated on a live worker with ZERO image bake.
#
# Usage (host side, see docs/images-last-worker-iteration.md):
#   docker run ... \
#     -v /opt/simforge/uniscenarios-staged/code:/staged:ro \
#     --entrypoint /usr/bin/tini \
#     <chassis image> -- /staged/entrypoint.sh --config /config/staged-worker.json
#
# Layout of /staged:
#   entrypoint.sh            this script
#   wheels/*.whl             staged python wheels (carla bridge), optional
#   worker/                  full `pnpm deploy` output (dist + node_modules), optional
#   browser-renderer/        full `pnpm deploy` output for the browser engine, optional
set -eu

STAGED_DIR="${UNISCENARIOS_STAGED_DIR:-/staged}"

if [ -d "$STAGED_DIR/wheels" ]; then
  for wheel in "$STAGED_DIR"/wheels/*.whl; do
    [ -e "$wheel" ] || break
    if [ "$(id -u)" = "0" ]; then
      python3 -m pip install --no-cache-dir --no-deps --force-reinstall "$wheel"
    else
      python3 -m pip install --no-cache-dir --no-deps --force-reinstall --user "$wheel"
    fi
    echo "staged: installed $(basename "$wheel")" >&2
  done
fi

if [ -f "$STAGED_DIR/browser-renderer/dist/index.js" ]; then
  export UNISCENARIOS_BROWSER_ENGINE_MODULE="$STAGED_DIR/browser-renderer/dist/index.js"
  echo "staged: using staged browser renderer" >&2
fi

WORKER_MAIN="/opt/uniscenarios/worker/dist/main.js"
if [ -f "$STAGED_DIR/worker/dist/main.js" ]; then
  WORKER_MAIN="$STAGED_DIR/worker/dist/main.js"
  echo "staged: using staged worker build" >&2
else
  echo "staged: no staged worker build; using baked worker" >&2
fi

exec node "$WORKER_MAIN" "$@"
