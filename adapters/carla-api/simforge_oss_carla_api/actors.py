"""Actors: the CARLA ``Actor``/``Vehicle``/``Walker`` surface over env-server state."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .geom import Location, Rotation, Transform, Vector3D


@dataclass(frozen=True)
class VehicleControl:
    throttle: float = 0.0
    steer: float = 0.0
    brake: float = 0.0
    hand_brake: bool = False
    reverse: bool = False
    manual_gear_shift: bool = False
    gear: int = 0


@dataclass(frozen=True)
class WalkerControl:
    direction: Vector3D = Vector3D()
    speed: float = 0.0
    jump: bool = False


class Actor:
    """Base handle for an actor bound to an authored scenario role.

    The SimForge engine is authoritative: actors exist because the
    scenario says so. "Spawning" binds a facade handle to an authored actor;
    transforms come from engine state each tick.
    """

    def __init__(self, world, *, actor_id: int, type_id: str, role_name: str = "",
                 attributes: dict | None = None) -> None:
        self._world = world
        self.id = actor_id
        self.type_id = type_id
        self.role_name = role_name
        self.attributes = dict(attributes or {})
        self.is_alive = True

    # -- state --------------------------------------------------------------

    @property
    def _snapshot(self):
        return self._world.actor_state(self.id)

    def get_transform(self) -> Transform:
        snap = self._require_snapshot()
        return snap["transform"]

    def get_location(self) -> Location:
        return self.get_transform().location

    def get_velocity(self) -> Vector3D:
        snap = self._require_snapshot()
        yaw = snap["transform"].yaw_rad
        speed = float(snap.get("speed_mps", 0.0))
        return Vector3D(x=math.cos(yaw) * speed, y=math.sin(yaw) * speed, z=0.0)

    def get_angular_velocity(self) -> Vector3D:
        return Vector3D()  # not exposed by the protocol (see README)

    def get_acceleration(self) -> Vector3D:
        snap = self._require_snapshot()
        yaw = snap["transform"].yaw_rad
        accel = float(snap.get("accel_mps2", 0.0))
        return Vector3D(x=math.cos(yaw) * accel, y=math.sin(yaw) * accel, z=0.0)

    def _require_snapshot(self) -> dict:
        if not self.is_alive:
            raise RuntimeError(f"actor {self.id} ({self.type_id}) destroyed")
        snap = self._snapshot
        if snap is None:
            raise RuntimeError(
                f"actor {self.id} ({self.type_id}) has no engine state at the "
                f"current tick (not spawned yet or not currently perceived)"
            )
        return snap

    # -- lifecycle ----------------------------------------------------------

    def destroy(self) -> None:
        """Detach the handle. The engine's authored actors cannot be despawned."""
        self.is_alive = False

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<Actor id={self.id} type={self.type_id!r} role={self.role_name!r}>"


