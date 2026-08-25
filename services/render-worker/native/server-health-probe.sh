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

container="${1:?usage: server-health-probe.sh <server-container> <rpc-port> [gpu-lock-path] [stale-after-s]}"
port="${2:?rpc port required}"
gpu_lock="${3:-}"
# A lease never legitimately outlives the control plane's reap window, so a
# lock older than this is STALE (gpu-lock.ts dead-owner check is defeated by
# pid reuse; lock files survive worker restarts). A stale lock must not
# silently disable health probing forever: warn and probe anyway — the lease
# behind it has already expired and the job requeued, so ticking the world
# cannot corrupt a valid render.
stale_after_s="${4:-1800}"

if [ -n "$gpu_lock" ] && [ -e "$gpu_lock" ]; then
  lock_age=$(( $(date +%s) - $(stat -c %Y "$gpu_lock") ))
  if [ "$lock_age" -lt "$stale_after_s" ]; then
    echo "skip: render in progress ($gpu_lock, ${lock_age}s old)"
    exit 0
  fi
  echo "WARNING: STALE gpu.lock ($gpu_lock is ${lock_age}s old > ${stale_after_s}s) — probing anyway; investigate the lane worker" >&2
fi

NATIVE=/opt/simforge/uniscenarios-native
if "$NATIVE/venv/bin/uniscenarios-carla" --host 127.0.0.1 --port "$port" probe-ticks --ticks 60 >/dev/null 2>&1; then
  echo "healthy: $container (rpc :$port)"
  exit 0
fi

echo "UNHEALTHY: $container failed probe-ticks on :$port — restarting" >&2
docker restart "$container" >/dev/null
echo "restarted $container"
