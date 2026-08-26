#!/usr/bin/env python3
"""Physics-control-driven pure pursuit on richmond-field-station-richmond-ca.

Exercises the V3 facade extensions end to end on a real env-server session:

- ``client.load_world("richmond-field-station-richmond-ca")`` — new session from the
  dev-assets map inventory + instance catalog;
- ``vehicle.get_physics_control()`` — wheelbase / max steer from the engine
  vehicle profiles feeding the pure-pursuit bicycle model exactly like the
  legacy bridge's trajectory_player.py;
- ``map.get_waypoint().next()`` lane-centerline reference path;
- ``world.debug.draw_line`` overlay queue recording the pursuit geometry.

Run:  .venv/bin/python examples/pure_pursuit_demo.py [max-decisions]
Prereqs: adapters/carla-api venv; a richmond instance in the catalog
(SIMFORGE_INSTANCE_DIRS or the local w0 pool).
"""

from __future__ import annotations

import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from simforge_oss_carla_api import Client, Color, Location, VehicleControl  # noqa: E402

LOOKAHEAD_GAIN, LOOKAHEAD_MIN, LOOKAHEAD_MAX = 1.5, 3.0, 15.0
TARGET_SPEED_MPS = 8.0


def build_reference_path(world, start_transform, cap: int = 600):
    """Lane centerline ahead of spawn, walked with heading continuity."""
    wp = world.get_map().get_waypoint(start_transform.location)
    path = []
    node = wp
    prev_heading = math.radians(wp.transform.rotation.yaw)
    while node is not None and len(path) < cap:
        p = node.transform.location
        path.append((p.x, p.y))
        # Branch choice must keep travel direction continuous; raw
        # waypoint.next() BFS can double back across junction lanes.
        best, best_dot = None, -2.0
        for cand in node.next(2.0) or []:
            c = cand.transform.location
            h = math.atan2(c.y - p.y, c.x - p.x)
            dot = math.cos(h - prev_heading)
            if dot > best_dot:
                best, best_dot = cand, dot
        if best is None or best_dot < math.cos(math.radians(90)):
            break
        np_ = best.transform.location
        prev_heading = math.atan2(np_.y - p.y, np_.x - p.x)
        node = best
    return wp, path


def main(decisions: int = 300) -> int:
    client = Client()
    try:
        world = client.load_world("richmond-field-station-richmond-ca")
        world.tick()  # first decision: engine state becomes readable
        digest = world.get_map().digest
        print(f"map: {world.get_map().name}  xodrSha256={digest['xodrSha256'][:16]}…")

        ego = next(a for a in world.get_actors() if a.role_name == world.ego_id)
        phys = ego.get_physics_control()
        wheelbase = phys.wheelbase_m
        max_steer_rad = phys.max_steer_angle_rad
        print(f"physics control: wheelbase={wheelbase:.2f} m  "
              f"max_steer={math.degrees(max_steer_rad):.1f} deg  "
              f"mass={phys.mass_kg:.0f} kg")

        wp, path = build_reference_path(world, ego.get_transform())
        print(f"reference path: {len(path)} points over ~{len(path) * 2} m "
              f"(road {wp.road_id}, lane {wp.lane_id})")
        arrived_at = None
        end_x, end_y = path[-1]
        progress = 0  # nearest-path-index cursor, monotonic along travel

        errors: list[float] = []
        speeds: list[float] = []
        for step in range(decisions):
            tf = ego.get_transform()
            loc, yaw = tf.location, tf.yaw_rad
            v = ego.get_velocity()
            speed = math.hypot(v.x, v.y)
            speeds.append(speed)

            if math.hypot(end_x - loc.x, end_y - loc.y) < 6.0:
                arrived_at = step
                print(f"reached path end at decision {step}")
                break

            # Advance the progress cursor, then take a point ~Ld ahead
            # ALONG the path (raw distance-to-point selection breaks once
            # the vehicle moves past early samples).
            while (progress + 1 < len(path) - 1
                   and math.hypot(path[progress + 1][0] - loc.x,
                                  path[progress + 1][1] - loc.y)
                   < math.hypot(path[progress][0] - loc.x,
                                path[progress][1] - loc.y)):
                progress += 1
            ld = max(LOOKAHEAD_MIN, min(LOOKAHEAD_MAX, LOOKAHEAD_GAIN * speed))
            tgt_i = min(progress + max(1, int(ld / 2)), len(path) - 1)
            tx, ty = path[tgt_i]
            dx, dy = tx - loc.x, ty - loc.y
            local_x = max(math.cos(yaw) * dx + math.sin(yaw) * dy, 0.5)
            local_y = -math.sin(yaw) * dx + math.cos(yaw) * dy

            steer_rad = math.atan2(2.0 * wheelbase * local_y,
                                   max(local_x * local_x + local_y * local_y, 0.25))
            steer = max(-1.0, min(1.0, steer_rad / max_steer_rad))
            speed_err = TARGET_SPEED_MPS - speed
            throttle = max(min(speed_err * 0.4, 1.0), 0.0)
            brake = max(min(-speed_err * 0.4, 1.0), 0.0)
            ego.apply_control(VehicleControl(throttle=throttle, brake=brake,
                                             steer=steer))

            world.tick()

            cte = min(math.hypot(px - ego.get_location().x,
                                 py - ego.get_location().y)
                      for px, py in path)
            errors.append(cte)

            if step % 10 == 0:  # record pursuit geometry as frontend overlay
                world.debug.draw_line(loc, Location(x=tx, y=ty, z=loc.z),
                                      thickness=0.2, color=Color(0, 128, 255))

        overlay = world.debug.consume()
        print(f"\nafter {len(errors)} tracked decisions ({world.decision_hz} Hz):")
        print(f"  final speed      : {speeds[len(errors) - 1]:.2f} m/s")
        print(f"  cross-track mean : {statistics.mean(errors):.2f} m")
        print(f"  cross-track p95  : {sorted(errors)[int(0.95 * len(errors))]:.2f} m")
        print(f"  cross-track max  : {max(errors):.2f} m")
        print(f"  debug overlay    : {len(overlay['lines'])} lines recorded "
              f"(frontends draw these)")
        ok = statistics.mean(errors) < 3.0 and speeds[len(errors) - 1] > 3.0
        print("\nRESULT:", "PASS" if ok else "FAIL",
              "(pure pursuit tracked the lane centerline using facade physics control)")
        return 0 if ok else 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 300))
