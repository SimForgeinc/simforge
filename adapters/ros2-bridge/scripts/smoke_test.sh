#!/usr/bin/env bash
# End-to-end smoke test for the SimForge ROS 2 bridge.
#
# Two identical lockstep runs (scripted straight + one left turn), then:
#   1. bag structure checks per run (clock monotonic, TF valid, counts)
#   2. digest equality across the two runs (byte-stable sim trace)
#   3. replay assert: recorded action channel re-fed into a fresh env-server
#      session must reproduce the recorded digest
#
# Usage: smoke_test.sh [RUN_DIR]   (default /tmp/sf-ros2-smoke)
set -eo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${1:-/tmp/sf-ros2-smoke}"
EPISODES="$ADAPTER_DIR/config/episodes/synthetic-straight.episodes.json"
STRAIGHT_TICKS=30
TURN_TICKS=20
TOTAL_TICKS=$((STRAIGHT_TICKS + TURN_TICKS))

# ROS setup scripts are not nounset-clean; source before enabling -u.
# shellcheck disable=SC1091
source /opt/ros/jazzy/setup.bash
set -u
export PYTHONPATH="$ADAPTER_DIR:${PYTHONPATH:-}"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-47}"
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

run_once() {
  local name="$1"
  local dir="$RUN_DIR/$name"
  mkdir -p "$dir"
  echo "== $name =="
  python3 -m simforge_ros2_bridge.bridge_node --ros-args \
    -p "episodes:=$EPISODES" \
    -p "seed:=smoke" \
    -p "max_ticks:=$TOTAL_TICKS" \
    -p "control_mode:=passthrough" \
    -p "bag_dir:=$dir/bag" \
    -p "meta_path:=$dir/meta.json" \
    >"$dir/bridge.log" 2>&1 &
  local bridge_pid=$!
  python3 -m simforge_ros2_bridge.smoke_publisher --ros-args \
    -p "straight_ticks:=$STRAIGHT_TICKS" \
    -p "turn_ticks:=$TURN_TICKS" \
    >"$dir/publisher.log" 2>&1 &
  local pub_pid=$!
  wait "$bridge_pid"
  wait "$pub_pid"
  python3 "$ADAPTER_DIR/scripts/verify_bag.py" "$dir/bag"
}

run_once run1
run_once run2

d1=$(jq -r .digest "$RUN_DIR/run1/meta.json")
d2=$(jq -r .digest "$RUN_DIR/run2/meta.json")
echo "run1 digest: $d1"
echo "run2 digest: $d2"
if [[ "$d1" != "$d2" ]]; then
  echo "FAIL: digests differ across identical runs" >&2
  exit 1
fi
echo "OK: digests identical across two runs"

echo "== replay assert (run1 bag) =="
python3 "$ADAPTER_DIR/scripts/replay_assert.py" "$RUN_DIR/run1/bag"

echo "SMOKE TEST PASSED"
