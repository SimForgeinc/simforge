#!/usr/bin/env bash
# Engine-server RPC-liveness probe with fail-fast restart (host-side).
# Uses the bridge's `probe-ticks` (verifies the synchronous tick barrier and
# actor spawn/destroy — exactly the path that degrades with server uptime and
# otherwise wedges renders for a full 18-min lease).
#
#   server-health-probe.sh <server-container> <rpc-port> [gpu-lock-path] [stale-after-s] [render-proc-pattern]
#
# SAFETY: probe-ticks populates and ticks the world, so it MUST NOT run while
# a render holds the lane. Two host-local gates, both must clear:
#   1. Process state (the strong invariant): skip while any live render
#      subprocess matches [render-proc-pattern] (default
#      'uniscenarios-carla.*run-intent'). Immune to wall-time growth and to
#      stale locks; conservatively over-gates across co-hosted lanes, which
#      only delays probing.
#   2. gpu.lock freshness: skip while a given lock is younger than
#      [stale-after-s]. The lock mtime is written ONCE at acquisition and
#      never refreshed, and real attempts have run 29 min under load, so the
#      default is 3600 s — a too-long window merely delays probing, a
#      too-short one would tick a world mid-render. An older lock is STALE
#      (gpu-lock.ts dead-owner check is defeated by pid reuse; lock files
#      survive worker restarts): warn loudly and probe anyway so a stale lock
#      can never silently disable health probing.
# Wire as a systemd timer per lane, e.g.:
#   OnUnitInactiveSec=10min uniscenarios-server-health@carla-0.service
# Restart on failure is the proven remedy (workers reconnect per job).
set -euo pipefail

container="${1:?usage: server-health-probe.sh <server-container> <rpc-port> [gpu-lock-path] [stale-after-s] [render-proc-pattern]}"
port="${2:?rpc port required}"
gpu_lock="${3:-}"
stale_after_s="${4:-3600}"
render_pattern="${5:-uniscenarios-carla.*run-intent}"

# pgrep -f matches full cmdlines, including THIS probe's own argv (the
# pattern is one of its arguments) — exclude self and parent.
live_renders="$(pgrep -f "$render_pattern" | grep -vE "^($$|$PPID)\$" || true)"
if [ -n "$live_renders" ]; then
  echo "skip: live render subprocess matches '$render_pattern' (pids: $(echo "$live_renders" | tr '\n' ' '))"
  exit 0
fi

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
