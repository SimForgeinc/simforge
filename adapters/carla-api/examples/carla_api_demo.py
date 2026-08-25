#!/usr/bin/env python3
"""CARLA-API-only demo against SimForge.

Uses ONLY the ``carla`` API surface (via the simforge-carla-api facade):
spawn the ego by role name, set autopilot off, attach an RGB camera, tick 200
synchronous steps, save 10 camera frames, and read waypoints along the route.

Prerequisites (environment, not code — like a CARLA host/port):
    export SIMFORGE_EPISODES=examples/episodes-baseline-midblock.json
    export SCEN_DEV_ASSETS=.dev-assets            # flat map-artifact layout
    # frames need a running SimForge Studio viewer (default :5199)

Run:
    .venv/bin/python examples/carla_api_demo.py
"""

from __future__ import annotations

import pathlib

import carla

OUT_DIR = pathlib.Path("/tmp/carla-compat-demo")
FRAME_SAVE_COUNT = 10
TICKS = 200


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames_dir = OUT_DIR / "frames"
    frames_dir.mkdir(exist_ok=True)

    client = carla.Client("localhost", 2000)
    client.set_timeout(10.0)
    world = client.get_world()
    carla_map = world.get_map()
    print(f"world: ego={world.ego_id!r} map={carla_map.name} "
          f"decision_hz={world.decision_hz}")

    settings = world.get_settings()
    settings.synchronous_mode = True
    settings.fixed_delta_seconds = 1.0 / world.decision_hz
    world.apply_settings(settings)

    library = world.get_blueprint_library()

    # Spawn the ego: binds to the authored metric-subject role.
    vehicle_bp = library.filter("vehicle.*")[0]
    spawn_point = carla_map.get_spawn_points()[0]
    ego = world.try_spawn_actor(vehicle_bp, spawn_point)
    ego.set_autopilot(False)
    print(f"spawned {ego.type_id} role={ego.role_name!r} at {spawn_point.location}")

    # Attach an RGB camera to the ego.
    camera_bp = library.find("sensor.camera.rgb")
    camera_bp = camera_bp.set_attribute("image_size_x", "736")
    camera_bp = camera_bp.set_attribute("image_size_y", "416")
    camera_bp = camera_bp.set_attribute("fov", "58")
    received: list[carla.SensorFrame] = []
    camera = world.spawn_actor(camera_bp, carla.Transform(
        location=carla.Location(x=0.0, y=0.0, z=1.45)), attach_to=ego)
    camera.listen(received.append)

    # Drive 200 synchronous ticks; sample waypoints every 50.
    waypoint_samples: list[str] = []
    snapshot = None
    for step in range(TICKS):
        snapshot = world.tick()
        if step % 50 == 0 or step == TICKS - 1:
            transform = ego.get_transform()
            wp = carla_map.get_waypoint(transform.location)
            nxt = wp.next(15) if wp else []
            waypoint_samples.append(
                f"t={snapshot.timestamp:5.2f}s pos=({transform.location.x:8.2f}, "
                f"{transform.location.y:9.2f}) yaw={transform.rotation.yaw:7.2f} "
                f"speed={ego.get_velocity().length():5.2f} m/s | "
                f"wp road={wp.road_id} lane={wp.lane_id} s={wp.s:7.2f} "
                f"width={wp.lane_width:.2f} next(15)={[f'{n.road_id}:{n.lane_id}' for n in nxt]}"
            )
            print(waypoint_samples[-1])

    # Save the first frames that arrived from the render path.
    for index, frame in enumerate(received[:FRAME_SAVE_COUNT]):
        frame.save_to_disk(str(frames_dir / f"frame-{index:03d}.png"))

    print(f"\ncamera frames received: {len(received)} "
          f"(rendered window via browser engine)")
    print(f"frames on disk: {sorted(p.name for p in frames_dir.glob('*.png'))}")
    assert len(received) >= FRAME_SAVE_COUNT, "camera delivered too few frames"
    assert len(frames := list(frames_dir.glob("*.png"))) >= FRAME_SAVE_COUNT

    camera.stop()
    camera.destroy()
    ego.destroy()

    print("\nOK: 200 synchronous ticks, waypoint queries, "
          f"{len(frames)} frames written to {frames_dir}")


if __name__ == "__main__":
    main()
