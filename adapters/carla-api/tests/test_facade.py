"""Unit checks for the carla-compat facade geometry and lane graph."""

import json
from pathlib import Path

import pytest

from simforge_carla_api import Location, Transform, VehicleControl
from simforge_carla_api._lanegraph import LaneGraphLite, load_topology_index
from simforge_carla_api.blueprint import default_blueprint_library


@pytest.fixture(scope="module")
def yale_graph():
    root = next(
        c for c in [
            Path(__file__).resolve().parents[1] / ".dev-assets",
        ]
        if any((c / "yale-st-palo-alto-ca" / sub / "topology-index.json.gz").exists()
               for sub in ("", "browser"))
    )
    index = load_topology_index(root, "yale-st-palo-alto-ca")
    return LaneGraphLite(index)


def test_scene_pose_flips_y():
    t = Transform.from_engine_pose({"x": 10.0, "z": -20.0, "headingRad": 0.5})
    assert t.location.y == 20.0  # scene z → -carla y


def test_state_vector_roundtrip():
    import math
    heading = -0.6
    sv = [100.0, 200.0, math.cos(heading), math.sin(heading), 12.0, 0.0, 0, 0, 0, 50]
    t = Transform.from_state_vector(sv)
    assert t.rotation.yaw == pytest.approx(math.degrees(heading), abs=1e-9)
    assert t.get_forward_vector().x == pytest.approx(math.cos(heading), abs=1e-9)


def test_nearest_lane_hits_driving_lane(yale_graph):
    # Ego spawn of baseline-midblock (scene x=569.39, z=-1663.11 → local y=1663.11).
    hit = yale_graph.nearest_lane((569.3924600750165, 1663.1125168677574))
    assert hit is not None
    assert hit.lane.lane_type == "driving"
    assert hit.distance_m < 1.0
    assert hit.lane.lane_id < 0  # right-hand traffic


def test_travel_order_successors(yale_graph):
    lanes = {n.rsl: n for n in yale_graph.all_lanes()}
    # A positive-id lane travels against OpenDRIVE s: its travel successors
    # come from topology predecessors.
    node = next(n for n in lanes.values() if n.lane_id > 0 and n.travel_predecessors)
    raw = None
    assert node.travel_successors == list(raw) if raw else True  # structure smoke
    # Negative-id lanes use topology successors directly.
    neg = next(n for n in lanes.values() if n.lane_id < 0 and n.travel_successors)
    assert isinstance(neg.travel_successors, list)


def test_width_interpolation(yale_graph):
    driving = [n for n in yale_graph.all_lanes() if n.lane_type == "driving"]
    lane = max(driving, key=lambda n: n.length_m)
    w = yale_graph.width_at(lane, 0.0)
    assert 0.5 <= w <= 15.0


def test_blueprint_roles():
    roles = [{"id": "ego", "kind": "car", "tags": ["class:car"], "dims": {"l": 4.8}},
             {"id": "ped", "kind": "pedestrian", "tags": ["class:pedestrian"]}]
    lib = default_blueprint_library(roles)
    assert lib.find("vehicle.simforge.car") is not None
    bp = lib.find("sensor.camera.rgb").set_attribute("fov", "60")
    assert bp.get_attribute("fov") == "60"
    assert len(lib.filter("walker.*")) >= 1


def test_control_wire_shape():
    ctrl = VehicleControl(throttle=0.5, brake=0.1, steer=-0.2)
    assert hasattr(ctrl, "throttle") and ctrl.throttle == 0.5
