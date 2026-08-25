"""Autoware vehicle-interface module for the SimForge ROS 2 bridge (W2).

Extends the Ackermann MVP (``bridge_node.SimForgeBridge``) with the Autoware
component contract so a stock Autoware Core control node — binary Jazzy deb
``autoware_simple_pure_pursuit`` from ``autoware_core_control`` — closes the
loop on a SimForge episode. NO perception stack runs: objects are injected
ground truth straight from the engine's truth-stream side channel.

Out (in addition to every MVP topic, all stamped with sim time):

- ``/localization/kinematic_state``   nav_msgs/Odometry            ego pose +
  body twist (the Autoware localization contract; identical numbers to
  ``/simforge/odom``)
- ``/vehicle/status/velocity_status`` autoware_vehicle_msgs/VelocityReport
- ``/vehicle/status/steering_status`` autoware_vehicle_msgs/SteeringReport
  (tire angle = last APPLIED engine steer; the engine state vector carries no
  steering state)
- ``/vehicle/status/gear_status``     autoware_vehicle_msgs/GearReport (DRIVE)
- ``/perception/object_recognition/objects``
  autoware_perception_msgs/PredictedObjects — ground-truth actors from the
  env-server truth stream (ego filtered out), one constant-velocity predicted
  path each
- ``/planning/trajectory``            autoware_planning_msgs/Trajectory — the
  authored route (straight + one lane-change turn on the synthetic fixture),
  re-published every decision so a relaunched Autoware re-syncs within one
  tick

In:

- ``autoware_control_topic``  autoware_control_msgs/Control (default
  ``/control/trajectory_follower/control_cmd``, the stock
  ``simple_pure_pursuit.launch.xml`` output). Each command is converted to the
  MVP's internal Ackermann form (tire angle / velocity / acceleration carry
  over 1:1) and rides the unchanged lockstep + passthrough mapping, so bags,
  digests and replay_assert keep working verbatim. The raw Control message is
  additionally bagged at its decision instant.

The Ackermann topic keeps working: whichever command (Ackermann or Control)
arrives newest before a tick's deadline wins, exactly like two Ackermann
publishers would.
"""

from __future__ import annotations

import math
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Mapping, Sequence

import msgpack
import rclpy

from ackermann_msgs.msg import AckermannDriveStamped
from autoware_control_msgs.msg import Control
from autoware_perception_msgs.msg import (
    ObjectClassification,
    PredictedObject,
    PredictedObjectKinematics,
    PredictedObjects,
    PredictedPath,
    Shape,
)
from autoware_planning_msgs.msg import Trajectory, TrajectoryPoint
from builtin_interfaces.msg import Duration as DurationMsg
from builtin_interfaces.msg import Time as TimeMsg
from geometry_msgs.msg import Pose, Vector3
from nav_msgs.msg import Odometry
from autoware_vehicle_msgs.msg import GearReport, SteeringReport, VelocityReport

from .bridge_node import _RELIABLE, SimForgeBridge, _sim_time_ns, _yaw_quat
from .env_client import (
    _HEADER,
    EnvServerClient,
    ProtocolError,
    ServerError,
    StepFrame,
    _read_exact,
    default_server_command,
)


