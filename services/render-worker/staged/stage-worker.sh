#!/usr/bin/env bash
# Images-last staged worker driver: build unreleased code locally, ship it to
# one live fleet host, and (re)start a fenced "-staged" worker there with ZERO
# image bake. See docs/images-last-worker-iteration.md for the operator flow.
#
#   stage-worker.sh build carla|browser      build wheel + worker deploy output
#   stage-worker.sh push <ssh-host>          rsync staged code to the host
#   stage-worker.sh run  <ssh-host>          (re)start the staged container
#
# Environment (run):
#   STAGED_CHASSIS_IMAGE   baked image to run the staged code on (REQUIRED)
#   STAGED_CONFIG          host path of the staged worker.json (REQUIRED)
#   STAGED_NAME            container name        [uniscenarios-staged-worker]
#   STAGED_GPU             --gpus device value   [all]
#   STAGED_TOKEN_ENV_FILE  host path of an env file providing
#                          UNISCENARIO_RENDER_WORKER_TOKEN (REQUIRED)
#   STAGED_DIR_HOST        host staged dir       [/opt/simforge/uniscenarios-staged]
#   STAGED_EXTRA_ARGS      extra docker run args (e.g. carla env/ports)
set -euo pipefail

cmd="${1:?usage: stage-worker.sh build|push|run ...}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
out="$repo_root/.staged-out"
staged_dir_host="${STAGED_DIR_HOST:-/opt/simforge/uniscenarios-staged}"

case "$cmd" in
  build)
    engine="${2:?usage: stage-worker.sh build carla|browser}"
    mkdir -p "$out"
    cp "$repo_root/services/render-worker/staged/entrypoint.sh" "$out/entrypoint.sh"
    cd "$repo_root"
    if [ "$engine" = "carla" ]; then
      rm -rf "$out/wheels" && mkdir -p "$out/wheels"
      python3 -m pip wheel --no-deps --wheel-dir "$out/wheels" ./adapters/carla-bridge
      pnpm --filter @uniscenarios/scenario-model --filter @uniscenarios/render-runtime --filter @uniscenarios/render-worker build
      rm -rf "$out/worker"
      pnpm deploy --legacy --filter @uniscenarios/render-worker --prod "$out/worker"
    else
      pnpm --filter @uniscenarios/browser-renderer... --filter @uniscenarios/render-worker... build
      rm -rf "$out/worker" "$out/browser-renderer"
      pnpm deploy --legacy --filter @uniscenarios/render-worker --prod "$out/worker"
      pnpm deploy --legacy --filter @uniscenarios/browser-renderer --prod "$out/browser-renderer"
    fi
    echo "staged build ready in $out"
    ;;
  push)
    host="${2:?usage: stage-worker.sh push <ssh-host>}"
    ssh "$host" "mkdir -p '$staged_dir_host/code'"
    rsync -az --delete --chmod=F755 "$out/" "$host:$staged_dir_host/code/"
    echo "staged code pushed to $host:$staged_dir_host/code"
    ;;
  run)
    host="${2:?usage: stage-worker.sh run <ssh-host>}"
    : "${STAGED_CHASSIS_IMAGE:?set STAGED_CHASSIS_IMAGE to the baked chassis image}"
    : "${STAGED_CONFIG:?set STAGED_CONFIG to the host path of the staged worker.json}"
    : "${STAGED_TOKEN_ENV_FILE:?set STAGED_TOKEN_ENV_FILE to the host env file with the worker token}"
    name="${STAGED_NAME:-uniscenarios-staged-worker}"
    gpu="${STAGED_GPU:-all}"
    ssh "$host" "docker rm -f '$name' >/dev/null 2>&1 || true; \
      mkdir -p '$staged_dir_host/state/scratch' '$staged_dir_host/state/cache' '$staged_dir_host/state/run'; \
      docker run -d --name '$name' --network host --restart no \
        --gpus '\"device=$gpu\"' \
        --env-file '$STAGED_TOKEN_ENV_FILE' \
        -v '$staged_dir_host/code:/staged:ro' \
        -v '$staged_dir_host/state/scratch:/scratch' \
        -v '$staged_dir_host/state/cache:/cache' \
        -v '$staged_dir_host/state/run:/run/uniscenarios' \
        -v '$STAGED_CONFIG:/config/staged-worker.json:ro' \
        ${STAGED_EXTRA_ARGS:-} \
        --entrypoint /usr/bin/tini \
        '$STAGED_CHASSIS_IMAGE' -- /staged/entrypoint.sh --config /config/staged-worker.json"
    echo "staged worker '$name' running on $host"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 64
    ;;
esac
