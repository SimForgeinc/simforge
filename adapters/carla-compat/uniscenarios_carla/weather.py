"""Weather surface: ``carla.WeatherParameters`` mapped onto the scenario
weather vocabulary.

The engine's scenario field is ``operationalConditions``:

- ``weather``: ``clear | rain | overcast``
- ``timeOfDay``: ``day | dusk | night | dawn``
- ``effects``: ``{visibilityRangeM, frictionScale, trafficSpeedFactor}``

CARLA callers pass a numeric parameter bag. The mapping below is the
single source of truth for both directions:

- **get_weather()** synthesizes a WeatherParameters from the session's
  operational conditions (so the value reflects the authored episode).
- **set_weather(...)** accepts a WeatherParameters, a plain dict of CARLA
  fields, or one of the scenario enum strings; it updates the world's
  desired conditions immediately (visible to later ``get_weather``) and is
  baked into every subsequently loaded world via ``client.load_world``.
  There is **no runtime pixel effect**: rendering comes from the render
  path's clip of the authored episode (README coverage matrix).

Numeric fields outside the mapped set are stored verbatim and round-trip,
but do not reach the engine ("intensity passthrough" is limited to the
fields the engine actually models: fog density/distance ↔ visibilityRangeM,
"""

from dataclasses import dataclass, fields

#: Scenario weather enum (sim-engine operationalConditionsSchema.weather).
SCENARIO_WEATHER = ("clear", "rain", "overcast")
#: Scenario time-of-day enum.
SCENARIO_TIME_OF_DAY = ("day", "dusk", "night", "dawn")

#: Bright-noon defaults used at bridge connect (V2XCarla carla_connection.py).
BRIGHT_NOON = {
    "cloudiness": 0.0,
    "precipitation": 0.0,
    "precipitation_deposits": 0.0,
    "wind_intensity": 30.0,
    "sun_azimuth_angle": 180.0,
    "sun_altitude_angle": 75.0,
    "fog_density": 0.0,
    "fog_distance": 100000.0,
    "fog_falloff": 0.1,
    "wetness": 0.0,
    "scattering_intensity": 1.0,
    "mie_scattering_scale": 0.03,
    "rayleigh_scattering_scale": 0.0331,
    "dust_storm": 0.0,
}


@dataclass(frozen=True)
class WeatherParameters:
    """The subset of carla.WeatherParameters the V2X bridge touches."""

    cloudiness: float = 0.0
    precipitation: float = 0.0
    precipitation_deposits: float = 0.0
    wind_intensity: float = 30.0
    sun_azimuth_angle: float = 180.0
    sun_altitude_angle: float = 75.0
    fog_density: float = 0.0
    fog_distance: float = 100000.0
    fog_falloff: float = 0.1
    wetness: float = 0.0
    scattering_intensity: float = 1.0
    mie_scattering_scale: float = 0.03
    rayleigh_scattering_scale: float = 0.0331
    dust_storm: float = 0.0


    @classmethod
    def bright_noon(cls) -> "WeatherParameters":
        """The bridge's connect-time weather state."""
        return cls(**BRIGHT_NOON)

def from_operational_conditions(conditions: dict) -> WeatherParameters:
    """Synthesize CARLA-style parameters from ``operationalConditions``.

    Mapping (documented in the README coverage matrix):

    - clear + day   → bright noon (the bridge's connect-time state)
    - overcast      → cloudiness 85, dimmed sun
    - rain          → cloudiness 85, precipitation scaled to 70 max
                      (engine has no intensity number), wetness 80
    - night         → sun altitude −10° (below horizon); dusk → 8°;
                      dawn → 15°; day keeps 75°
    - effects.visibilityRangeM caps fog_distance and drives fog_density
      when it is finite and below 10 km (intensity passthrough).
    """
    weather = str(conditions.get("weather", "clear"))
    tod = str(conditions.get("timeOfDay", "day"))
    effects = conditions.get("effects") or {}

    params = dict(BRIGHT_NOON)
    if weather == "overcast":
        params["cloudiness"] = 85.0
        params["sun_altitude_angle"] = 45.0
    elif weather == "rain":
        params["cloudiness"] = 85.0
        params["precipitation"] = 70.0
        params["precipitation_deposits"] = 70.0
        params["wetness"] = 80.0
        params["sun_altitude_angle"] = 35.0

    if tod == "night":
        params["sun_altitude_angle"] = -10.0
    elif tod == "dusk":
        params["sun_altitude_angle"] = 8.0
    elif tod == "dawn":
        params["sun_altitude_angle"] = 15.0

    vis_m = effects.get("visibilityRangeM")
    if isinstance(vis_m, (int, float)) and vis_m < 10000.0:
        params["fog_distance"] = float(vis_m)
        # Dense fog cue when the declared range is short; linear 25% density
        # at ≤100 m visibility down to zero at 1 km.
        params["fog_density"] = max(0.0, min(25.0, 25.0 * (1.0 - (vis_m - 100.0) / 900.0)))
    return WeatherParameters(**params)


def to_operational_conditions(wp: WeatherParameters | dict) -> dict:
    """Project CARLA-style parameters onto the scenario vocabulary.

    Returns the partial ``operationalConditions`` patch (``weather``,
    ``timeOfDay``, ``effects.visibilityRangeM``) that encodes these
    parameters; unknown numeric fields are accepted but dropped (they have
    no engine target — see module docstring).
    """
    if isinstance(wp, WeatherParameters):
        d = {f.name: getattr(wp, f.name) for f in fields(WeatherParameters)}
    else:
        base = dict(BRIGHT_NOON)
        known = {f.name for f in fields(WeatherParameters)}
        d = {k: v for k, v in wp.items() if k in known}
        merged = {**base, **d}
        d = merged
    patch: dict = {}
    if d.get("precipitation", 0) > 5:
        patch["weather"] = "rain"
    elif d.get("cloudiness", 0) > 50:
        patch["weather"] = "overcast"
    else:
        patch["weather"] = "clear"

    alt = d.get("sun_altitude_angle", 75.0)
    if alt < 0:
        patch["timeOfDay"] = "night"
    elif alt < 12:
        patch["timeOfDay"] = "dusk"
    elif alt < 25:
        patch["timeOfDay"] = "dawn"
    else:
        patch["timeOfDay"] = "day"

    fog_distance = d.get("fog_distance", 100000.0)
    effects: dict = {"visibilityRangeM": min(float(fog_distance), 1000.0)}
    patch["effects"] = effects
    return patch


def scenario_weather_patch(weather: str, time_of_day: str | None = None) -> dict:
    """Validate an enum-style patch against the scenario vocabulary."""
    if weather not in SCENARIO_WEATHER:
        raise ValueError(
            f"weather={weather!r}: engine supports {SCENARIO_WEATHER} "
            "(scenario operationalConditions enum)")
    patch = {"weather": weather}
    if time_of_day is not None:
        if time_of_day not in SCENARIO_TIME_OF_DAY:
            raise ValueError(f"timeOfDay={time_of_day!r} not in {SCENARIO_TIME_OF_DAY}")
        patch["timeOfDay"] = time_of_day
    return patch
