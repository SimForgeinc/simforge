"""Versioned, fail-closed semantic coverage for CARLA execution paths."""

from dataclasses import dataclass
from typing import Literal

Coverage = Literal["exact", "approximate", "unsupported"]


@dataclass(frozen=True)
class Capability:
    bridge: Coverage
    scenario_runner_1_0: Coverage
    note: str


BRIDGE_CAPABILITIES: dict[str, Capability] = {
    "actor.lifecycle": Capability("exact", "approximate", "Bridge spawns/destroys on authoritative frame edges."),
    "actor.trajectory": Capability("approximate", "approximate", "Native mode follows the authored path with controls; CARLA physics owns the observed trajectory. Exact pose application is diagnostic-only."),
    "actor.native_controls": Capability("exact", "unsupported", "Bridge applies signed fixed-step vehicle/walker controls; CARLA physics owns motion and contact response."),
    "actor.route": Capability("exact", "approximate", "Route result is baked into the authoritative trajectory."),
    "actor.lane_change": Capability("exact", "approximate", "Lane-change result is baked; native dynamics are not claimed."),
    "actor.speed": Capability("exact", "exact", "Absolute speed is in the documented ScenarioRunner subset."),
    "vehicle.lights": Capability("exact", "approximate", "Public VehicleLightState supports lamps; blueprint support must be probed."),
    "vehicle.siren": Capability("approximate", "unsupported", "No portable siren bit exists; require an allowlisted blueprint attribute/component."),
    "pedestrian.trajectory": Capability("exact", "approximate", "Pose is exact; animation/gait is render-only and separately reported."),
    "static.object": Capability("exact", "approximate", "Requires an exact allowlisted blueprint or asset binding."),
    "traffic_signal.state": Capability("exact", "unsupported", "Freeze and control actors resolved by exact OpenDRIVE signal ID."),
    "traffic_signal.flashing": Capability("approximate", "unsupported", "CARLA has no flashing enum; bridge schedules on/off edges."),
    "traffic_signal.controller_logic": Capability("exact", "unsupported", "UniScenarios evaluates logic; bridge applies resulting head states."),
    "weather": Capability("exact", "approximate", "Public weather parameters are supported after explicit field mapping."),
    "collision.observe": Capability("exact", "approximate", "Passive collision sensors record first-contact frame/time/pair/impulse and segment parity at the contact boundary."),
    "camera.rgb": Capability("exact", "unsupported", "CARLA camera sensor output is recorded by frame."),
    "sensor.depth_semantic_instance": Capability("exact", "unsupported", "Camera calibration and frame closure are immutable evidence."),
    "sensor.lidar_radar": Capability("unsupported", "unsupported", "The current render-spec contract does not expose lidar or radar; reject rather than silently substitute a camera."),
    "sensor.depth_lidar_radar": Capability("unsupported", "unsupported", "Legacy aggregate identifier; depth is supported only through camera.depth, while lidar and radar remain fail-closed."),
    "custom.map.opendrive": Capability("exact", "approximate", "Load identical XODR; visual assets need a packaged custom map."),
    "custom.prop.procedural": Capability("unsupported", "unsupported", "Reject until a catalog asset is explicitly bound."),
    "occlusion.metric": Capability("exact", "unsupported", "UniScenarios evaluates the metric; CARLA sensor evidence is supplementary."),
}


@dataclass(frozen=True)
class NativeGate:
    allowed: bool
    unsupported: tuple[str, ...]
    approximate: tuple[str, ...]


def assess_scenario_runner_1_0(required_semantics: list[str]) -> NativeGate:
    """Gate an optional OSC 1.0 down-converter; unknown semantics are blocking."""
    unsupported: list[str] = []
    approximate: list[str] = []
    for semantic in sorted(set(required_semantics)):
        capability = BRIDGE_CAPABILITIES.get(semantic)
        if capability is None or capability.scenario_runner_1_0 == "unsupported":
            unsupported.append(semantic)
        elif capability.scenario_runner_1_0 == "approximate":
            approximate.append(semantic)
    # Native execution is permitted only for exact mappings. Approximation is
    # useful in reports but never enough to cross the execution gate.
    return NativeGate(not unsupported and not approximate, tuple(unsupported), tuple(approximate))
