# uniscenarios-carla — CARLA-compatible API facade

A thin Python `carla`-API facade so CARLA-ecosystem tools run against
UniScenarios **unmodified at the call sites** (`import carla` resolves to the
shim package installed next to `uniscenarios_carla`). There is no CARLA server
and no real carla package underneath; everything maps onto:

- **the env-server** (`packages/rl-env`, framed msgpack wire protocol) for
  world state and stepping — `world.tick()` is one engine decision;
- **map-intel data** (`dev-assets/<mapId>/browser/topology-index.json.gz`,
  the same TopologyIndex the TS `LaneGraph` consumes) for `Map`/`Waypoint`
  queries;
- **the browser render path** (`scripts/w0/render-clip.mjs`, the W0 ego-dashcam
  POV clip renderer driven against a Studio three.js viewer) for camera
  frames, behind one `FrameSource` seam that the native render service
  (WSB5) will slot into later.

## Install

```sh
cd adapters/carla-compat
uv venv && uv pip install -e '.[dev]' pillow   # pillow only to decode frames
```

## Configure (instead of a CARLA host/port)

| Env var | Meaning |
|---|---|
| `UNISCENARIO_EPISODES` | episode spec JSON path (`instances:` form A). Required. |
| `UNISCENARIO_DEV_ASSETS` | dev-assets root holding `<map>/browser/topology-index.json.gz` |
| `UNISCENARIO_STUDIO_URL` | Studio viewer URL for frame rendering (default `http://localhost:5199/`) |
| `UNISCENARIO_FRAMES` | `off` disables camera frames (sensors attach but never fire) |
| `UNISCENARIO_FRAME_CACHE` | cache dir for rendered clips (default `/tmp/uniscenarios-carla-frames`) |
| `UNISCENARIO_ENV_SERVER` | override the env-server launch command |

## Example

```python
import carla

client = carla.Client("localhost", 2000)
client.set_timeout(10)
world = client.get_world()
m = world.get_map()

settings = world.get_settings(); settings.synchronous_mode = True
world.apply_settings(settings)

bp = world.get_blueprint_library().find("vehicle.uniscenarios.car")
ego = world.spawn_actor(bp, m.get_spawn_points()[0])
cam_bp = world.get_blueprint_library().find("sensor.camera.rgb")
cam = world.spawn_actor(cam_bp, carla.Transform(), attach_to=ego)
cam.listen(lambda img: img.save_to_disk(f"/tmp/frames/{img.frame if hasattr(img,'frame') else len(frames)}.png"))

wp = m.get_waypoint(ego.get_location())
for step in range(200):
    snap = world.tick()
    nxt = wp.next(10)
    ...
```

A complete runnable flow lives in `examples/carla_api_demo.py`.

## Coverage matrix

Legend: **yes** = faithfully backed · **partial** = works with documented
divergence/approximation · **stub** = accepted but inert · **no** = raises
`NotImplementedError`/`RuntimeError`.

### Connection & lifecycle

| Call | Status | Notes |
|---|---|---|
| `carla.Client(host, port)` | yes | args accepted; transport is the spawned env-server subprocess |
| `client.get_world()` | yes | one env-server session per World |
| `client.set_timeout()` | stub | requests are synchronous request/reply |
| `client.get_server_version` / `get_client_version` | yes | reports facade + protocol version |
| `client.load_world` / `reload_world` | no | engine serves exactly its authored episodes; point the spec elsewhere |
| `client.apply_batch_sync`, `get_trafficmanager`, `start_recorder`, `stop_recorder` | no | no batch/traffic-manager/recorder surface on this engine |
| `world.get_settings` / `apply_settings` | partial | synchronous mode only (determinism contract); `fixed_delta_seconds` must equal `1/decision_hz` |
| `world.tick()` / `wait_for_tick` | yes | one decision step; returns `WorldSnapshot(id, timestamp)`; async mode does not exist |
| `world.get_snapshot()` | partial | id + engine time only; no platform clock/gameplay clock split |

### Map & waypoints (backed by map-intel)

