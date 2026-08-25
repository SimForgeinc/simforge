"""Scripted Ackermann publisher for the bridge smoke test.

Clock-paced lockstep: publishes exactly ONE AckermannDriveStamped per distinct
``/clock`` value it observes (keepalive re-publishes of the same sim time are
ignored), so each command corresponds to exactly one sim decision.

Plan: ``straight_ticks`` at ``straight_speed`` with zero steering, then
``turn_ticks`` at ``turn_speed`` with ``turn_steer_rad``.  Exits after the
plan is exhausted or after ``idle_exit_s`` without a new clock (bridge gone).
"""

from __future__ import annotations

import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSProfile, QoSReliabilityPolicy

from ackermann_msgs.msg import AckermannDriveStamped
from rosgraph_msgs.msg import Clock

_RELIABLE = QoSProfile(
    depth=50,
    reliability=QoSReliabilityPolicy.RELIABLE,
    durability=QoSDurabilityPolicy.VOLATILE,
)


class SmokePublisher(Node):
    def __init__(self) -> None:
        super().__init__("simforge_smoke_publisher")
        p = self.declare_parameter
        p("control_topic", "/simforge/control/ackermann")
        p("straight_ticks", 30)
        p("straight_speed", 8.0)
        p("turn_ticks", 20)
        p("turn_speed", 6.0)
        p("turn_steer_rad", 0.35)
        p("idle_exit_s", 15.0)

        gp = lambda name: self.get_parameter(name).value  # noqa: E731
        self.straight_ticks = int(gp("straight_ticks"))
        self.straight_speed = float(gp("straight_speed"))
        self.turn_ticks = int(gp("turn_ticks"))
        self.turn_speed = float(gp("turn_speed"))
        self.turn_steer_rad = float(gp("turn_steer_rad"))
        self.idle_exit_s = float(gp("idle_exit_s"))
        self.total = self.straight_ticks + self.turn_ticks

        self.pub = self.create_publisher(AckermannDriveStamped, str(gp("control_topic")), _RELIABLE)
        self.create_subscription(Clock, "/clock", self._on_clock, _RELIABLE)

        self.sent = 0
        self.clock_values: list[int] = []  # distinct sim times, ns, in arrival order
        self._seen: set[int] = set()
        self._last_activity = time.monotonic()

    def _command_for(self, index: int) -> AckermannDriveStamped:
        msg = AckermannDriveStamped()
        if index < self.straight_ticks:
            msg.drive.speed = self.straight_speed
            msg.drive.steering_angle = 0.0
        else:
            msg.drive.speed = self.turn_speed
            msg.drive.steering_angle = self.turn_steer_rad
        return msg

    def _on_clock(self, msg: Clock) -> None:
        ns = msg.clock.sec * 1_000_000_000 + msg.clock.nanosec
        if ns in self._seen:
            return  # keepalive repeat of the same sim instant
        self._seen.add(ns)
        self.clock_values.append(ns)
        self._last_activity = time.monotonic()
        if self.sent >= self.total:
            return
        # Wait until the bridge's subscription is matched before the first send.
        if self.sent == 0:
            deadline = time.monotonic() + 10.0
            while self.pub.get_subscription_count() == 0 and time.monotonic() < deadline:
                time.sleep(0.01)
        msg_out = self._command_for(self.sent)
        stamp_ns = ns  # command is FOR the sim instant we just observed
        msg_out.header.stamp.sec = stamp_ns // 1_000_000_000
        msg_out.header.stamp.nanosec = stamp_ns % 1_000_000_000
        self.pub.publish(msg_out)
        self.sent += 1

    def done(self) -> bool:
        if self.sent >= self.total and len(self.clock_values) > self.total:
            return True  # saw the post-final-step clock; bridge is finishing
        return time.monotonic() - self._last_activity > self.idle_exit_s

    def monotonic_ok(self) -> bool:
        return all(b > a for a, b in zip(self.clock_values, self.clock_values[1:]))


def main(args: list[str] | None = None) -> int:
    rclpy.init(args=args)
    node = SmokePublisher()
    try:
        while rclpy.ok() and not node.done():
            rclpy.spin_once(node, timeout_sec=0.05)
        ok = node.monotonic_ok() and node.sent == node.total
        node.get_logger().info(
            f"smoke publisher: sent {node.sent}/{node.total} commands, "
            f"observed {len(node.clock_values)} distinct clock ticks, monotonic={node.monotonic_ok()}"
        )
        return 0 if ok else 1
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    sys.exit(main())
