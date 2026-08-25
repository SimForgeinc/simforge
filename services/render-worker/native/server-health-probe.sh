#!/usr/bin/env bash
# Engine-server RPC-liveness probe with fail-fast restart (host-side).
# Uses the bridge's `probe-ticks` (verifies the synchronous tick barrier and
# actor spawn/destroy — exactly the path that degrades with server uptime and
# otherwise wedges renders for a full 18-min lease).
#
#   server-health-probe.sh <server-container> <rpc-port> [gpu-lock-path]
#
# SAFETY: probe-ticks populates and ticks the world, so it MUST NOT run while
# a render holds the lane. If a gpu-lock path is given and the lock exists,
# the probe is skipped (exit 0). Wire as a systemd timer per lane, e.g.:
#   OnUnitInactiveSec=10min uniscenarios-server-health@carla-0.service
# Restart on failure is the proven remedy (workers reconnect per job).
set -euo pipefail

container="${1:?usage: server-health-probe.sh <server-container> <rpc-port> [gpu-lock-path]}"
port="${2:?rpc port required}"
gpu_lock="${3:-}"

if [ -n "$gpu_lock" ] && [ -e "$gpu_lock" ]; then
  echo "skip: render in progress ($gpu_lock present)"
  exit 0
fi

NATIVE=/opt/simforge/uniscenarios-native
if "$NATIVE/venv/bin/uniscenarios-carla" --host 127.0.0.1 --port "$port" probe-ticks --ticks 60 >/dev/null 2>&1; then
  echo "healthy: $container (rpc :$port)"
  exit 0
fi

echo "UNHEALTHY: $container failed probe-ticks on :$port — restarting" >&2
docker restart "$container" >/dev/null
echo "restarted $container"
