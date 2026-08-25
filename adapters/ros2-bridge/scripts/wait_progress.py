#!/usr/bin/env python3
"""Block until the live ego odometry crosses an x threshold, then exit 0.

Used by autoware_episode.sh to time the mid-episode Autoware kill off actual
episode progress instead of wall-clock sleeps.

Usage: wait_progress.py <x_threshold> [--topic /simforge/odom] [--timeout 120]
"""

from __future__ import annotations

import argparse
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSProfile, QoSReliabilityPolicy

from nav_msgs.msg import Odometry

_RELIABLE = QoSProfile(
    depth=50,
    reliability=QoSReliabilityPolicy.RELIABLE,
    durability=QoSDurabilityPolicy.VOLATILE,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("threshold", type=float)
    parser.add_argument("--topic", default="/simforge/odom")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    rclpy.init()
    node = Node("simforge_wait_progress")
    hit = {"x": None}

    def on_odom(msg: Odometry) -> None:
        if msg.pose.pose.position.x >= args.threshold:
            hit["x"] = msg.pose.pose.position.x

    node.create_subscription(Odometry, args.topic, on_odom, _RELIABLE)
    deadline = time.monotonic() + args.timeout
    try:
        while hit["x"] is None:
            if time.monotonic() >= deadline:
                print(f"timeout waiting for x >= {args.threshold}", file=sys.stderr)
                return 1
            rclpy.spin_once(node, timeout_sec=0.1)
        print(f"progress: x = {hit['x']:.2f} >= {args.threshold}")
        return 0
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    sys.exit(main())
