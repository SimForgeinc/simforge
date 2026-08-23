"""``carla.VehiclePhysicsControl`` from the engine's vehicle profiles.

Pure pursuit in the legacy bridge (trajectory_player.py) extracts exactly
two things from ``get_physics_control()``:

- **wheelbase** — average front-axle x minus average rear-axle x, in UE cm
  divided by 100 → metres;
- **max_steer_angle** — max over the two front wheels, degrees.

Mapping onto UniScenarios (documented for the consumer):

- The engine's per-class dynamics presets live in
  ``packages/sim-engine/src/sim/dynamic-v1.ts`` (ACTOR_PHYSICS_PROFILES);
  the relevant fields are mirrored below and MUST be kept in sync.
- A scenario instance can override any field per actor via
  ``input.physics.vehicleProfiles[<actorId>]``; those overrides win.
- ``wheelbaseM`` maps 1:1 to the pure-pursuit wheelbase (authoritative).
- ``maxSteerRad`` maps to the front wheels' ``max_steer_angle`` in degrees.
- Wheel positions are synthesized in UE units (cm): x forward from the
  vehicle origin at ±axle offsets derived from ``cgToFrontM``/wheelbase,
  y = nominal track ≈ half width minus an 8 cm tire margin, z =
  ``wheelRadiusM`` × 100. Longitudinal positions are exact for consumers;
  lateral/z are cosmetic (no facade consumer reads them).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: Class-level defaults mirrored from sim-engine dynamic-v1.ts
#: ACTOR_PHYSICS_PROFILES / GENERIC_PASSENGER_CAR_PROFILE (2026-08).
_CLASS_PROFILES: dict[str, dict] = {
    "vehicle": {"massKg": 1500.0, "wheelbaseM": 2.7, "cgToFrontM": 1.2,
                "wheelRadiusM": 0.31, "maxSteerRad": 0.58},
    "car": {"massKg": 1500.0, "wheelbaseM": 2.7, "cgToFrontM": 1.2,
            "wheelRadiusM": 0.31, "maxSteerRad": 0.58},
    "van": {"massKg": 2600.0, "wheelbaseM": 3.35, "cgToFrontM": 1.55,
            "wheelRadiusM": 0.36, "maxSteerRad": 0.54},
    "truck": {"massKg": 12000.0, "wheelbaseM": 5.2, "cgToFrontM": 2.25,
              "wheelRadiusM": 0.5, "maxSteerRad": 0.44},
    "bus": {"massKg": 13500.0, "wheelbaseM": 6.0, "cgToFrontM": 2.7,
            "wheelRadiusM": 0.51, "maxSteerRad": 0.46},
    "motorcycle": {"massKg": 240.0, "wheelbaseM": 1.45, "cgToFrontM": 0.68,
                   "wheelRadiusM": 0.3, "maxSteerRad": 0.62},
    "bicycle": {"massKg": 95.0, "wheelbaseM": 1.08, "cgToFrontM": 0.48,
                "wheelRadiusM": 0.34, "maxSteerRad": 0.7},
    "scooter": {"massKg": 115.0, "wheelbaseM": 1.15, "cgToFrontM": 0.52,
                "wheelRadiusM": 0.25, "maxSteerRad": 0.68},
}
_FALLBACK = _CLASS_PROFILES["vehicle"]


@dataclass(frozen=True)
class WheelPhysicsControl:
    """Mirrors carla.WheelPhysicsControl for the fields consumers read."""

    position: tuple[float, float]  # UE cm, (x forward, y right)
    max_steer_angle: float  # degrees
    radius_m: float

    @property
    def position_x_cm(self) -> float:
        return self.position[0]

    @property
    def position_y_cm(self) -> float:
        return self.position[1]


@dataclass(frozen=True)
class VehiclePhysicsControl:
    """Mirrors carla.VehiclePhysicsControl for the fields consumers read."""

    mass_kg: float
    center_of_mass: tuple[float, float]  # UE cm relative to origin
    wheels: list[WheelPhysicsControl]

    @property
    def wheelbase_m(self) -> float:
        """Front/rear axle distance in metres (legacy extraction formula)."""
        fx = (self.wheels[0].position_x_cm + self.wheels[1].position_x_cm) / 2.0
        rx = (self.wheels[2].position_x_cm + self.wheels[3].position_x_cm) / 2.0
        return abs(fx - rx) / 100.0

    @property
    def max_steer_angle_rad(self) -> float:
        return math.radians(max(w.max_steer_angle for w in self.wheels[:2]))


def resolve_physics_profile(actor: dict, vehicle_profiles: dict | None) -> dict:
    """Effective profile for one authored actor dict (kind/dims/id)."""
    actor_id = actor.get("id", "")
    kind = str(actor.get("kind", "vehicle"))
    base = dict(_CLASS_PROFILES.get(kind, _FALLBACK))
    if kind == "pedestrian" or kind == "walker":
        base = dict(_FALLBACK)
    dims = actor.get("dims") or {}
    if dims.get("l"):
        # Keep the authored bounding length honest: cap the wheelbase inside it.
        base["dimsL"] = float(dims["l"])
    override = (vehicle_profiles or {}).get(actor_id)
    if isinstance(override, dict):
        for key in ("massKg", "wheelbaseM", "cgToFrontM", "wheelRadiusM", "maxSteerRad"):
            if key in override:
                base[key] = float(override[key])
    return base


def build_physics_control(actor: dict, vehicle_profiles: dict | None) -> VehiclePhysicsControl:
    """The ``get_physics_control()`` payload for one authored actor."""
    p = resolve_physics_profile(actor, vehicle_profiles)
    wheelbase_m = min(p["wheelbaseM"], p.get("dimsL", p["wheelbaseM"]))
    cg_front_m = p["cgToFrontM"]
    rear_m = max(0.1, wheelbase_m - cg_front_m)
    dims_w = float((actor.get("dims") or {}).get("w") or 1.8)
    track_half_cm = max(60.0, (dims_w / 2.0 - 0.08) * 100.0)
    radius_cm = p["wheelRadiusM"] * 100.0
    max_steer_deg = math.degrees(p["maxSteerRad"])
    wheels = [
        WheelPhysicsControl(position=(cg_front_m * 100.0, -track_half_cm), max_steer_angle=max_steer_deg, radius_m=p["wheelRadiusM"]),
        WheelPhysicsControl(position=(cg_front_m * 100.0, track_half_cm), max_steer_angle=max_steer_deg, radius_m=p["wheelRadiusM"]),
        WheelPhysicsControl(position=(-rear_m * 100.0, -track_half_cm), max_steer_angle=0.0, radius_m=p["wheelRadiusM"]),
        WheelPhysicsControl(position=(-rear_m * 100.0, track_half_cm), max_steer_angle=0.0, radius_m=p["wheelRadiusM"]),
    ]
    return VehiclePhysicsControl(
        mass_kg=p["massKg"],
        center_of_mass=(0.0, 0.0),
        wheels=wheels,
    )
