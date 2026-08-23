"""Geometry types mirroring the ``carla`` client surface.

The facade presents the engine's **xodr-local frame** as the carla world
frame: x east, y north, metres, yaw CCW from +x in degrees. That is the frame
the topology-index lane polylines live in, so waypoint queries need no
conversion. Authored input poses are *scene-frame* ``{x, z}`` and flip once
on ingest (carla y = -scene z), mirroring sim-engine's frames.ts:

- carla ``z`` is always the ground plane (0.0); the engine is strictly 2-D.
- headings are numerically identical across both frames.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


def _wrap_deg(angle: float) -> float:
    return (angle + 180.0) % 360.0 - 180.0


@dataclass(frozen=True)
class Vector3D:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def distance(self, other: "Vector3D") -> float:
        return math.sqrt((self.x - other.x) ** 2 + (self.y - other.y) ** 2 + (self.z - other.z) ** 2)

    def length(self) -> float:
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def __add__(self, other: "Vector3D") -> "Vector3D":
        return Vector3D(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vector3D") -> "Vector3D":
        return Vector3D(self.x - other.x, self.y - other.y, self.z - other.z)

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Vector3D(x={self.x:.3f}, y={self.y:.3f}, z={self.z:.3f})"


@dataclass(frozen=True)
class Location(Vector3D):
    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Location(x={self.x:.3f}, y={self.y:.3f}, z={self.z:.3f})"


@dataclass(frozen=True)
class Rotation:
    pitch: float = 0.0
    yaw: float = 0.0
    roll: float = 0.0

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Rotation(pitch={self.pitch:.2f}, yaw={self.yaw:.2f}, roll={self.roll:.2f})"


@dataclass(frozen=True)
class Transform:
    location: Location = field(default_factory=Location)
    rotation: Rotation = field(default_factory=Rotation)

    @staticmethod
    def from_engine_pose(pose: dict) -> "Transform":
        """Build a Transform from an authored *scene-frame* input pose.

        Authored ``SimScenarioInput`` poses are scene-frame ``{x, z}``
        (sim-engine frames.ts); the facade presents the xodr-local frame
        (the topology/lane frame) as the carla world, so carla y = -scene z.
        """
        return Transform(
            location=Location(float(pose["x"]), -float(pose["z"]), 0.0),
            rotation=Rotation(yaw=_wrap_deg(math.degrees(float(pose["headingRad"])))),
        )

    @staticmethod
    def from_state_vector(sv) -> "Transform":
        """Ego transform from the fixed 10-float state vector (see rl-env)."""
        heading = math.atan2(float(sv[3]), float(sv[2]))
        return Transform(
            location=Location(float(sv[0]), float(sv[1]), 0.0),
            rotation=Rotation(yaw=_wrap_deg(math.degrees(heading))),
        )

    @property
    def yaw_rad(self) -> float:
        return math.radians(self.rotation.yaw)

    def get_forward_vector(self) -> Vector3D:
        return Vector3D(x=math.cos(self.yaw_rad), y=math.sin(self.yaw_rad), z=0.0)

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Transform({self.location!r}, {self.rotation!r})"