class TruthStreamClient(EnvServerClient):
    """Env-server client that also consumes the truth-stream side channel.

    The server flushes ``op:'tick'`` ground-truth documents onto the same
    stdio wire after each reply (docs/engineering: truth stream, drop-oldest
    bounded queue). This client skims them into :attr:`ticks` while reading
    replies; :meth:`pump` issues a no-op round trip so ticks emitted after the
    latest ``step`` reply become readable immediately.
    """

    def __init__(self, server_command: Sequence[str], **kwargs: Any) -> None:
        super().__init__(server_command, **kwargs)
        self.ticks: deque[dict[str, Any]] = deque(maxlen=64)

    def _request(self, document: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        payload = msgpack.packb({"i": request_id, **document}, use_bin_type=True)
        stdin = self._proc.stdin
        assert stdin is not None
        stdin.write(_HEADER.pack(len(payload)) + payload)
        stdin.flush()

        stdout = self._proc.stdout
        assert stdout is not None
        while True:
            header = _read_exact(stdout.read, 4)
            frame = _read_exact(stdout.read, _HEADER.unpack(header)[0])
            response = msgpack.unpackb(frame, raw=False)
            if response.get("op") == "tick":
                self.ticks.append(response)
                continue
            if response.get("i") != request_id:
                raise ProtocolError(f"reply id {response.get('i')!r} does not match request {request_id}")
            if response.get("ok") == 1:
                return response.get("r")
            raise ServerError(str(response.get("e", "unknown server error")))

    def subscribe(self, session: int = 0) -> None:
        self._request({"op": "subscribe", "s": session})

    def pump(self) -> None:
        """Drain any ticks the server flushed after the previous reply."""
        self._request({"op": "hello"})


def _actor_uuid(actor_id: str) -> list[int]:
    return list(uuid.uuid5(uuid.NAMESPACE_OID, f"simforge:{actor_id}").bytes)


class AutowareBridge(SimForgeBridge):
    def __init__(self) -> None:
        super().__init__()

        p = self.declare_parameter
        p("autoware_control_topic", "/control/trajectory_follower/control_cmd")
        p("kinematic_state_topic", "/localization/kinematic_state")
        p("trajectory_topic", "/planning/trajectory")
        p("objects_topic", "/perception/object_recognition/objects")
        p("velocity_status_topic", "/vehicle/status/velocity_status")
        p("steering_status_topic", "/vehicle/status/steering_status")
        p("gear_status_topic", "/vehicle/status/gear_status")
        # Route on the synthetic fixture (map frame == engine xodr-local ENU):
        # straight in the start lane, one lane-change turn, straight, stop.
        p("route_x_start", 40.0)
        p("route_x_end", 280.0)
        p("route_step_m", 1.0)
        p("lane_change_x0", 130.0)
        p("lane_change_x1", 180.0)
        p("lane_y_from", 0.0)
        p("lane_y_to", -3.5)
        p("cruise_speed_mps", 8.0)
        p("stop_decel_mps2", 1.2)
        # Ground-truth objects channel.
        p("ego_actor_id", "ego")
        p("object_dims_lwh", [4.5, 1.9, 1.5])
        p("prediction_horizon_s", 3.0)
        p("prediction_dt_s", 0.5)

        gp = lambda name: self.get_parameter(name).value  # noqa: E731
        self.autoware_control_topic = str(gp("autoware_control_topic"))
        self.kinematic_state_topic = str(gp("kinematic_state_topic"))
        self.trajectory_topic = str(gp("trajectory_topic"))
        self.objects_topic = str(gp("objects_topic"))
        self.velocity_status_topic = str(gp("velocity_status_topic"))
        self.steering_status_topic = str(gp("steering_status_topic"))
        self.gear_status_topic = str(gp("gear_status_topic"))
        self.ego_actor_id = str(gp("ego_actor_id"))
        self.object_dims = [float(v) for v in gp("object_dims_lwh")]
        self.prediction_horizon_s = float(gp("prediction_horizon_s"))
        self.prediction_dt_s = float(gp("prediction_dt_s"))

        self._trajectory = self._build_trajectory(
            x0=float(gp("route_x_start")),
            x1=float(gp("route_x_end")),
            step=float(gp("route_step_m")),
            lc0=float(gp("lane_change_x0")),
            lc1=float(gp("lane_change_x1")),
            y0=float(gp("lane_y_from")),
            y1=float(gp("lane_y_to")),
            cruise=float(gp("cruise_speed_mps")),
            decel=float(gp("stop_decel_mps2")),
        )

        self.pub_kinematic = self.create_publisher(Odometry, self.kinematic_state_topic, _RELIABLE)
        self.pub_trajectory = self.create_publisher(Trajectory, self.trajectory_topic, _RELIABLE)
        self.pub_objects = self.create_publisher(PredictedObjects, self.objects_topic, _RELIABLE)
        self.pub_velocity_status = self.create_publisher(VelocityReport, self.velocity_status_topic, _RELIABLE)
        self.pub_steering_status = self.create_publisher(SteeringReport, self.steering_status_topic, _RELIABLE)
        self.pub_gear_status = self.create_publisher(GearReport, self.gear_status_topic, _RELIABLE)

        self._raw_control: Control | None = None
        self.create_subscription(Control, self.autoware_control_topic, self._on_autoware_control, _RELIABLE)

        if self._bag:
            for name, type_name in (
                (self.kinematic_state_topic, "nav_msgs/msg/Odometry"),
                (self.trajectory_topic, "autoware_planning_msgs/msg/Trajectory"),
                (self.objects_topic, "autoware_perception_msgs/msg/PredictedObjects"),
                (self.velocity_status_topic, "autoware_vehicle_msgs/msg/VelocityReport"),
                (self.steering_status_topic, "autoware_vehicle_msgs/msg/SteeringReport"),
                (self.gear_status_topic, "autoware_vehicle_msgs/msg/GearReport"),
                (self.autoware_control_topic, "autoware_control_msgs/msg/Control"),
            ):
                self._bag.create_topic(name, type_name)

    # -------------------------------------------------------------- route out

    def _build_trajectory(
        self,
        *,
        x0: float,
        x1: float,
        step: float,
        lc0: float,
        lc1: float,
        y0: float,
        y1: float,
        cruise: float,
        decel: float,
    ) -> Trajectory:
        """Straight + one smooth lane-change turn + straight, stopping at x1.

        Cosine blend for the lateral move (continuous heading), velocity =
        cruise capped by a physical stop ramp ``v = sqrt(2 a d_remaining)``.
        """

        def y_at(x: float) -> float:
            if x <= lc0:
                return y0
            if x >= lc1:
                return y1
            u = (x - lc0) / (lc1 - lc0)
            return y0 + (y1 - y0) * 0.5 * (1.0 - math.cos(math.pi * u))

        n = max(2, int(round((x1 - x0) / step)) + 1)
        xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
        pts = [(x, y_at(x)) for x in xs]

        traj = Trajectory()
        traj.header.frame_id = self.frame_map
        arc_remaining = 0.0
        lengths: list[float] = [0.0] * n
        for i in range(n - 2, -1, -1):
            dx, dy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
            arc_remaining += math.hypot(dx, dy)
            lengths[i] = arc_remaining
        for i, (x, y) in enumerate(pts):
            nxt = pts[min(i + 1, n - 1)]
            prv = pts[max(i - 1, 0)]
            yaw = math.atan2(nxt[1] - prv[1], nxt[0] - prv[0])
            qx, qy, qz, qw = _yaw_quat(yaw)
            point = TrajectoryPoint()
            point.pose.position.x = x
            point.pose.position.y = y
            point.pose.orientation.x = qx
            point.pose.orientation.y = qy
            point.pose.orientation.z = qz
            point.pose.orientation.w = qw
            point.longitudinal_velocity_mps = float(min(cruise, math.sqrt(2.0 * decel * lengths[i])))
            traj.points.append(point)
        traj.points[-1].longitudinal_velocity_mps = 0.0
        return traj

    # ------------------------------------------------------------- control in

    def _on_autoware_control(self, msg: Control) -> None:
        """Convert autoware_control_msgs/Control to the MVP's Ackermann form.

        steering_tire_angle, velocity and acceleration carry over 1:1 (both
        contracts use rad / m/s / m/s^2, positive steer = left), so the
        unchanged passthrough mapping and bag/replay tooling apply verbatim.
        """
        ack = AckermannDriveStamped()
        ack.header.stamp = msg.stamp
        ack.drive.steering_angle = float(msg.lateral.steering_tire_angle)
        ack.drive.speed = float(msg.longitudinal.velocity)
        if msg.longitudinal.is_defined_acceleration:
            ack.drive.acceleration = float(msg.longitudinal.acceleration)
        self._raw_control = msg
        self._pending.append(ack)

    def _map_command(self, msg: AckermannDriveStamped) -> dict[str, Any]:
        if self._bag and self._raw_control is not None:
            # Bag the raw Autoware command actually consumed this decision.
            self._bag.write(self.autoware_control_topic, self._raw_control, _sim_time_ns(self._t))
            self._raw_control = None
        return super()._map_command(msg)

    # ----------------------------------------------------------- state out

    def _make_client(self, spec_path: Path) -> EnvServerClient:
        client = TruthStreamClient(default_server_command(spec_path))
        client.subscribe(self.session)
        self._truth_client = client
        return client

    def _publish_extra_state(
        self,
        frame: StepFrame,
        stamp: TimeMsg,
        t_ns: int,
        yaw: float,
        quat: tuple[float, float, float, float],
        yaw_rate: float,
    ) -> None:
        sv = frame.sv
        qx, qy, qz, qw = quat

        kin = Odometry()
        kin.header.stamp = stamp
        kin.header.frame_id = self.frame_map
        kin.child_frame_id = self.frame_base
        kin.pose.pose.position.x = sv[0]
        kin.pose.pose.position.y = sv[1]
        kin.pose.pose.orientation.x = qx
        kin.pose.pose.orientation.y = qy
        kin.pose.pose.orientation.z = qz
        kin.pose.pose.orientation.w = qw
        kin.twist.twist.linear.x = sv[4]
        kin.twist.twist.linear.y = sv[7]
        kin.twist.twist.angular.z = yaw_rate
        self.pub_kinematic.publish(kin)

        vel = VelocityReport()
        vel.header.stamp = stamp
        vel.header.frame_id = self.frame_base
        vel.longitudinal_velocity = float(sv[4])
        vel.lateral_velocity = float(sv[7])
        vel.heading_rate = float(yaw_rate)
        self.pub_velocity_status.publish(vel)

        steer = SteeringReport()
        steer.stamp = stamp
        steer.steering_tire_angle = float(self._applied_steer_rad())
        self.pub_steering_status.publish(steer)

        gear = GearReport()
        gear.stamp = stamp
        gear.report = GearReport.DRIVE
        self.pub_gear_status.publish(gear)

        self._trajectory.header.stamp = stamp
        self.pub_trajectory.publish(self._trajectory)

        objects = self._ground_truth_objects(stamp)
        if objects is not None:
            self.pub_objects.publish(objects)

        if self._bag:
            self._bag.write(self.kinematic_state_topic, kin, t_ns)
            self._bag.write(self.velocity_status_topic, vel, t_ns)
            self._bag.write(self.steering_status_topic, steer, t_ns)
            self._bag.write(self.gear_status_topic, gear, t_ns)
            if not self._trajectory_bagged:
                # The route is static; one copy per episode keeps the bag
                # small (241 points ≈ 30 KB would otherwise ride every tick).
                self._bag.write(self.trajectory_topic, self._trajectory, t_ns)
                self._trajectory_bagged = True
            if objects is not None:
                self._bag.write(self.objects_topic, objects, t_ns)

    def _applied_steer_rad(self) -> float:
        ctrl = self._last_action.get("ctrl")
        if isinstance(ctrl, (list, tuple)) and len(ctrl) == 3:
            return float(ctrl[2]) * self.max_steer_rad * self.steer_sign
        return 0.0

    # populated lazily by _publish_extra_state
    _trajectory_bagged = False

    # ------------------------------------------------------ ground truth out

    def _ground_truth_objects(self, stamp: TimeMsg) -> PredictedObjects | None:
        client = getattr(self, "_truth_client", None)
        if client is None:
            return None
        client.pump()
        if not client.ticks:
            return None
        tick = client.ticks[-1]
        client.ticks.clear()

        msg = PredictedObjects()
        msg.header.stamp = stamp
        msg.header.frame_id = self.frame_map
        for actor in tick["frame"]["actors"]:
            if actor["id"] == self.ego_actor_id or actor["kind"] == "despawn":
                continue
            msg.objects.append(self._predicted_object(actor))
        return msg

    def _predicted_object(self, actor: Mapping[str, Any]) -> PredictedObject:
        # Truth-stream scene frame: position [x, 0, -y], same yaw (frames.ts).
        x = float(actor["position"][0])
        y = -float(actor["position"][2])
        yaw = float(actor["yawRad"])
        vx = float(actor["velocity"][0])
        vy = -float(actor["velocity"][2])
        ax = float(actor["acceleration"][0])
        ay = -float(actor["acceleration"][2])
        cos_y, sin_y = math.cos(yaw), math.sin(yaw)
        v_long = vx * cos_y + vy * sin_y
        a_long = ax * cos_y + ay * sin_y
        qx, qy, qz, qw = _yaw_quat(yaw)

        def pose_at(dt: float) -> Pose:
            pose = Pose()
            pose.position.x = x + vx * dt
            pose.position.y = y + vy * dt
            pose.orientation.x = qx
            pose.orientation.y = qy
            pose.orientation.z = qz
            pose.orientation.w = qw
            return pose

        obj = PredictedObject()
        obj.object_id.uuid = _actor_uuid(str(actor["id"]))
        obj.existence_probability = 1.0
        obj.classification.append(ObjectClassification(label=ObjectClassification.CAR, probability=1.0))

        kin = PredictedObjectKinematics()
        kin.initial_pose_with_covariance.pose = pose_at(0.0)
        kin.initial_twist_with_covariance.twist.linear.x = v_long
        kin.initial_acceleration_with_covariance.accel.linear.x = a_long

        path = PredictedPath()
        path.confidence = 1.0
        dt = self.prediction_dt_s
        path.time_step = DurationMsg(sec=int(dt), nanosec=int(round((dt % 1.0) * 1e9)))
        steps = max(1, int(round(self.prediction_horizon_s / dt)))
        for i in range(1, steps + 1):
            path.path.append(pose_at(i * dt))
        kin.predicted_paths.append(path)
        obj.kinematics = kin

        shape = Shape()
        shape.type = Shape.BOUNDING_BOX
        shape.dimensions = Vector3(x=self.object_dims[0], y=self.object_dims[1], z=self.object_dims[2])
        obj.shape = shape
        return obj


def main(args: list[str] | None = None) -> None:
    rclpy.init(args=args)
    node = AutowareBridge()
    try:
        node.run()
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
