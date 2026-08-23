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

    The UniScenarios engine is authoritative: actors exist because the
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
        self.autopilot_enabled = True

    def apply_control(self, control: VehicleControl) -> None:
        """Queue a low-level control; applied at the next ``world.tick()``.

        Control passthrough goes into the force-based backend inside the
        profile's steer clamp/rate/lag envelope (rl-env EnvAction.ctrl).
        """
        self._pending_control = control

    def get_control(self) -> VehicleControl:
        return self._pending_control or VehicleControl()

    def set_autopilot(self, enabled: bool) -> None:
        """Recorded on the handle only — see README: no runtime autopilot toggle.

        With autopilot "off" and no ``apply_control`` queued, ticks send empty
        actions and the engine keeps the authored choreography.
        """
        self.autopilot_enabled = enabled

    @property
    def pending_action(self) -> dict | None:
        """Wire action for the next tick; consumed by ``World.tick``."""
        ctrl = self._pending_control
        if ctrl is None:
            return None
        return {"control": ctrl}


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
