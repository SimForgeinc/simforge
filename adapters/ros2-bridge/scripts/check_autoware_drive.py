#!/usr/bin/env python3
"""Evidence check for one Autoware-driven episode bag.

Asserts that the AUTOWARE side actually drove the SimForge ego through the
authored route (straight + one lane-change turn on the synthetic fixture):

- Autoware Control commands were consumed (bagged raw at decision instants)
- the ego started in the left lane (y ~ 0) and ended in the right lane
  (y < -3.0) — the "one turn"
- the ego made forward progress past the parked ground-truth object
- ground-truth PredictedObjects were published with the parked car in them

Usage: check_autoware_drive.py <bag_dir> [--min-final-x 230] [--npc-x 185.07]
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from simforge_ros2_bridge.bag_io import read_bag  # noqa: E402


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bag")
    parser.add_argument("--min-final-x", type=float, default=230.0)
    parser.add_argument("--npc-x", type=float, default=185.07)
    parser.add_argument("--control-topic", default="/control/trajectory_follower/control_cmd")
    args = parser.parse_args()

    poses: list[tuple[float, float, float]] = []  # (x, y, speed)
    controls = 0
    steer_min = math.inf
    steer_max = -math.inf
    objects_msgs = 0
    npc_seen = 0

    for topic, msg, _t_ns in read_bag(args.bag):
        if topic == "/simforge/odom":
            poses.append((msg.pose.pose.position.x, msg.pose.pose.position.y, msg.twist.twist.linear.x))
        elif topic == args.control_topic:
            controls += 1
            steer_min = min(steer_min, msg.lateral.steering_tire_angle)
            steer_max = max(steer_max, msg.lateral.steering_tire_angle)
        elif topic == "/perception/object_recognition/objects":
            objects_msgs += 1
            npc_seen += sum(1 for _ in msg.objects)

    if not poses:
        fail("no /simforge/odom in bag")
    x0, y0, _ = poses[0]
    x1, y1, v1 = poses[-1]
    min_npc_gap = min(math.hypot(x - args.npc_x, y) for x, y, _ in poses)
    top_speed = max(v for _, _, v in poses)

    print(f"poses: {len(poses)}; start ({x0:.2f},{y0:.2f}) -> end ({x1:.2f},{y1:.2f}) v_end {v1:.2f} m/s")
    print(f"autoware control cmds consumed: {controls}; steer range [{steer_min:.4f}, {steer_max:.4f}] rad")
    print(f"objects msgs: {objects_msgs}; ground-truth objects total: {npc_seen}")
    print(f"top speed {top_speed:.2f} m/s; min distance to parked npc {min_npc_gap:.2f} m")

    if controls < 50:
        fail(f"only {controls} Autoware control commands consumed")
    if abs(y0) > 0.5:
        fail(f"ego did not start in the left lane (y0={y0:.2f})")
    if y1 > -3.0:
        fail(f"ego did not finish the lane change (y1={y1:.2f})")
    if x1 < args.min_final_x:
        fail(f"ego made too little progress (x1={x1:.2f} < {args.min_final_x})")
    if steer_min >= 0.0:
        fail("no right-steer excursion recorded — the turn never happened")
    if objects_msgs < 50 or npc_seen < 50:
        fail("ground-truth PredictedObjects channel looks empty")
    if min_npc_gap < 2.5:
        fail(f"ego passed the parked npc too close ({min_npc_gap:.2f} m center-to-center)")

    print("AUTOWARE DRIVE CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