| Call | Status | Notes |
|---|---|---|
| `world.get_map()` | yes | `Map(name=<mapId>)` over `topology-index.json.gz` |
| `map.get_waypoint(location)` | yes | grid-accelerated nearest driving lane; travel-order polylines (positive-id lanes flipped per map-intel rule; junction-gate refinement NOT ported) |
| `waypoint.next(d)` / `previous(d)` | yes | BFS over travel successors/predecessors; branching emits extra waypoints but continues only along the first branch |
| `waypoint.transform`, `road_id`, `section_id`, `lane_id`, `s`, `lane_width`, `is_junction`, `lane_type` | yes | widths interpolated from `widthSamples`; `s` is travel-ordered arc length (not OpenDRIVE s) |
| `waypoint.get_left_lane` / `get_right_lane` | partial | reconstructed from the `road:section` lane row by id order (same trick as map-intel); junction rows may be incomplete |
| `map.get_spawn_points()` | partial | returns the authored scenario's spawn poses, not a full parking-lot census |
| `map.get_topology()` | partial | entry/exit pairs per driving lane from polylines |
| `map.get_waypoint_xodr(road, lane, s)` | no | not backed yet |
| `map.save_to_disk(.xodr)` / OpenDRIVE export | no | source `.xodr` exists in dev-assets but no export surface here |

### Actors

The engine is scenario-authoritative: actors exist because the episode says
so. `spawn_actor` therefore *binds* a handle to an authored actor by
`role_name`; spawning brand-new dynamic actors is not possible.

| Call | Status | Notes |
|---|---|---|
| `world.get_blueprint_library().filter/find` | yes | catalog derived from authored roles + sensor entries |
| `world.spawn_actor(bp, tf)` vehicle/walker | partial | binds to authored actor via `role_name`; `transform` ignored (engine pose wins); unknown roles raise |
| `world.try_spawn_actor` | yes | same semantics |
| `actor.id`, `type_id`, `attributes`, `is_alive`, `destroy()` | yes | `destroy` detaches the handle only |
| `vehicle.get_transform/get_location` (ego) | yes | from the fixed 10-float state vector: x, y, cos/sin(heading), speed, accel |
| `vehicle.get_transform` (non-ego) | partial | reconstructed from perception objects (range/bearing → position; heading from finite difference; z always 0). Unperceived actors raise; occluded-but-present actors disappear from this view |
| `vehicle.get_velocity/get_acceleration` | partial | ego exact; non-ego derived as above |
| `vehicle.get_angular_velocity`, `bounding_box`, `semantic_tags` | no | not exposed by the protocol |
| `vehicle.apply_control(VehicleControl)` | yes | throttle/steer/brake pass through `EnvAction.ctrl` into the force-based backend inside its clamp/rate/jerk envelope; hand brake, gears, reverse are dropped |
| `vehicle.set_autopilot(on/off)` | stub | recorded on the handle; the engine keeps authored choreography unless overridden by controls. With autopilot "off" and no queued control, ticks send empty actions |
| `walker.apply_control` | no | pedestrian motion is authored choreography |
| traffic lights (`get_actors().filter('traffic.*')`, light state changes) | no | signal programs exist in-engine but have no actor surface yet |

### Sensors & rendering

| Call | Status | Notes |
|---|---|---|
| `sensor.camera.rgb` blueprint + `image_size_x/y`, `fov` attributes | partial | attributes parsed but ignored: the FrameSource renders its fixed dashcam-POV rig; the live Studio layout currently yields a 376×374 canvas (736×416 requested) |
| `world.spawn_actor(cam_bp, tf, attach_to=vehicle)` | yes | attachment offset ignored (dashcam position is baked into the renderer) |
| `sensor.listen(callback)` | yes | callback receives `SensorFrame` (PNG payload; `.to_array()`, `save_to_disk`) once per tick when the frame window covers it |
| `sensor.stop()`, `is_listening()`, `destroy()` | yes | |
| depth / semantic / instance / lidar / radar / IMU / GNSS sensors | no | arrive with the native render service (WSB3/WSB5) behind the same `FrameSource` seam |
| `world.set_weather` / `get_weather` | no | weather is an episode field, not a runtime setter |

Camera frames replay the **authored choreography** of the bound
instance/trace pair. They match env-server state exactly while the client
sends empty actions; applying controls diverges pixels from state until the
native render service can re-render closed-loop poses per tick. The demo
script runs in choreography mode for exactly this reason.

## Known limits (summary)

1. 2-D world: z is always 0; rotations carry yaw only.
2. Non-ego transforms are perception-derived (range/bearing), not ground truth.
3. One decision per tick at the session's `decision_hz` (default 10 Hz);
   there is no free-running async mode.
4. Frames cover only the rendered clip window (`--seconds ≤ 8` per render,
   cached across runs).
5. No new actors, no despawn, no traffic-light actor surface.

## Verify

```sh
examples/carla_api_demo.py   # see header comment for prerequisites
pytest tests -q
```
