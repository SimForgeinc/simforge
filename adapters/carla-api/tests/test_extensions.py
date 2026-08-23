"""V3 facade extensions: unit + real-session integration tests.

Session-backed tests run against the actual env-server on repo-committed
scenario instances (yale-street) and, when the local instance pool carries
one, richmond-field-station.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from uniscenarios_carla import (
    Client,
    Color,
    LaneType,
    Location,
    Vector3D,
    Vehicle,
    WeatherParameters,
)
from uniscenarios_carla.debug import DebugHelper
from uniscenarios_carla.geoloc import (
    METERS_PER_DEG_LAT,
    GeoOrigin,
    geolocation_to_transform,
    parse_geo_origin_text,
    transform_to_geolocation,
)
from uniscenarios_carla.lane_types import TOPOLOGY_TO_FLAG
from uniscenarios_carla.physics import build_physics_control, resolve_physics_profile
from uniscenarios_carla.trafficmanager import PRESET_DENSITY_VEHICLES_PER_KM, TrafficManager
from uniscenarios_carla.weather import (
    from_operational_conditions,
    scenario_weather_patch,
    to_operational_conditions,
)
from uniscenarios_carla.xodr_surface import load_surface


# ---------------------------------------------------------------- weather

def test_weather_enum_mapping_roundtrip():
    wp = from_operational_conditions(
        {"weather": "clear", "timeOfDay": "day", "effects": {"visibilityRangeM": 1000}})
    assert isinstance(wp, WeatherParameters)
    patch = to_operational_conditions(wp)
    assert patch["weather"] == "clear"
    assert patch["timeOfDay"] == "day"
    # Round-trip through the vocabulary is stable for the mapped fields.
    again = from_operational_conditions(patch)
    assert abs(again.sun_altitude_angle - wp.sun_altitude_angle) < 1e-9


def test_weather_rain_and_night_mapping():
    rain = to_operational_conditions(WeatherParameters(precipitation=70))
    assert rain["weather"] == "rain"
    night = to_operational_conditions({"sun_altitude_angle": -10})
    assert night["timeOfDay"] == "night"
    fog = to_operational_conditions({"fog_distance": 150})
    assert fog["effects"]["visibilityRangeM"] == 150


def test_weather_enum_validation():
    with pytest.raises(ValueError):
        scenario_weather_patch("fog")  # not in engine vocabulary
    assert scenario_weather_patch("overcast")["weather"] == "overcast"


# -------------------------------------------------------------- lane types

def test_lane_type_flags():
    assert (LaneType.Driving | LaneType.Sidewalk).value == 0x3
    mask = LaneType.Driving | LaneType.Sidewalk
    strings = ("driving", "sidewalk")
    resolved = Map_strings(mask)
    assert set(resolved) == set(strings)


def Map_strings(mask):
    from uniscenarios_carla.map import Map
    return Map._topology_strings_for(mask)


# ---------------------------------------------------------------- physics

def test_physics_profile_defaults_and_overrides():
    car = {"id": "ego", "kind": "car", "dims": {"l": 4.7, "w": 1.82}}
    prof = resolve_physics_profile(car, None)
    # Mirrors sim-engine GENERIC_PASSENGER_CAR_PROFILE.
    assert prof["wheelbaseM"] == pytest.approx(2.7)
    assert prof["maxSteerRad"] == pytest.approx(0.58)

    override = resolve_physics_profile(car, {"ego": {"wheelbaseM": 2.9, "maxSteerRad": 0.5}})
    assert override["wheelbaseM"] == pytest.approx(2.9)
    assert override["maxSteerRad"] == pytest.approx(0.5)


def test_physics_control_wheel_geometry_matches_legacy_extraction():
    actor = {"id": "ego", "kind": "car", "dims": {"l": 4.7, "w": 1.82}}
    phys = build_physics_control(actor, None)
    assert len(phys.wheels) == 4
    # Legacy trajectory_player extraction: front axle mean − rear axle mean, cm→m.
    fx = (phys.wheels[0].position_x_cm + phys.wheels[1].position_x_cm) / 2.0
    rx = (phys.wheels[2].position_x_cm + phys.wheels[3].position_x_cm) / 2.0
    wheelbase = abs(fx - rx) / 100.0
    assert wheelbase == pytest.approx(phys.wheelbase_m)
    assert phys.wheelbase_m == pytest.approx(2.7)
    max_steer = max(w.max_steer_angle for w in phys.wheels[:2])
    assert max_steer == pytest.approx(math.degrees(0.58), abs=1e-9)
    assert all(w.max_steer_angle == 0.0 for w in phys.wheels[2:])


def test_physics_wheelbase_capped_by_dims():
    bus = {"id": "b", "kind": "bus", "dims": {"l": 5.0}}  # shorter than profile wb
    prof = resolve_physics_profile(bus, None)
    assert prof["wheelbaseM"] >= 6.0  # profile value…
    phys = build_physics_control(bus, None)
    assert phys.wheelbase_m <= 5.0  # …capped inside authored length


# ------------------------------------------------------------ debug queue

def test_debug_queue_records_and_consumes():
    dbg = DebugHelper()
    dbg.draw_line(Location(x=0, y=0, z=0), Location(x=10, y=0, z=0),
                  thickness=0.5, color=Color(r=0, g=255, b=0), life_time=999)
    dbg.draw_point(Location(x=1, y=1, z=0), size=0.2)
    snap = dbg.consume()
    assert len(snap["lines"]) == 1 and len(snap["points"]) == 1
    line = snap["lines"][0]
    assert line["end"][0] == pytest.approx(10.0)
    assert line["color"] == [0, 255, 0, 255]
    assert dbg.consume()["lines"] == []  # consume clears


# -------------------------------------------------------- traffic manager

def test_trafficmanager_surface_and_unsupported():
    tm = TrafficManager(client=None, port=8123)
    tm.set_synchronous_mode(True)
    assert tm.synchronous_mode is True
    tm.global_percentage_speed_difference(30.0)  # drive at 70 %
    assert tm.speed_scale == pytest.approx(0.7)
    assert tm.ambient_profile_snapshot()["registeredAutopilotActors"] == []


# ------------------------------------------------------------- geolocation

_RICHMOND_GEO_REF = (
    "+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857 "
    "+k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs"
)

#: Golden vectors from fixtures/v2x-richmond-golden-projections.json
#: The fixture's WGS-84 column is strict tmerc; the facade frame is
#: flat-earth, so the honest tolerance is the per-point cross-frame
#: divergence the fixture itself records.
_GOLDEN_POINTS = [
    ("camera-pole", -130.0295, 56.835, 37.91560117, -122.334787564, 0.2324),
    ("junction-61-center", -181.0, -61.0, 37.914539536, -122.335367186, 0.292),
    ("map-origin", 0.0, 0.0, 37.915089129, -122.333308831, 0.0),
    ("north-east-quadrant", 300.0, 300.0, 37.917791906, -122.329897042, 0.9471),
]


@pytest.mark.parametrize("point_id,x,y,lat,lon,delta_m", _GOLDEN_POINTS,
                         ids=[p[0] for p in _GOLDEN_POINTS])
def test_geolocation_matches_golden_fixtures(point_id, x, y, lat, lon, delta_m):
    origin = parse_geo_origin_text(_RICHMOND_GEO_REF)
    geo = transform_to_geolocation(origin, x, y)
    tol_deg = delta_m / METERS_PER_DEG_LAT + 1e-7
    assert geo.latitude == pytest.approx(lat, abs=tol_deg)
    assert geo.longitude == pytest.approx(lon, abs=tol_deg / math.cos(math.radians(origin.lat0)))
    # Flat-earth round-trip of its own output is exact to sub-mm.
    bx, by = geolocation_to_transform(origin, geo.latitude, geo.longitude)
    assert bx == pytest.approx(x, abs=1e-6)
    assert by == pytest.approx(y, abs=1e-6)


def test_geolocation_flat_earth_matches_geo_utils_formula():
    origin = GeoOrigin(lat0=37.9150891287087, lon0=-122.333308830857)
    lat, lon = 37.916, -122.334
    expected_x = (lon - origin.lon0) * METERS_PER_DEG_LAT * math.cos(math.radians(origin.lat0))
    x, y = geolocation_to_transform(origin, lat, lon)
    assert x == pytest.approx(expected_x)
    assert y == pytest.approx((lat - origin.lat0) * METERS_PER_DEG_LAT)


# ============================================================ real sessions

def test_session_physics_control(yale_world):
    ego = next(iter(yale_world.get_actors()))
    phys = ego.get_physics_control()
    assert phys.mass_kg > 0
    assert 1.0 <= phys.wheelbase_m <= 6.5
    assert 15.0 <= math.degrees(phys.max_steer_angle_rad) <= 75.0


def test_session_set_target_velocity_moves_vehicle(yale_world):
    ego = next(a for a in yale_world.get_actors() if isinstance(a, Vehicle))
    start_speed = math.hypot(*_xy_vel(ego))
    fwd = ego.get_transform().get_forward_vector()
    ego.set_target_velocity(Vector3D(fwd.x * 16.0, fwd.y * 16.0, 0.0))
    try:
        speed = start_speed
        for _ in range(100):
            yale_world.tick()
            speed = math.hypot(*_xy_vel(ego))
        # The env-server's speed controller drives toward the intent even
        # against authored choreography; require clear acceleration.
        assert speed > start_speed + 1.5
    finally:
        ego.set_target_velocity(Vector3D())


def _xy_vel(actor):
    v = actor.get_velocity()
    return v.x, v.y


def test_session_ground_projection_and_sidewalk(yale_world):
    ego = next(iter(yale_world.get_actors()))
    loc = ego.get_location()
    ground = yale_world.ground_projection(loc, search_distance=20.0)
    assert ground is not None
    assert ground.location.z > 0.5  # yale sits ~11–13 m above datum
    lane = yale_world.get_map().get_waypoint(
        ground.location, project_to_road=True, lane_type=LaneType.Sidewalk)
    if lane is not None:  # yale carries sidewalk lanes
        assert lane.lane_type == "sidewalk"


def test_session_map_digest_identity(yale_world, dev_assets_root):
    digest = yale_world.get_map().digest
    bundle = json.loads((dev_assets_root / "yale-street" / "bundle.json").read_text())
    assert digest["mapId"] == "yale-street"
    assert digest["xodrSha256"] == bundle["xodrSha256"]


def test_session_geolocation_roundtrip(yale_world):
    m = yale_world.get_map()
    ego = next(iter(yale_world.get_actors()))
    here = ego.get_location()
    geo = m.transform_to_geolocation(here)
    back = m.geolocation_to_transform(geo).location
    assert back.x == pytest.approx(here.x, abs=0.05)
    assert back.y == pytest.approx(here.y, abs=0.05)


def test_session_load_world_richmond_with_baked_weather(dev_assets_root):
    from uniscenarios_carla.maps import find_instance_for_map, instance_search_roots
    if find_instance_for_map("richmond-field-station", instance_search_roots()) is None:
        pytest.skip("no richmond instance in local pools")
    client = Client()
    try:
        world = client.load_world("richmond-field-station", weather="rain",
                                  traffic="light")
        assert world.get_map().name == "richmond-field-station"
        digest = world.get_map().digest
        assert digest["xodrSha256"] == \
            "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643"
        world.tick()
        assert world.get_weather().precipitation > 0
        # Ground truth Z from the source XODR elevation profile:
        surface = load_surface(dev_assets_root, "richmond-field-station")
        assert surface.z_anywhere(0.0, 0.0) is not None
    finally:
        client.close()


def test_session_available_maps_match_inventory(yale_client, dev_assets_root):
    maps = yale_client.get_available_maps()
    assert "yale-street" in maps and "richmond-field-station" in maps
