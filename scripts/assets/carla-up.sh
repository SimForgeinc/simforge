#!/usr/bin/env bash
# carla-up.sh — OPTIONAL developer convenience for the local CARLA loop.
#
# Product contract (docs/ops/local-assets.md): CARLA is USER-PROVIDED. Users
# run their own CARLA container — a normal upstream-style distribution with
# maps baked inside. SimForge (adapters/carla-exec) only CONNECTS to an
# already-running server at SIMFORGE_CARLA_HOST:SIMFORGE_CARLA_PORT
# (default localhost:2000). Nothing in this repo packages, rebuilds, or
# redistributes CARLA or its content, and this script REFUSES to build images.
#
# What this script does, in order:
#   1. If a CARLA server already answers on host:port -> attach (report and exit 0).
#   2. Else if a stopped container named $SIMFORGE_CARLA_CONTAINER exists -> docker start it.
#   3. Else docker run the pinned user-provided image (must already be present
#      locally or pullable by YOU; we never build it) with -RenderOffscreen.
#   4. Wait for the RPC port, then ping with the python carla client if available.
#
# Env overrides:
#   SIMFORGE_CARLA_HOST       default localhost
#   SIMFORGE_CARLA_PORT       default 2000 (ports PORT..PORT+2 are published)
#   SIMFORGE_CARLA_IMAGE      default ghcr.io/simforgeinc/carla-rr-maps:0.10.0
#   SIMFORGE_CARLA_CONTAINER  default simforge-carla
#   SIMFORGE_CARLA_GPUS       default 'all' (passed to --gpus)

set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    build|--build|-b)
      echo "refused: this script never builds images. CARLA is user-provided;" >&2
      echo "run your own CARLA container (maps baked in, upstream distribution)." >&2
      exit 3
      ;;
    -h|--help)
      sed -n '2,26p' "$0"; exit 0 ;;
  esac
done

HOST="${SIMFORGE_CARLA_HOST:-localhost}"
PORT="${SIMFORGE_CARLA_PORT:-2000}"
IMAGE="${SIMFORGE_CARLA_IMAGE:-ghcr.io/simforgeinc/carla-rr-maps:0.10.0}"
NAME="${SIMFORGE_CARLA_CONTAINER:-simforge-carla}"
GPUS="${SIMFORGE_CARLA_GPUS:-all}"

port_open() {
  (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1
}

ping_server() {
  if python3 -c 'import carla' 2>/dev/null; then
    python3 - "$HOST" "$PORT" <<'PY'
import sys, carla
host, port = sys.argv[1], int(sys.argv[2])
client = carla.Client(host, port)
client.set_timeout(10.0)
print(f"carla server version: {client.get_server_version()} (client {client.get_client_version()}) at {host}:{port}")
PY
  else
    echo "python carla client not importable; TCP connect on ${HOST}:${PORT} succeeded"
  fi
}

if port_open; then
  echo "attach: CARLA server already answering on ${HOST}:${PORT}"
  ping_server
  exit 0
fi

if [ "$HOST" != "localhost" ] && [ "$HOST" != "127.0.0.1" ]; then
  echo "error: no server on ${HOST}:${PORT} and host is remote — start your CARLA container there first." >&2
  exit 2
fi

existing="$(docker ps -aq --filter "name=^${NAME}$")"
if [ -n "$existing" ]; then
  state="$(docker inspect -f '{{.State.Status}}' "$NAME")"
  if [ "$state" = "running" ]; then
    echo "container '${NAME}' is running but nothing answers on ${HOST}:${PORT} yet; waiting..."
  else
    echo "starting existing container '${NAME}' (${state})"
    docker start "$NAME" >/dev/null
  fi
else
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "error: image '${IMAGE}' is not present locally." >&2
    echo "CARLA is user-provided: pull or load YOUR CARLA distribution yourself" >&2
    echo "(e.g. docker pull ${IMAGE}), then re-run. This script never builds images." >&2
    exit 2
  fi
  echo "running '${NAME}' from user-provided image ${IMAGE} (ports ${PORT}-$((PORT+2)), -RenderOffscreen)"
  docker run -d --name "$NAME" \
    --gpus "$GPUS" \
    -p "${PORT}-$((PORT+2)):2000-2002" \
    "$IMAGE" \
    bash CarlaUnreal.sh -RenderOffscreen -nosound -carla-rpc-port=2000 >/dev/null
fi

echo -n "waiting for CARLA RPC on ${HOST}:${PORT} "
for _ in $(seq 1 60); do
  if port_open; then echo; ping_server; exit 0; fi
  echo -n .
  sleep 2
done
echo
echo "error: CARLA did not answer on ${HOST}:${PORT} within 120s — check 'docker logs ${NAME}'." >&2
exit 1
