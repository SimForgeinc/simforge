"""SimForge ROS 2 bridge node — deterministic lockstep between sim and ROS.

Out (all stamped with sim time):
- ``/clock``                      rosgraph_msgs/Clock       fixed-step sim time
- ``/tf``                         tf2_msgs/TFMessage        map -> base_link
- ``/simforge/odom``              nav_msgs/Odometry         pose + body twist
- ``/simforge/vehicle_status``    std_msgs/Float64MultiArray  full 10-float
  engine state vector (x, y, cos h, sin h, speed, accel, lat offset,
  lat rate, route s, nearest-actor range)
- ``/simforge/applied_action``    std_msgs/String            canonical JSON of
  the wire action applied at each tick (the deterministic replay channel)
- ``/simforge/episode``           std_msgs/String            begin/end events
  (seed, spec, tick count, trace digest)

In:
- ``<control_topic>``  ackermann_msgs/AckermannDriveStamped (MVP contract)

Lockstep: the sim advances ONLY when a control command newer than the last
consumed one arrives, or the per-tick deadline (``control_timeout_s`` wall
seconds) passes — in which case the ``timeout_policy`` decides what is
applied (``hold`` = repeat last action, ``authored`` = empty action, i.e.
the scenario's authored choreography).
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSProfile, QoSReliabilityPolicy

from ackermann_msgs.msg import AckermannDriveStamped
from builtin_interfaces.msg import Time as TimeMsg
from geometry_msgs.msg import TransformStamped
from nav_msgs.msg import Odometry
from rosgraph_msgs.msg import Clock
from std_msgs.msg import Float64MultiArray, String
from tf2_msgs.msg import TFMessage

from .bag_io import BagWriter
from .env_client import EnvServerClient, StepFrame, default_server_command
from .trace import TraceDigest, canonical_action_json

_RELIABLE = QoSProfile(
    depth=50,
    reliability=QoSReliabilityPolicy.RELIABLE,
    durability=QoSDurabilityPolicy.VOLATILE,
)


def _sim_time(t_s: float) -> TimeMsg:
    ns = round(t_s * 1e9)
    return TimeMsg(sec=ns // 1_000_000_000, nanosec=ns % 1_000_000_000)


def _sim_time_ns(t_s: float) -> int:
    return round(t_s * 1e9)


def _yaw_quat(yaw: float) -> tuple[float, float, float, float]:
    half = 0.5 * yaw
    return (0.0, 0.0, math.sin(half), math.cos(half))


def _wrap_pi(a: float) -> float:
    return (a + math.pi) % (2.0 * math.pi) - math.pi


class SimForgeBridge(Node):
    def __init__(self) -> None:
        super().__init__("simforge_bridge")

        p = self.declare_parameter
        p("episodes", "")
        p("seed", "ros2-bridge")
        p("session", 0)
        p("control_topic", "/simforge/control/ackermann")
        p("control_timeout_s", 2.0)
        p("first_command_timeout_s", 30.0)
        p("timeout_policy", "hold")  # hold | authored
        p("max_ticks", 0)  # 0 = run to termination/truncation
        p("control_mode", "passthrough")  # passthrough | setpoint
        p("max_steer_rad", 0.6)
        p("steer_sign", 1.0)  # multiplies Ackermann angle into engine steer
        p("speed_kp", 1.2)
        p("max_accel_mps2", 3.0)
        p("max_decel_mps2", 6.0)
        p("frame_map", "map")
        p("frame_base", "base_link")
        p("bag_dir", "")
        p("meta_path", "")
        p("clock_keepalive_s", 0.25)

        gp = lambda name: self.get_parameter(name).value  # noqa: E731
        self.episodes = str(gp("episodes"))
        if not self.episodes:
            raise RuntimeError("parameter 'episodes' (episode spec JSON path) is required")
        self.seed = str(gp("seed"))
        self.session = int(gp("session"))
        self.control_timeout_s = float(gp("control_timeout_s"))
        self.first_command_timeout_s = float(gp("first_command_timeout_s"))
        self.timeout_policy = str(gp("timeout_policy"))
        if self.timeout_policy not in ("hold", "authored"):
            raise RuntimeError(f"timeout_policy must be hold|authored, got {self.timeout_policy!r}")
        self.max_ticks = int(gp("max_ticks"))
        self.control_mode = str(gp("control_mode"))
        if self.control_mode not in ("passthrough", "setpoint"):
            raise RuntimeError(f"control_mode must be passthrough|setpoint, got {self.control_mode!r}")
        self.max_steer_rad = float(gp("max_steer_rad"))
        self.steer_sign = float(gp("steer_sign"))
        self.speed_kp = float(gp("speed_kp"))
        self.max_accel = float(gp("max_accel_mps2"))
        self.max_decel = float(gp("max_decel_mps2"))
        self.frame_map = str(gp("frame_map"))
        self.frame_base = str(gp("frame_base"))
        self.bag_dir = str(gp("bag_dir"))
        self.meta_path = str(gp("meta_path"))
        self.clock_keepalive_s = float(gp("clock_keepalive_s"))

        self.pub_clock = self.create_publisher(Clock, "/clock", _RELIABLE)
        self.pub_tf = self.create_publisher(TFMessage, "/tf", _RELIABLE)
        self.pub_odom = self.create_publisher(Odometry, "/simforge/odom", _RELIABLE)
        self.pub_status = self.create_publisher(Float64MultiArray, "/simforge/vehicle_status", _RELIABLE)
        self.pub_action = self.create_publisher(String, "/simforge/applied_action", _RELIABLE)
        self.pub_episode = self.create_publisher(String, "/simforge/episode", _RELIABLE)

        self._pending: list[AckermannDriveStamped] = []
        self._stale_dropped = 0
        self.create_subscription(
            AckermannDriveStamped, str(gp("control_topic")), self._on_control, _RELIABLE
        )

        self._bag: BagWriter | None = None
        if self.bag_dir:
            self._bag = BagWriter(self.bag_dir)
            for name, type_name in (
                ("/clock", "rosgraph_msgs/msg/Clock"),
                ("/tf", "tf2_msgs/msg/TFMessage"),
                ("/simforge/odom", "nav_msgs/msg/Odometry"),
                ("/simforge/vehicle_status", "std_msgs/msg/Float64MultiArray"),
                ("/simforge/applied_action", "std_msgs/msg/String"),
                ("/simforge/control/ackermann", "ackermann_msgs/msg/AckermannDriveStamped"),
                ("/simforge/episode", "std_msgs/msg/String"),
            ):
                self._bag.create_topic(name, type_name)

        self._digest = TraceDigest()
        self._prev_yaw: float | None = None
        self._last_action: dict[str, Any] = {}

    # ----------------------------------------------------------- subclass hooks
    #
    # The Autoware module (autoware_bridge.py) extends the MVP through these
    # two seams; the Ackermann path itself is unchanged.

    def _make_client(self, spec_path: Path) -> EnvServerClient:
        """Env-server client factory (subclasses may return an extended client)."""
        return EnvServerClient(default_server_command(spec_path))

    def _publish_extra_state(
        self,
        frame: StepFrame,
        stamp: TimeMsg,
        t_ns: int,
        yaw: float,
        quat: tuple[float, float, float, float],
        yaw_rate: float,
    ) -> None:
        """Called at the end of every ``_publish_state`` (reset frame included)."""

    # ------------------------------------------------------------- control in

    def _on_control(self, msg: AckermannDriveStamped) -> None:
        self._pending.append(msg)

    def _wait_for_command(self, timeout_s: float) -> AckermannDriveStamped | None:
        """Block (spinning) until a fresh command arrives or the deadline passes."""
        deadline = time.monotonic() + timeout_s
        last_keepalive = time.monotonic()
        while not self._pending:
            now = time.monotonic()
            if now >= deadline:
                return None
            if now - last_keepalive >= self.clock_keepalive_s:
                # Re-announce current sim time so late-joining publishers sync.
                self.pub_clock.publish(Clock(clock=_sim_time(self._t)))
                last_keepalive = now
            rclpy.spin_once(self, timeout_sec=min(0.02, deadline - now))
        if len(self._pending) > 1:
            self._stale_dropped += len(self._pending) - 1
        latest = self._pending[-1]
        self._pending.clear()
        return latest

    # --------------------------------------------------------- action mapping

    def _map_command(self, msg: AckermannDriveStamped) -> dict[str, Any]:
        drive = msg.drive
        if self.control_mode == "setpoint":
            action: dict[str, Any] = {"ts": float(drive.speed)}
            if drive.acceleration != 0.0:
                action["ta"] = float(drive.acceleration)
            return action
        # passthrough: normalized pedals + steer through the engine envelope
        steer = max(-1.0, min(1.0, self.steer_sign * float(drive.steering_angle) / self.max_steer_rad))
        accel = float(drive.acceleration)
        if accel == 0.0:
            accel = self.speed_kp * (float(drive.speed) - self._speed)
        throttle = max(0.0, min(1.0, accel / self.max_accel))
        brake = max(0.0, min(1.0, -accel / self.max_decel))
        return {"ctrl": [throttle, brake, steer]}

    def _timeout_action(self) -> dict[str, Any]:
        return dict(self._last_action) if self.timeout_policy == "hold" else {}

    # ------------------------------------------------------------ publish out

    def _publish_state(self, frame: StepFrame) -> None:
        sv = frame.sv
        t = frame.t
        stamp = _sim_time(t)
        t_ns = _sim_time_ns(t)
        yaw = math.atan2(sv[3], sv[2])
        yaw_rate = 0.0
        if self._prev_yaw is not None and self._dt_decision > 0:
            yaw_rate = _wrap_pi(yaw - self._prev_yaw) / self._dt_decision
        self._prev_yaw = yaw
        self._speed = sv[4]
        self._t = t

        clock = Clock(clock=stamp)
        self.pub_clock.publish(clock)

        tf = TransformStamped()
        tf.header.stamp = stamp
        tf.header.frame_id = self.frame_map
        tf.child_frame_id = self.frame_base
        tf.transform.translation.x = sv[0]
        tf.transform.translation.y = sv[1]
        tf.transform.translation.z = 0.0
        qx, qy, qz, qw = _yaw_quat(yaw)
        tf.transform.rotation.x = qx
        tf.transform.rotation.y = qy
        tf.transform.rotation.z = qz
        tf.transform.rotation.w = qw
        tf_msg = TFMessage(transforms=[tf])
        self.pub_tf.publish(tf_msg)

        odom = Odometry()
        odom.header.stamp = stamp
        odom.header.frame_id = self.frame_map
        odom.child_frame_id = self.frame_base
        odom.pose.pose.position.x = sv[0]
        odom.pose.pose.position.y = sv[1]
        odom.pose.pose.orientation.x = qx
        odom.pose.pose.orientation.y = qy
        odom.pose.pose.orientation.z = qz
        odom.pose.pose.orientation.w = qw
        odom.twist.twist.linear.x = sv[4]
        odom.twist.twist.linear.y = sv[7]
        odom.twist.twist.angular.z = yaw_rate
        self.pub_odom.publish(odom)

        status = Float64MultiArray(data=list(sv))
        self.pub_status.publish(status)

        if self._bag:
            self._bag.write("/clock", clock, t_ns)
            self._bag.write("/tf", tf_msg, t_ns)
            self._bag.write("/simforge/odom", odom, t_ns)
            self._bag.write("/simforge/vehicle_status", status, t_ns)
        self._publish_extra_state(frame, stamp, t_ns, yaw, (qx, qy, qz, qw), yaw_rate)

    def _publish_episode_event(self, event: dict[str, Any], t: float) -> None:
        msg = String(data=json.dumps(event, sort_keys=True, separators=(",", ":")))
        self.pub_episode.publish(msg)
        if self._bag:
            self._bag.write("/simforge/episode", msg, _sim_time_ns(t))

    # ------------------------------------------------------------------- run

    def run(self) -> dict[str, Any]:
        spec_path = Path(self.episodes).resolve()
        client = self._make_client(spec_path)
        try:
            info = client.hello()
            self._dt_decision = 1.0 / float(info["decisionHz"])
            self.get_logger().info(
                f"env-server: proto {info['proto']}, {info['sessions']} session(s), "
                f"decision {info['decisionHz']} Hz, engine {info['engineHz']} Hz, ego {info['egos']}"
            )

            frame = client.reset(self.seed, session=self.session)
            self._digest.update(frame)
            self._publish_episode_event(
                {
                    "event": "begin",
                    "seed": self.seed,
                    "session": self.session,
                    "episodes": str(spec_path),
                    "decision_hz": info["decisionHz"],
                    "ego": info["egos"][self.session],
                    "control_mode": self.control_mode,
                },
                frame.t,
            )
            self._publish_state(frame)

            tick = 0
            timeouts = 0
            while rclpy.ok() and not frame.terminated and not frame.truncated:
                if self.max_ticks and tick >= self.max_ticks:
                    break
                timeout = self.first_command_timeout_s if tick == 0 else self.control_timeout_s
                cmd = self._wait_for_command(timeout)
                if cmd is not None:
                    action = self._map_command(cmd)
                else:
                    action = self._timeout_action()
                    timeouts += 1

                decision_t = frame.t  # the instant this action is decided for
                action_msg = String(data=canonical_action_json(action))
                self.pub_action.publish(action_msg)
                if self._bag:
                    self._bag.write("/simforge/applied_action", action_msg, _sim_time_ns(decision_t))
                    if cmd is not None:
                        self._bag.write("/simforge/control/ackermann", cmd, _sim_time_ns(decision_t))

                frame = client.step(action, session=self.session)
                self._last_action = action
                self._digest.update(frame)
                self._publish_state(frame)
                tick += 1

            summary = {
                "event": "end",
                "ticks": tick,
                "t_final": frame.t,
                "terminated": frame.terminated,
                "truncated": frame.truncated,
                "timeouts": timeouts,
                "stale_commands_dropped": self._stale_dropped,
                "digest": self._digest.hexdigest(),
                "frames_hashed": self._digest.frames,
            }
            self._publish_episode_event(summary, frame.t)
            self.get_logger().info(f"episode done: {summary}")
            if self.meta_path:
                meta = {
                    "seed": self.seed,
                    "session": self.session,
                    "episodes": str(spec_path),
                    "control_mode": self.control_mode,
                    **{k: v for k, v in summary.items() if k != "event"},
                }
                Path(self.meta_path).write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
            return summary
        finally:
            if self._bag:
                self._bag.close()
            client.close()

    # populated lazily by run()/_publish_state
    _t = 0.0
    _speed = 0.0
    _dt_decision = 0.1


def main(args: list[str] | None = None) -> None:
    rclpy.init(args=args)
    node = SimForgeBridge()
    try:
        node.run()
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
