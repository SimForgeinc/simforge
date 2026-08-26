# simforge-ros2-bridge

ROS 2 bridge for the SimForge deterministic sim (W1): clock/TF/odometry out,
Ackermann control in, **lockstepped** with the fixed-step env-server. Pure
Python (rclpy) on ROS 2 Jazzy; no colcon build required — run straight from
this directory with a sourced ROS environment.

```
ROS 2 graph                    bridge (this package)            SimForge
─────────────                  ───────────────────────          ─────────────
/simforge/control/ackermann ─▶ lockstep loop ──── step ───────▶ simforge-env-server
/clock, /tf, /simforge/* ◀──── (1 command = 1 decision)  ◀───── (stdio, framed msgpack)
```

## Wire protocol

The bridge is a client of `simforge-env-server`
(`packages/training-env/src/env-server.ts`): length-prefixed (u32 LE)
MessagePack frames over the server's stdio; ops `hello` / `reset` / `step` /
`close`; actions ride compact keys `{ts, ta, dir, ctrl:[throttle,brake,steer]}`.
`simforge_ros2_bridge/env_client.py` mirrors
`adapters/gym/simforge_oss_gym/protocol.py` byte-for-byte but stays free of that
package's gymnasium/numpy dependencies (system-python ROS runtime only needs
`msgpack`, which ships with ROS-adjacent apt packages).

## Topics

Out (all stamped with **sim time**, decision rate = `decisionHz`, default 10 Hz):

| topic | type | content |
|---|---|---|
| `/clock` | `rosgraph_msgs/Clock` | fixed-step sim time (keepalive re-publishes the current instant while waiting for control, so late joiners sync) |
| `/tf` | `tf2_msgs/TFMessage` | `map -> base_link` from the ego state vector (xodr-local ENU, yaw from cos/sin heading) |
| `/simforge/odom` | `nav_msgs/Odometry` | pose + body twist (`linear.x` = speed, `linear.y` = lateral rate, `angular.z` = differenced yaw rate) |
| `/simforge/vehicle_status` | `std_msgs/Float64MultiArray` | the full 10-float engine state vector: x, y, cos h, sin h, speed, accel, lat offset, lat rate, route s, nearest-actor range |
| `/simforge/applied_action` | `std_msgs/String` | canonical JSON of the wire action applied each tick — the deterministic replay channel |
| `/simforge/episode` | `std_msgs/String` | begin/end events (seed, spec, ego, tick count, trace digest) |

In: `/simforge/control/ackermann` (`ackermann_msgs/AckermannDriveStamped`, the
MVP control contract).

## Lockstep

