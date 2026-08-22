#!/usr/bin/env bash
# Render the W0 kill-test clip set. Each row: name instance trace weather
# Usage: render-all.sh [pov|framing]   (default pov; output root clips-<mode>)
set -uo pipefail
mode="${1:-pov}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
data=/home/path/w0-data
out="$data/clips-$mode"
render() {
  local name="$1" inst="$2" trace="$3" weather="$4"
  if [ -f "$out/$name/video.mp4" ] && [ -f "$out/$name/gt.jsonl" ]; then
    echo "[skip] $name"
    return 0
  fi
  echo "[render] $name ($weather, $mode)"
  node "$root/scripts/w0/render-clip.mjs" \
    --instance "$data/instances/$inst.json" \
    --trace "$data/traces/$trace.trace.json.gz" \
    --out "$out/$name" \
    --camera "$mode" \
    --weather "$weather" || echo "[FAIL] $name"
}

render baseline-midblock         baseline-midblock          baseline-midblock          clear
render signal-red-light          signal-red-light           signal-red-light           clear
render school-parked-row-dartout school-parked-row-dartout  school-parked-row-dartout  clear
render parked-row-dartout        parked-row-dartout         parked-row-dartout         clear
render fog-midblock              baseline-midblock          baseline-midblock          fog
render night-rain-merge          merge-gap-collapse         merge-gap-collapse         night-rain
render workzone-lane-shift       workzone-lane-shift        workzone-lane-shift        clear
render cutout-reveals-stopped    cutout-reveals-stopped     cutout-reveals-stopped     clear
render bus-stop-emergence        bus-stop-emergence         bus-stop-emergence         clear
render lane-drop-merge           lane-drop-merge            lane-drop-merge            clear
echo "[done]"
