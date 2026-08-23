"""``carla.TrafficManager``-shaped API over the ambient-traffic config.

The engine has no per-vehicle autopilot daemon; background road users are
generated at session build from the ambient-traffic profile
(``packages/engine/src/ambient/traffic.ts``: preset, density,
speed variance, aggressiveness, seed, max actors). This object maps the
TrafficManager surface the bridge actually calls onto that vocabulary and
records the mapping honestly:

| TM call | Ambient target | Fidelity |
|---|---|---|
| ``global_percentage_speed_difference(v)`` | cruise-speed scale `1 − v/100` applied to the recorded profile snapshot | partial — engine speeds come from lane limits × speedVariance jitter; the scale is advisory state for session building |
| ``set_global_distance_to_leading_vehicle(d)`` | recorded headway hint | partial — spacing emerges from the generator's route/reservation model |
| ``vehicle.set_autopilot(on, port)`` | registers the actor id here | stub — authored/generated choreography is authoritative |
| ``ignore_lights_percentage / ignore_signs_percentage`` | recorded per actor | stub — ambient actors obey signals in-engine |
| ``set_synchronous_mode(flag)`` | no-op | yes — the engine is always synchronous |

Anything outside this surface raises ``NotImplementedError`` pointing at
this module and the README matrix.
"""

from __future__ import annotations

#: Density presets mirrored from sim-engine ambient traffic PRESET_DENSITY.
PRESET_DENSITY_VEHICLES_PER_KM = {
    "off": 0,
    "light": 3,
    "moderate": 8,
    "city": 8,
    "heavy": 16,
    "custom": 8,
}

_DEFAULT_PORT = 8000


class TrafficManager:
    """One per-client TrafficManager handle."""

    def __init__(self, client, port: int | None = None):
        self._client = client
        self._port = int(port) if port is not None else _DEFAULT_PORT
        self._sync_mode = False
        #: Cruise-speed scale (1.0 = lane speed limit).
        self.speed_scale = 1.0
        self.global_distance_to_leading_vehicle_m = 0.0
        #: actor id → {"lights_pct", "signs_pct"}
        self.registered_vehicles: dict[int, dict] = {}

    # -- surface the bridge uses -------------------------------------------

    def get_port(self) -> int:
        return self._port

    def set_synchronous_mode(self, mode: bool) -> None:
        """No-op: the env-server is synchronous by construction."""
        self._sync_mode = bool(mode)

    @property
    def synchronous_mode(self) -> bool:
        return self._sync_mode

    def global_percentage_speed_difference(self, percentage: float) -> None:
        value = float(percentage)
        if not -100.0 <= value <= 100.0:
            raise ValueError("percentage must be within [-100, 100] (CARLA contract)")
        self.speed_scale = max(0.0, min(2.0, 1.0 - value / 100.0))

    def set_global_distance_to_leading_vehicle(self, distance: float) -> None:
        value = float(distance)
        if value < 0:
            raise ValueError("distance must be non-negative (CARLA contract)")
        self.global_distance_to_leading_vehicle_m = value

    def ignore_lights_percentage(self, actor, percentage: float) -> None:
        self._per_vehicle(actor).update(lights_pct=float(percentage))

    def ignore_signs_percentage(self, actor, percentage: float) -> None:
        self._per_vehicle(actor).update(signs_pct=float(percentage))

    def register_autopilot(self, actor_id: int, enabled: bool) -> None:
        """Called by ``Vehicle.set_autopilot`` to mirror registration."""
        entry = self._per_vehicle(actor_id)
        entry["autopilot"] = bool(enabled)

    def _per_vehicle(self, actor) -> dict:
        key = getattr(actor, "id", actor)
        return self.registered_vehicles.setdefault(key, {})

    # -- ambient-config projection ------------------------------------------

    def ambient_profile_snapshot(self, conditions_traffic: str = "moderate",
                                 seed: str = "ambient") -> dict:
        """The equivalent ambient-traffic profile fragment after TM edits.

        ``conditions_traffic`` is the session's operationalConditions.traffic
        enum ('light' | 'moderate' | 'heavy'); the TM speed override rides on
        top as ``speedScale`` (advisory for whoever builds the next session).
        """
        preset = conditions_traffic if conditions_traffic in PRESET_DENSITY_VEHICLES_PER_KM else "moderate"
        return {
            "version": 1,
            "preset": "off" if preset == "off" else ("custom" if self.speed_scale != 1.0 else preset),
            "densityVehiclesPerKm": PRESET_DENSITY_VEHICLES_PER_KM[preset],
            "speedScale": round(self.speed_scale, 6),
            "globalDistanceToLeadingVehicleM": self.global_distance_to_leading_vehicle_m,
            "seed": seed,
            "registeredAutopilotActors": sorted(self.registered_vehicles),
        }

    # -- everything else ------------------------------------------------------

    def __getattr__(self, name: str):
        def _unsupported(*args, **kwargs):
            raise NotImplementedError(
                f"TrafficManager.{name}: outside the supported surface "
                "(speed/distance globals, per-vehicle registration, sync mode) — "
                "ambient road users are engine-generated; see adapters/carla-api/"
                "README.md coverage matrix and uniscenarios_carla/trafficmanager.py")
        _unsupported.__name__ = name
        return _unsupported
