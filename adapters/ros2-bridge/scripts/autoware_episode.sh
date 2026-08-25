#!/usr/bin/env bash
# End-to-end Autoware W2 test: a stock Autoware Core control node
# (autoware_simple_pure_pursuit, binary Jazzy deb) drives the SimForge ego
# through the lockstep bridge on the synthetic fixture.
#
#   run1  healthy episode: bag structure, replay-assert digest, drive evidence
#   run2  kill the Autoware node MID-EPISODE, relaunch it, episode completes:
#         timeouts>0 proves the outage, bag still replay-asserts (no
#         corruption), the relaunched controller finishes the route
#   run3  fresh episode after the relaunch cycle: clean session, digest
#         replay-asserts, drive evidence again
#
# The Autoware node is launched exactly as the stock
# simple_pure_pursuit.launch.xml wires it (same param files, same remaps) but
# exec'd directly so kill/relaunch is a single-process affair.
#
# Usage: autoware_episode.sh [RUN_DIR]   (default /tmp/sf-autoware/episode)
set -eo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${1:-/tmp/sf-autoware/episode}"
EPISODES="$ADAPTER_DIR/config/episodes/autoware-lanechange.episodes.json"
MAX_TICKS=300  # 30 s at 10 Hz — the episode's full clip

PP_EXE=/opt/ros/jazzy/lib/autoware_simple_pure_pursuit/autoware_simple_pure_pursuit_exe
PP_PARAMS=/opt/ros/jazzy/share/autoware_simple_pure_pursuit/config/simple_pure_pursuit.param.yaml
VEHICLE_INFO=/opt/ros/jazzy/share/autoware_vehicle_info_utils/config/vehicle_info.param.yaml

# shellcheck disable=SC1091
source /opt/ros/jazzy/setup.bash
set -u
export PYTHONPATH="$ADAPTER_DIR:${PYTHONPATH:-}"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-53}"
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

PP_PID=""

launch_autoware() {
  local log="$1"
  "$PP_EXE" --ros-args \
    -r __node:=simple_pure_pursuit \
    --params-file "$PP_PARAMS" \
    --params-file "$VEHICLE_INFO" \
    -r "~/input/odometry:=/localization/kinematic_state" \
    -r "~/input/trajectory:=/planning/trajectory" \
    -r "~/output/control_command:=/control/trajectory_follower/control_cmd" \
    >>"$log" 2>&1 &
  PP_PID=$!
}

stop_autoware() {
  if [[ -n "$PP_PID" ]] && kill -0 "$PP_PID" 2>/dev/null; then
    kill "$PP_PID" 2>/dev/null || true
    wait "$PP_PID" 2>/dev/null || true
  fi
  PP_PID=""
}
trap stop_autoware EXIT

start_bridge() {
  local dir="$1" seed="$2"
  python3 -m simforge_ros2_bridge.autoware_bridge --ros-args \
    -p "episodes:=$EPISODES" \
    -p "seed:=$seed" \
    -p "max_ticks:=$MAX_TICKS" \
    -p "control_mode:=passthrough" \
    -p "control_timeout_s:=2.0" \
    -p "bag_dir:=$dir/bag" \
    -p "meta_path:=$dir/meta.json" \
    >"$dir/bridge.log" 2>&1 &
  BRIDGE_PID=$!
}

check_run() {
  local dir="$1"
  python3 "$ADAPTER_DIR/scripts/verify_bag.py" "$dir/bag"
  python3 "$ADAPTER_DIR/scripts/replay_assert.py" "$dir/bag"
  python3 "$ADAPTER_DIR/scripts/check_autoware_drive.py" "$dir/bag"
}

echo "== run1: healthy Autoware-driven episode =="
mkdir -p "$RUN_DIR/run1"
launch_autoware "$RUN_DIR/run1/autoware.log"
sleep 2
start_bridge "$RUN_DIR/run1" autoware-w2
wait "$BRIDGE_PID"
stop_autoware
check_run "$RUN_DIR/run1"

echo "== run2: kill + relaunch Autoware mid-episode =="
mkdir -p "$RUN_DIR/run2"
launch_autoware "$RUN_DIR/run2/autoware.log"
sleep 2
start_bridge "$RUN_DIR/run2" autoware-w2-relaunch
python3 "$ADAPTER_DIR/scripts/wait_progress.py" 100 --timeout 120   # mid-route, before the turn
echo "-- killing Autoware node (pid $PP_PID) mid-episode"
stop_autoware
sleep 5                       # bridge rides timeout_policy=hold (2 s deadline per tick)
echo "-- relaunching Autoware node"
launch_autoware "$RUN_DIR/run2/autoware.log"
wait "$BRIDGE_PID"
stop_autoware
check_run "$RUN_DIR/run2"
TIMEOUTS=$(jq -r .timeouts "$RUN_DIR/run2/meta.json")
TICKS=$(jq -r .ticks "$RUN_DIR/run2/meta.json")
echo "run2: ticks=$TICKS timeouts=$TIMEOUTS (outage visible, episode completed)"
if [[ "$TIMEOUTS" -lt 1 ]]; then
  echo "FAIL: expected >=1 control timeout during the Autoware outage" >&2
  exit 1
fi

echo "== run3: fresh episode after the relaunch cycle (clean session) =="
mkdir -p "$RUN_DIR/run3"
launch_autoware "$RUN_DIR/run3/autoware.log"
sleep 2
start_bridge "$RUN_DIR/run3" autoware-w2
wait "$BRIDGE_PID"
stop_autoware
check_run "$RUN_DIR/run3"

echo
echo "run1 digest: $(jq -r .digest "$RUN_DIR/run1/meta.json")"
echo "run2 digest: $(jq -r .digest "$RUN_DIR/run2/meta.json") (timeouts=$TIMEOUTS)"
echo "run3 digest: $(jq -r .digest "$RUN_DIR/run3/meta.json")"
echo "AUTOWARE EPISODE TEST PASSED"
