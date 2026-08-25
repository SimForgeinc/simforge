#!/usr/bin/env python3
"""Structural bag checks for one bridge episode:

- /clock is strictly monotonic sim time with a constant decision period
- every /tf transform is finite with a normalized quaternion and matches the
  odometry pose published for the same sim instant
- topic counts are consistent (one clock/tf/odom/status per hashed frame)

Exit 0 on success; prints a summary either way.
Usage: verify_bag.py <bag_dir>
"""

from __future__ import annotations

import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from simforge_ros2_bridge.bag_io import read_bag  # noqa: E402


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    bag = sys.argv[1]
    clocks: list[int] = []
    tf_by_t: dict[int, object] = {}
    odom_by_t: dict[int, object] = {}
    counts: Counter[str] = Counter()

    for topic, msg, t_ns in read_bag(bag):
        counts[topic] += 1
        if topic == "/clock":
            clocks.append(msg.clock.sec * 1_000_000_000 + msg.clock.nanosec)
        elif topic == "/tf":
            tf_by_t[t_ns] = msg.transforms[0]
        elif topic == "/simforge/odom":
            odom_by_t[t_ns] = msg

    if len(clocks) < 2:
        fail(f"only {len(clocks)} clock messages in bag")
    deltas = {b - a for a, b in zip(clocks, clocks[1:])}
    if any(b <= a for a, b in zip(clocks, clocks[1:])):
        fail("clock is not strictly monotonic")
    if len(deltas) != 1:
        fail(f"clock period is not constant: deltas {sorted(deltas)}")

    if set(tf_by_t) != set(odom_by_t):
        fail("tf and odom sim-time stamps disagree")
    for t_ns, tf in tf_by_t.items():
        tr, q = tf.transform.translation, tf.transform.rotation
        values = (tr.x, tr.y, tr.z, q.x, q.y, q.z, q.w)
        if not all(math.isfinite(v) for v in values):
            fail(f"non-finite transform at {t_ns} ns: {values}")
        norm = math.sqrt(q.x**2 + q.y**2 + q.z**2 + q.w**2)
        if abs(norm - 1.0) > 1e-9:
            fail(f"quaternion norm {norm} at {t_ns} ns")
        if tf.header.frame_id != "map" or tf.child_frame_id != "base_link":
            fail(f"unexpected frames {tf.header.frame_id}->{tf.child_frame_id}")
        odom = odom_by_t[t_ns]
        if abs(odom.pose.pose.position.x - tr.x) > 1e-12 or abs(odom.pose.pose.position.y - tr.y) > 1e-12:
            fail(f"tf/odom pose mismatch at {t_ns} ns")

    frames = counts["/clock"]
    for name in ("/tf", "/simforge/odom", "/simforge/vehicle_status"):
        if counts[name] != frames:
            fail(f"{name} count {counts[name]} != clock count {frames}")

    period_ms = next(iter(deltas)) / 1e6
    print(f"OK: {frames} frames, clock strictly monotonic, period {period_ms:.1f} ms")
    print(f"    t: {clocks[0] / 1e9:.3f}s -> {clocks[-1] / 1e9:.3f}s; topics: {dict(counts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
