"""``carla.World``: ticks, actor handles, map access, synchronous settings."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .actors import Actor, Sensor, Vehicle, Walker
from .blueprint import BlueprintLibrary, default_blueprint_library
from .debug import Color, DebugHelper
from .geom import Location, Rotation, Transform, Vector3D
from .map import Map
from .weather import (
    WeatherParameters,
    from_operational_conditions,
    scenario_weather_patch,
    to_operational_conditions,
)
from .xodr_surface import load_surface


@dataclass
class WorldSettings:
    """Only the deterministic synchronous mode exists on this engine."""

    synchronous_mode: bool = True
    fixed_delta_seconds: float = 0.1  # one decision at the default 10 Hz
    substepping: bool = False


@dataclass(frozen=True)
class WorldSnapshot:
    id: int  # tick counter
    frame: int
    timestamp: float  # engine seconds of the decision just applied


class ActorStateError(RuntimeError):
    pass


class World:
    """One env-server session seen through the CARLA world surface."""

    def __init__(self, client, session: int = 0) -> None:
        self._client = client
        self.session = session
        hello = client.connection.request({"op": "hello"})
        if hello.get("sessions", 0) <= session:
            raise RuntimeError(f"server hosts {hello.get('sessions')} sessions; requested {session}")
        self.decision_hz = hello["decisionHz"]
        self.ego_id = hello["egos"][session]
        self._tick_count = 0
        self._last_step: dict | None = None
        # Authored scenario (roles + initial poses), read once from the spec.
        self.scenario = client.load_scenario(session)
        self._tick_count = 0
        self._reset_done = False
        self._settings = WorldSettings(fixed_delta_seconds=1.0 / self.decision_hz)
        self._frame_source = client.create_frame_source(self.scenario)
        self._map = Map(
            self.scenario.map_id,
            client.load_lane_graph(self.scenario.map_id),
            [Transform.from_engine_pose(pose) for _, pose in sorted(self.scenario.spawn_poses.items())],
            client=client,
        )
        self._blueprints = default_blueprint_library(self.scenario.roles)
        self._actors: dict[int, Actor] = {}
        self._next_actor_id = 1000
        # Authored actors exist from tick 0 (engine is scenario-authoritative):
        # bind a facade handle per role so get_actors()/get_actor() see them,
        # exactly like a CARLA server reporting its live actors.
        self._bind_authored_actors()
        #: Draw-call queue (zones/geofence overlays); frontends consume it.
        self.debug = DebugHelper()
        #: Weather: authored conditions + any set_weather overrides.
        self._weather = from_operational_conditions(self.scenario.operational_conditions)
        self._weather_patch: dict | None = None

    # ------------------------------------------------------------- settings

    def get_settings(self) -> WorldSettings:
        return WorldSettings(**self._settings.__dict__)

    def apply_settings(self, settings: WorldSettings) -> WorldSnapshot:
        if not settings.synchronous_mode:
            raise RuntimeError("this engine only serves the synchronous mode "
                               "(determinism is a contract, not an option)")
        self._settings = settings
        return self.get_snapshot()

    def get_snapshot(self) -> WorldSnapshot:
        t = self._last_step["t_s"] if self._last_step else 0.0
        return WorldSnapshot(id=self._tick_count, frame=self._tick_count, timestamp=t)

    # ------------------------------------------------------------------ map

    def get_map(self) -> Map:
        return self._map

    def get_blueprint_library(self) -> BlueprintLibrary:
        return self._blueprints

    # --------------------------------------------------------------- actors

    def spawn_actor(self, blueprint, transform: Transform, attach_to: Actor | None = None):
        """Bind a facade handle.

        - Vehicle/walker blueprints bind by ``role_name`` to an authored actor;
          ``transform`` is accepted for API compatibility but the engine's own
          initial pose wins (the engine is authoritative).
        - Sensor blueprints attach to a parent vehicle and are served by the
          configured FrameSource.
        """
        if blueprint.type_id.startswith("sensor."):
            if blueprint.type_id != "sensor.camera.rgb":
                raise NotImplementedError(
                    f"{blueprint.type_id}: only sensor.camera.rgb is backed today (README)")
            if attach_to is None:
                raise ValueError("sensors need attach_to=<parent actor>")
            sensor = Sensor(
                self,
                actor_id=self._next_free_actor_id(),
                type_id=blueprint.type_id,
                role_name=f"camera:{attach_to.role_name or attach_to.id}",
                attributes=dict(blueprint.attributes),
            )
            sensor._frame_source = self._frame_source
            self._next_actor_id += 1
            self._actors[sensor.id] = sensor
            return sensor

        role_name = blueprint.role_name
        authored = {r["id"]: r for r in self.scenario.roles}
        if role_name not in authored:
            raise RuntimeError(
                f"cannot spawn '{blueprint.type_id}': no authored actor with "
                f"role_name={role_name!r}. The engine is scenario-authoritative; "
                f"bind existing roles instead (authored: {sorted(authored)})."
            )
        existing = next((a for a in self._actors.values()
                         if a.role_name == role_name), None)
        if existing is not None:
            return existing
        cls = next((t.split(":", 1)[1] for t in authored[role_name].get("tags", [])
                    if t.startswith("class:")), "")
        base = dict(actor_id=self._next_free_actor_id(), type_id=blueprint.type_id, role_name=role_name)
        if authored[role_name].get("kind") == "pedestrian" or cls == "pedestrian":
            actor = Walker(self, **base)
        else:
            actor = Vehicle(self, **base)
        self._actors[actor.id] = actor
        return actor

    try_spawn_actor = spawn_actor

    def _bind_authored_actors(self) -> None:
        """One facade handle per authored role (idempotent)."""
        for role in sorted(self.scenario.roles, key=lambda r: r["id"]):
            role_name = role["id"]
            if any(a.role_name == role_name for a in self._actors.values()):
                continue
            cls = next((t.split(":", 1)[1] for t in role.get("tags", [])
                        if t.startswith("class:")), "")
            is_ped = role.get("kind") == "pedestrian" or cls == "pedestrian"
            actor_cls = Walker if is_ped else Vehicle
            type_id = f"walker.uniscenarios.pedestrian" if is_ped else "vehicle.uniscenarios.car"
            actor = actor_cls(self, actor_id=self._next_free_actor_id(),
                              type_id=type_id, role_name=role_name)
            self._actors[actor.id] = actor

    def _next_free_actor_id(self) -> int:
        while self._next_actor_id in self._actors:
            self._next_actor_id += 1
        return self._next_actor_id

    def get_actors(self, ids=None) -> list[Actor]:
        actors = [a for a in self._actors.values() if a.is_alive and not isinstance(a, Sensor)]
        if ids is not None:
            wanted = set(ids)
            actors = [a for a in actors if a.id in wanted]
        return actors

    def get_actor(self, actor_id: int) -> Actor | None:
        return self._actors.get(actor_id)

    def actor_state(self, actor_id) -> dict | None:
        """Engine-derived state for one bound actor at the current tick."""
        step = self._last_step
        if step is None:
            return None
        role = next((a for a in self._actors.values() if a.id == actor_id), None)
        key = role.role_name if role else str(actor_id)
        if key == self.ego_id and step.get("state_vector") is not None:
            sv = step["state_vector"]
            return {
                "transform": Transform.from_state_vector(sv),
                "speed_mps": float(sv[4]),
                "accel_mps2": float(sv[5]),
            }
        derived = step["derived_positions"].get(key)
        if derived is None:
            return None
        position, heading, speed = derived
        return {
            "transform": Transform(location=Location(x=position[0], y=position[1], z=0.0),
                                   rotation=Rotation(yaw=heading)),
            "speed_mps": speed,
            "accel_mps2": 0.0,
        }

    # ----------------------------------------------------------------- tick

    def tick(self, seconds: float | None = None) -> WorldSnapshot:
        """Advance exactly one decision; deliver camera frames that are ready."""
        if not self._reset_done or (
                self._last_step is not None
                and (self._last_step["terminated"] or self._last_step["truncated"])):
            # Episode over (authored clip length): restart deterministically so
            # the world keeps ticking, like a CARLA server would.
            self._client.connection.request({"op": "reset", "s": self.session})
            self._reset_done = True
        action = None
        for actor in self._actors.values():
            if isinstance(actor, Vehicle) and actor.pending_action is not None:
                action = actor.pending_action
                break
        result = self._client.connection.request({"op": "step", "s": self.session, "a": action or {}})
        self._tick_count += 1
        sv_raw = result.get("sv")
        self._last_step = {
            "t_s": float(result["t"]),
            "reward": result.get("rw"),
            "terminated": bool(result.get("term")),
            "truncated": bool(result.get("trunc")),
            "state_vector": np.frombuffer(sv_raw, dtype=np.float64) if sv_raw is not None else None,
            "objects": [
                {"id": o[0], "range_m": o[1], "bearing_rad": o[2], "range_rate_mps": o[3],
                 "line_of_sight": bool(o[4])}
                for o in result.get("objs") or []
            ],
            "derived_positions": {},
        }
        self._derive_other_actors()
        for actor in list(self._actors.values()):
            if isinstance(actor, Sensor) and actor.is_listening():
                actor._tick(float(result["t"]))  # noqa: SLF001 - same package
        return self.get_snapshot()

    wait_for_tick = tick

    def _derive_other_actors(self) -> None:
        """Non-ego positions reconstructed from perception (see README limits)."""
        import math

        step = self._last_step
        ego_state = None
        for actor in self._actors.values():
            if actor.role_name == self.ego_id:
                sv = step["state_vector"]
                if sv is not None:
                    ego_state = Transform.from_state_vector(sv)
                    break
        if ego_state is None:
            return
        yaw = ego_state.yaw_rad
        ex, ey = ego_state.location.x, ego_state.location.y
        prev = getattr(self, "_prev_positions", {})
        current: dict[str, tuple[tuple[float, float], float, float]] = {}
        for obj in step["objects"]:
            # bearing is positive-left from the ego heading.
            angle = yaw + obj["bearing_rad"]
            x = ex + obj["range_m"] * math.cos(angle)
            y = ey + obj["range_m"] * math.sin(angle)
            last = prev.get(obj["id"])
            if last is not None and obj["range_rate_mps"]:
                dt = 1.0 / self.decision_hz
                dx, dy = x - last[0], y - last[1]
                moved = math.hypot(dx, dy)
                speed = moved / dt if moved > 1e-6 else abs(obj["range_rate_mps"])
                heading = math.atan2(dy, dx)
            elif last is not None:
                dx, dy = x - last[0], y - last[1]
                speed = abs(obj["range_rate_mps"])
                heading = math.atan2(dy, dx)
            else:
                # First sighting: no motion history yet; face along ego.
                speed = abs(obj["range_rate_mps"])
                heading = yaw
            current[obj["id"]] = ((x, y), heading, speed)
        step["derived_positions"] = current
        self._prev_positions = {k: v[0] for k, v in current.items()}

    # ---------------------------------------------------------------- misc

    def get_weather(self) -> WeatherParameters:
        """The effective weather: authored conditions or last set_weather."""
        return self._weather

    def set_weather(self, weather: WeatherParameters | dict | str,
                    time_of_day: str | None = None) -> None:
        """Record desired weather in scenario vocabulary (README: fidelity).

        Accepts a WeatherParameters, a plain dict of CARLA fields, or an
        enum string ('clear' | 'rain' | 'overcast'). Updates get_weather()
        immediately and is baked into subsequently loaded worlds
        (client.load_world). It does NOT re-render live pixels: rendering
        replays authored clips until the native render service lands.
        """
        if isinstance(weather, str):
            self._weather_patch = scenario_weather_patch(weather, time_of_day)
            conditions = {**self.scenario.operational_conditions, **self._weather_patch}
        else:
            self._weather_patch = to_operational_conditions(weather)
            conditions = {**self.scenario.operational_conditions, **self._weather_patch}
        self._weather = from_operational_conditions(conditions)

    @property
    def weather_patch(self) -> dict | None:
        """Partial operationalConditions encoding the set_weather call."""
        return self._weather_patch

    # ---------------------------------------------------- ground projection

    @property
    def _surface(self):
        """Road-surface Z lookup for the current map (cached per map)."""
        from ._lanegraph import find_dev_assets

        root = self._map.dev_assets_root or find_dev_assets(None)
        return load_surface(root, self.scenario.map_id)

    def ground_projection(self, location: Location, search_distance: float = 2.0):
        """Nearest road-surface point under ``location`` (carla 0.10 shape).

        Returns an object with ``.location`` (snapped x/y + surface Z) and a
        planar ``.normal``, or None when no lane lies within
        ``search_distance``. Z comes from the source XODR elevation profile
        of the hit lane's road (see uniscenarios_carla/xodr_surface.py).
        """
        hit = self._map._graph.nearest_lane((location.x, location.y), max_distance_m=float(search_distance))
        if hit is None:
            return None
        z = None
        try:
            z = self._surface.z_at(hit.lane.road_id, hit.point[0], hit.point[1])
            if z is None:
                z = self._surface.z_anywhere(hit.point[0], hit.point[1])
        except FileNotFoundError:
            z = None
        ground = GroundProjectionResult(
            location=Location(x=hit.point[0], y=hit.point[1], z=(z or 0.0)),
            normal=Vector3D(x=0.0, y=0.0, z=1.0),
        )
        return ground

    @property
    def traffic_manager(self):
        tm = getattr(self._client, "_traffic_manager", None)
        return tm

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<World session={self.session} ego={self.ego_id!r} map={self._map.name!r}>"


@dataclass(frozen=True)
class GroundProjectionResult:
    """carla 0.10 ground_projection shape: location + surface normal."""

    location: Location
    normal: Vector3D