The sim advances **only** when a control command newer than the last consumed
one arrives, or the per-tick deadline (`control_timeout_s` wall seconds,
`first_command_timeout_s` for tick 0) passes. On deadline, `timeout_policy`
decides: `hold` re-applies the last action, `authored` sends an empty action
(the scenario's authored choreography drives). If several commands queue
between ticks the newest wins and the rest count as
`stale_commands_dropped`.

## Control mapping (`control_mode`)

- `passthrough` (default): `steering_angle / max_steer_rad` (× `steer_sign`)
  becomes normalized engine steer; longitudinal is `drive.acceleration` when
  nonzero, else a P loop `speed_kp * (drive.speed − current_speed)`, mapped to
  normalized throttle/brake via `max_accel_mps2` / `max_decel_mps2`. Wire form
  `{ctrl:[throttle,brake,steer]}` — the engine applies it verbatim inside its
  steer clamp/rate/lag and jerk envelope. **Requires `physics.mode:
  "dynamic-v1"`** in the scenario; kinematic-v1 ignores raw control (see the
  engine's `action-hook-determinism` test).
  Sign convention verified against dynamic-v1: positive steer = left = +yaw,
  so Ackermann's positive-left `steering_angle` maps with `steer_sign: 1.0`.
- `setpoint`: `drive.speed → ts`, nonzero `drive.acceleration → ta`; steering
  follows the authored route.

## Determinism & bags

Every episode with `bag_dir` set records all bridge topics to a rosbag2
(sqlite3) stamped with sim time. The bridge hashes each frame
(`t, reward, flags, raw state-vector bytes`, reset frame included) into a
SHA-256 **trace digest**, published in the episode `end` event and written to
`meta_path`.

`scripts/replay_assert.py <bag>` re-feeds the recorded
`/simforge/applied_action` channel into a fresh env-server session and exits 0
iff the recomputed digest equals the recorded one.
`scripts/verify_bag.py <bag>` checks clock monotonicity/period, TF validity
(finite, unit quaternion, frames) and per-topic counts.

## Running

```bash
source /opt/ros/jazzy/setup.bash
export PYTHONPATH=$PWD:$PYTHONPATH   # from adapters/ros2-bridge

# bridge (spawns the env-server itself; build it once:
#   pnpm --filter @simforge-oss/training-env... build)
python3 -m simforge_ros2_bridge.bridge_node --ros-args \
  -p episodes:=$PWD/config/episodes/synthetic-straight.episodes.json \
  -p seed:=my-seed -p bag_dir:=/tmp/sf-bridge/bag -p meta_path:=/tmp/sf-bridge/meta.json

# or via launch
ros2 launch launch/bridge.launch.py episodes:=... seed:=... bag_dir:=...
```

Full parameter reference: `config/bridge.params.yaml`.

### Smoke test

`scripts/smoke_test.sh [RUN_DIR]` runs the whole story twice (scripted
straight + one left turn via `simforge_ros2_bridge/smoke_publisher.py`,
one command per observed clock tick), verifies both bags, asserts the two
run digests are identical, and replay-asserts run 1's bag.

### Episode specs

- `config/episodes/synthetic-straight.episodes.json` — self-contained two-lane
  straight (the training-env suite's canonical fixture) with a single ego and
  `dynamic-v1` physics; regenerate with
  `pnpm exec tsx adapters/ros2-bridge/scripts/gen_fixture_episode.ts <out>`.
- `config/episodes/gold-01-belmont.episodes.json` — example map-based episode
  (edge-case-corpus gold-01 on belmont-research-center). Needs the
  training-grade map artifacts (`topology-index.json.gz` etc.) on disk:
  point `SCEN_DEV_ASSETS` at your map-bundle store (convention:
  `~/simforge-assets/map-bundles`). Repo tests skip these maps when the
  artifacts are absent; so does this config.

## Autoware vehicle interface (W2)

`simforge_ros2_bridge/autoware_bridge.py` extends the MVP node (subclass;
the Ackermann path is untouched) with the Autoware component contract so a
**stock Autoware Core control node** closes the loop. Integration level:
**controller-only** — the binary Jazzy deb `autoware_simple_pure_pursuit`
(from `ros-jazzy-autoware-core-control`, Autoware Core 1.8) consumes the
bridge's kinematic state + trajectory and publishes
`autoware_control_msgs/Control`; no perception, localization, or planning
stack runs. Objects are injected ground truth; the route (mission) is
authored by the bridge.

Additional topics (all sim-time stamped, bagged):

| dir | topic | type |
|---|---|---|
| out | `/localization/kinematic_state` | `nav_msgs/Odometry` |
| out | `/vehicle/status/velocity_status` | `autoware_vehicle_msgs/VelocityReport` |
| out | `/vehicle/status/steering_status` | `autoware_vehicle_msgs/SteeringReport` (tire angle = last applied engine steer) |
| out | `/vehicle/status/gear_status` | `autoware_vehicle_msgs/GearReport` (DRIVE) |
| out | `/perception/object_recognition/objects` | `autoware_perception_msgs/PredictedObjects` — ground-truth actors from the env-server **truth stream** (`subscribe` op), ego filtered, one constant-velocity predicted path each |
| out | `/planning/trajectory` | `autoware_planning_msgs/Trajectory` — authored route: straight, one lane-change turn, straight, stop ramp (re-published every decision so a relaunched Autoware re-syncs; bagged once) |
| in | `/control/trajectory_follower/control_cmd` | `autoware_control_msgs/Control` — converted 1:1 (rad, m/s, m/s²) to the MVP's Ackermann form and fed through the unchanged lockstep + passthrough mapping; the raw message is bagged at its decision instant |

Install (on top of the runtime install below):

```bash
sudo apt install --no-install-recommends \
  ros-jazzy-autoware-core-control ros-jazzy-autoware-control-msgs \
  ros-jazzy-autoware-vehicle-msgs ros-jazzy-autoware-perception-msgs \
  ros-jazzy-autoware-planning-msgs ros-jazzy-autoware-vehicle-info-utils \
  ros-jazzy-autoware-sample-vehicle-description ros-jazzy-autoware-global-parameter-loader
```

`scripts/autoware_episode.sh [RUN_DIR]` is the W2 end-to-end test: a healthy
episode, a **kill + relaunch of the Autoware node mid-episode** (bridge rides
`timeout_policy: hold`; outage visible as `timeouts` in the meta), and a
fresh episode after the relaunch cycle. Every run is bag-verified,
replay-asserted, and drive-checked (`scripts/check_autoware_drive.py`: lane
change completed, forward progress, Autoware commands consumed, ground-truth
objects present). Episode spec:
`config/episodes/autoware-lanechange.episodes.json` (regenerate with
`pnpm exec tsx adapters/ros2-bridge/scripts/gen_autoware_episode.ts <out>`) —
the synthetic fixture plus one parked ground-truth vehicle in the start lane
that the authored route lane-changes around.


## Runtime install (Ubuntu 24.04)

ROS 2 **Jazzy** (LTS) from the official apt repo — the boring path:

```bash
sudo apt install curl gnupg2 && sudo add-apt-repository universe
export V=$(curl -s https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | jq -r .tag_name)
curl -sLo /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${V}/ros2-apt-source_${V}.noble_all.deb"
sudo dpkg -i /tmp/ros2-apt-source.deb && sudo apt update
sudo apt install ros-jazzy-ros-base ros-jazzy-ackermann-msgs ros-jazzy-rosbag2
```

Non-goals here (later waves): full Autoware planning stack on a lanelet2 map,
sensor topics (W3).
