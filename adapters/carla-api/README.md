# simforge-oss-carla-api — CARLA-compatible API facade

A thin Python `carla`-API facade so CARLA-ecosystem tools run against
SimForge **unmodified at the call sites** (`import carla` resolves to the
shim package installed next to `simforge_oss_carla_api`). There is no CARLA server
and no real carla package underneath; everything maps onto:

- **the env-server** (`packages/training-env`, framed msgpack wire protocol) for
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
cd adapters/carla-api
uv venv && uv pip install -e '.[dev]' pillow   # pillow only to decode frames
```

## Configure (instead of a CARLA host/port)

| Env var | Meaning |
|---|---|
| `SIMFORGE_EPISODES` | episode spec JSON path (`instances:` form A). Required. |
| `SIMFORGE_DEV_ASSETS` | dev-assets root holding `<map>/browser/topology-index.json.gz` |
| `SIMFORGE_STUDIO_URL` | Studio viewer URL for frame rendering (default `http://localhost:5199/`) |
| `SIMFORGE_FRAMES` | `off` disables camera frames (sensors attach but never fire) |
| `SIMFORGE_FRAME_CACHE` | cache dir for rendered clips (default `/tmp/simforge-oss-carla-api-frames`) |
| `SIMFORGE_ENV_SERVER` | override the env-server launch command |

## Example

```python
import carla

client = carla.Client("localhost", 2000)
client.set_timeout(10)
world = client.get_world()
m = world.get_map()

settings = world.get_settings(); settings.synchronous_mode = True
world.apply_settings(settings)

bp = world.get_blueprint_library().find("vehicle.simforge.car")
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
| `client.get_available_maps()` | yes | dev-assets map inventory (`<map>/bundle.json`) |
| `client.load_world` / `reload_world` | yes | NEW env-server session on that map: spec materialized from the instance catalog (+ explicit topology); optional `weather=` / `traffic=` baked into operationalConditions |
| `client.apply_batch_sync`, `start_recorder`, `stop_recorder` | no | no batch/recorder surface on this engine |
| `client.get_trafficmanager(port)` | partial | TrafficManager-shaped handle over ambient-traffic config: speed/distance globals (recorded), per-vehicle registration (stub), sync mode no-op; everything else raises `NotImplementedError`. See `simforge_oss_carla_api/trafficmanager.py` |
| `world.get_settings` / `apply_settings` | partial | synchronous mode only (determinism contract); `fixed_delta_seconds` must equal `1/decision_hz` |
| `world.tick()` / `wait_for_tick` | yes | one decision step; returns `WorldSnapshot(id, timestamp)`; async mode does not exist |
| `world.get_snapshot()` | partial | id + engine time only; no platform clock/gameplay clock split |
### Map & waypoints (backed by map-intel)


| Call | Status | Notes |
|---|---|---|
| `map.get_waypoint(location, lane_type=…)` | yes | carla-style `LaneType` flags (combinable): driving, **sidewalk**, parking… over the topology-index vocabulary |
| `map.digest` (`{mapId, xodrSha256}`) | yes | the V2X map-digest rule from the map's pinned bundle; consumers MUST refuse mismatches |
| `map.transform_to_geolocation` / `geolocation_to_transform` | yes | geo_utils.py flat-earth contract (0.10 semantics); validated against v2x-map-parity golden fixtures incl. recorded cross-frame divergence |
| `waypoint.get_left_lane` / `get_right_lane` | partial | reconstructed from the `road:section` lane row by id order (same trick as map-intel); junction rows may be incomplete |
| `map.get_spawn_points()` | partial | returns the authored scenario's spawn poses, not a full parking-lot census |
| `map.get_topology()` | partial | entry/exit pairs per driving lane from polylines |
| `map.get_waypoint_xodr(road, lane, s)` / `save_to_disk` | no | not backed yet |

### Actors

The engine is scenario-authoritative: actors exist because the episode says
so. `spawn_actor` therefore *binds* a handle to an authored actor by
`role_name`; spawning brand-new dynamic actors is not possible.

| Call | Status | Notes |
|---|---|---|
| `world.get_blueprint_library().filter/find` | yes | catalog derived from authored roles + sensor entries |
| `world.spawn_actor(bp, tf)` vehicle/walker | partial | binds to authored actor via `role_name`; `transform` ignored (engine pose wins); unknown roles raise |
| `world.try_spawn_actor` | yes | same semantics |
| `vehicle.get_physics_control()` | yes | `VehiclePhysicsControl` from sim-engine class profiles (`dynamic-v1.ts`) + per-actor `input.physics.vehicleProfiles` overrides; wheel positions in UE cm with exact longitudinal offsets (wheelbase) — see `simforge_oss_carla_api/physics.py` |
| `vehicle.set_target_velocity(v)` | yes | env-server speed intent (`targetSpeedMps`): world-frame velocity projected onto the forward axis; engine speed controller drives toward it; a queued `VehicleControl` takes precedence |
| `vehicle.set_autopilot(on, port)` | stub | recorded on the handle + TrafficManager registry; ambient road users are engine-generated, authored choreography persists |
| `walker.apply_control` | no | pedestrian motion is authored choreography |
| traffic lights (actor surface) | no | signal programs exist in-engine but have no actor surface yet |

### Sensors & rendering

| Call | Status | Notes |
|---|---|---|
| `sensor.camera.rgb` blueprint + `image_size_x/y`, `fov` attributes | partial | attributes parsed but ignored: the FrameSource renders its fixed dashcam-POV rig |
| `world.spawn_actor(cam_bp, tf, attach_to=vehicle)` | yes | attachment offset ignored (dashcam position is baked into the renderer) |
| `sensor.listen(callback)` / `stop()` / `is_listening()` / `destroy()` | yes | `SensorFrame` (PNG payload) once per tick when the frame window covers it |
| depth / semantic / instance / lidar / radar / IMU / GNSS sensors | no | arrive with the native render service (WSB3/WSB5) behind the same `FrameSource` seam |

Camera frames replay the **authored choreography** of the bound
instance/trace pair. They match env-server state exactly while the client
sends empty actions; applying controls diverges pixels from state until the
native render service can re-render closed-loop poses per tick. The demo
script runs in choreography mode for exactly this reason.

## Known limits (summary)

1. Non-ego transforms are perception-derived (range/bearing), not ground truth.
   The V1 truth-stream subscription (scene-state.v1 + signals) replaces this
   where available; the perception path remains as fallback.
2. One decision per tick at the session's `decision_hz` (default 10 Hz);
   no free-running async mode.
3. Frames cover only the rendered clip window (`--seconds ≤ 8` per render,
   cached across runs).
4. `set_weather` and TrafficManager globals are recorded state for session
   building; they do not alter live pixels or generated traffic of the
   current session.
5. Road-surface Z comes from XODR reference-line elevation profiles sampled
   at the nearest reference point (lane-lateral slope ignored).

## Verify

```sh
python examples/carla_api_demo.py      # WSB7 API flow
python examples/pure_pursuit_demo.py   # V3: physics-control pure pursuit on richmond
pytest tests -q                        # unit + real-session integration tests
```