class Vehicle(Actor):
    """Ego-controllable vehicle handle."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._pending_control: VehicleControl | None = None
        self._target_velocity: Vector3D | None = None
        self.autopilot_enabled = True

    def apply_control(self, control: VehicleControl) -> None:
        """Queue a low-level control; applied at the next ``world.tick()``.

        Control passthrough goes into the force-based backend inside the
        profile's steer clamp/rate/lag envelope (rl-env EnvAction.ctrl).
        """
        self._pending_control = control

    def get_control(self) -> VehicleControl:
        return self._pending_control or VehicleControl()

    def set_autopilot(self, enabled: bool, tm_port: int | None = None) -> None:
        """Recorded on the handle + TrafficManager registry — see README.

        The engine has no per-vehicle autopilot daemon: ambient road users
        are generated at session build from the ambient-traffic profile,
        and authored actors keep their choreography unless overridden by
        controls or a speed intent.
        """
        self.autopilot_enabled = enabled
        tm = getattr(self._world, "traffic_manager", None)
        if tm is not None:
            tm.register_autopilot(self.id, enabled)

    @property
    def pending_action(self) -> dict | None:
        """Wire action for the next tick; consumed by ``World.tick``.

        A queued ``VehicleControl`` takes precedence; otherwise a
        ``set_target_velocity`` request becomes the env-server's
        ``{ts, dir}`` speed-intent action.
        """
        ctrl = self._pending_control
        if ctrl is not None:
            return {"ctrl": [ctrl.throttle, ctrl.brake, ctrl.steer]}
        tv = self._target_velocity
        if tv is not None:
            yaw = self.get_transform().yaw_rad
            longitudinal = tv.x * math.cos(yaw) + tv.y * math.sin(yaw)
            action: dict = {"ts": abs(longitudinal)}
            if longitudinal < 0:
                action["dir"] = -1
            return action
        return None

    def set_target_velocity(self, velocity: Vector3D) -> None:
        """Speed-intent control (carla ``set_target_velocity``).

        Mapped onto the env-server's ``targetSpeedMps`` action field: the
        requested world-frame velocity is projected onto the vehicle's
        forward axis at apply time; the engine's speed controller then drives
        toward it each tick until changed. A later ``apply_control``
        overrides it for as long as controls keep being applied.
        """
        self._target_velocity = Vector3D(velocity.x, velocity.y, velocity.z)

    def get_target_velocity(self) -> Vector3D | None:
        return self._target_velocity

    def get_physics_control(self):
        """VehiclePhysicsControl from the engine's dynamics profile.

        Pure-pursuit consumers read ``wheelbase_m`` and front-wheel
        ``max_steer_angle``; see simforge_oss_carla_api/physics.py for the exact
        mapping from sim-engine's ACTOR_PHYSICS_PROFILES and any per-actor
        ``input.physics.vehicleProfiles`` overrides.
        """
        from .physics import build_physics_control

        authored = {r["id"]: r for r in self._world.scenario.roles}
        actor = authored.get(self.role_name)
        if actor is None:
            raise RuntimeError(
                f"actor {self.id} ({self.type_id}) has no authored role "
                f"{self.role_name!r}; no physics profile available")
        return build_physics_control(actor, self._world.scenario.vehicle_profiles)


class Walker(Actor):
    """Pedestrian handle; state is read-only (authored choreography)."""

    def apply_control(self, control: WalkerControl) -> None:
        raise NotImplementedError(
            "walker control is not backed by the env-server action surface (README)"
        )


class TrafficLight(Actor):
    """Traffic light handle: transform/state not exposed by the protocol yet."""


class Sensor(Actor):
    """Sensor handle attached to another actor; frames via its FrameSource."""

    def __init__(self, world, *, frame_source=None, **kwargs) -> None:
        super().__init__(world, **kwargs)
        self._frame_source = frame_source
        self._callback = None
        self._is_listening = False

    def listen(self, callback) -> None:
        """Register a per-tick callback receiving :class:`SensorFrame` objects."""
        self._callback = callback
        self._is_listening = True

    def stop(self) -> None:
        self._is_listening = False

    def is_listening(self) -> bool:
        return self._is_listening

    def _tick(self, t_s: float) -> None:
        """Called by World.tick; delivers one frame when the source has one."""
        if not (self._is_listening and self._callback and self._frame_source is not None):
            return
        starter = getattr(self._frame_source, "start", None)
        if starter is not None:
            starter()
        raw = self._frame_source.frame_at(t_s, self.role_name or self.type_id)
        if raw is not None:
            self._callback(SensorFrame(raw))


class SensorFrame:
    """Minimal stand-in for carla.Image: PNG payload + decode helper."""

    def __init__(self, png_bytes: bytes) -> None:
        self.raw_data = png_bytes
        self._decoded: np.ndarray | None = None

    @property
    def width(self) -> int:
        return self.to_array().shape[1]

    @property
    def height(self) -> int:
        return self.to_array().shape[0]

    def to_array(self) -> np.ndarray:
        if self._decoded is None:
            try:
                from PIL import Image  # optional dependency
                import io

                self._decoded = np.asarray(Image.open(io.BytesIO(self.raw_data)).convert("RGB"))
            except ImportError as exc:  # pragma: no cover - env issue
                raise RuntimeError("install pillow to decode sensor frames") from exc
        return self._decoded

    def save_to_disk(self, path: str) -> None:
        with open(path, "wb") as handle:
            handle.write(self.raw_data)

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<SensorFrame {len(self.raw_data)} bytes png>"
