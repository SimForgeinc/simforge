"""``carla.Client`` facade: connects to one UniScenarios env-server."""

from __future__ import annotations

import gzip
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from ._envclient import ENV_SERVER_PROTOCOL_VERSION, EnvServerClient
from ._lanegraph import LaneGraphLite, find_dev_assets, load_topology_index
from .frames import BrowserClipFrameSource, NullFrameSource


@dataclass
class ScenarioInfo:
    """The authored episode this connection serves (read from the spec file)."""

    instance_path: str
    map_id: str
    metric_subject: str
    roles: list[dict] = field(default_factory=list)
    spawn_poses: dict[str, dict] = field(default_factory=dict)
    trace_path: str | None = None
    #: The instance's operationalConditions (weather/timeOfDay/traffic/effects).
    operational_conditions: dict = field(default_factory=dict)
    #: input.physics.vehicleProfiles per-actor overrides, keyed by actor id.
    vehicle_profiles: dict = field(default_factory=dict)


def _read_json_maybe_gzip(path: Path):
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def load_scenario_info(episodes_spec: str, session: int = 0) -> ScenarioInfo:
    """Read the Nth instance of an episode spec for client-side introspection."""
    doc = json.loads(Path(episodes_spec).read_text())
    instances = doc.get("instances")
    if not instances:
        raise RuntimeError("episode spec must use form A (instances); template "
                           "materialization happens server-side only")
    entry = instances[min(session, len(instances) - 1)]
    path = Path(entry["input"] if isinstance(entry, dict) else entry)
    if not path.is_absolute():
        path = Path(episodes_spec).parent / path
    unwrapped = _read_json_maybe_gzip(path)
    if isinstance(unwrapped, dict) and unwrapped.get("kind") == "scenario-instance" \
            and isinstance(unwrapped.get("input"), dict):
        unwrapped = unwrapped["input"]
    stem = path.with_suffix("") if path.suffix == ".json" else path
    trace_candidates = [
        stem.with_suffix(".trace.json.gz"),
        stem.parent.parent / "traces" / (stem.name + ".trace.json.gz"),
    ]
    trace_path = next((str(c) for c in trace_candidates if c.exists()), None)
    roles = []
    spawn_poses: dict[str, dict] = {}
    for actor in unwrapped.get("actors", []):
        roles.append({"id": actor["id"], "kind": actor.get("kind", "vehicle"),
                      "tags": actor.get("tags", []), "dims": actor.get("dims", {})})
        pose = actor.get("initial", {}).get("pose")
        if pose:
            spawn_poses[actor["id"]] = pose
    return ScenarioInfo(
        instance_path=str(path),
        map_id=unwrapped["mapId"],
        metric_subject=unwrapped.get("metricSubject", ""),
        roles=roles,
        spawn_poses=spawn_poses,
        trace_path=trace_path,
        operational_conditions=unwrapped.get("operationalConditions") or {},
        vehicle_profiles=(unwrapped.get("physics") or {}).get("vehicleProfiles") or {},
    )


class Client:
    """Connects (and lazily spawns) the env-server backing this "CARLA server".

    ``host``/``port`` are accepted for API compatibility and unused: the
    transport is a stdio subprocess unless ``UNISCENARIO_ENV_SERVER`` names an
    explicit command. Configuration comes from:

    - ``UNISCENARIO_EPISODES`` — episode spec path (or ``episodes_spec=``);
    - ``UNISCENARIO_DEV_ASSETS`` — dev-assets root for map artifacts;
    - ``UNISCENARIO_STUDIO_URL`` — Studio viewer for the browser frame source;
    - ``UNISCENARIO_FRAMES`` — ``off`` disables camera frames entirely;
    - ``UNISCENARIO_FRAME_CACHE`` — directory caching rendered clips.
    """

    def __init__(self, host: str = "localhost", port: int = 2000, *,
                 episodes_spec: str | None = None, session: int = 0,
                 clip_seconds: float | None = None, max_decisions: int | None = None,
                 worker_threads: int = 0) -> None:
        self._host, self._port = host, port
        self._session = session
        self._episodes_spec = episodes_spec or os.environ.get("UNISCENARIO_EPISODES")
        self._clip_seconds = clip_seconds
        self._max_decisions = max_decisions
        self._connection: EnvServerClient | None = None
        self._world = None
        self._lane_graphs: dict[str, LaneGraphLite] = {}
        self._scenario: ScenarioInfo | None = None
        self._dev_assets_root = os.environ.get("UNISCENARIO_DEV_ASSETS")
        #: One TrafficManager handle per client (carla semantics).
        self._traffic_manager = None

    # -- lifecycle ----------------------------------------------------------

    @property
    def connection(self) -> EnvServerClient:
        if self._connection is None:
            self._connection = EnvServerClient(
                self._episodes_spec, clip_seconds=self._clip_seconds,
                max_decisions=self._max_decisions,
            )
            hello = self._connection.request({"op": "hello"})
            if hello.get("proto") != ENV_SERVER_PROTOCOL_VERSION:
                raise RuntimeError(
                    f"env-server protocol {hello.get('proto')} != client {ENV_SERVER_PROTOCOL_VERSION}"
                )
        return self._connection

    def set_timeout(self, seconds: float) -> None:
        """Accepted for API compatibility; requests are synchronous."""

    def get_server_version(self) -> str:
        return f"uniscenarios-env-server proto {ENV_SERVER_PROTOCOL_VERSION}"

    def get_client_version(self) -> str:
        return "uniscenarios-carla-compat 0.1.0"

    def get_world(self):
        from .world import World

        if self._world is None:
            self._world = World(self, session=self._session)
        return self._world

    def get_available_maps(self) -> list[str]:
        """Dev-assets map inventory (see uniscenarios_carla/maps.py)."""
        from .maps import available_maps

        return [m.map_id for m in available_maps(self._dev_assets_root)]

    def load_world(self, map_name: str, *, weather=None, time_of_day=None,
                   traffic: str | None = None):
        """Start a **new env-server session** on ``map_name`` (CARLA shape).

        - The map comes from the dev-assets inventory; its pinned identity
          is ``{mapId, xodrSha256}`` (world.get_map().digest).
        - The session is born from a real scenario-instance for that map,
          resolved through the instance catalog (UNISCENARIO_INSTANCE_DIRS
          may add pools).
        - ``weather`` ('clear'|'rain'|'overcast' or WeatherParameters/dict)
          and ``traffic`` ('light'|'moderate'|'heavy') are baked into the
          materialized instance's operationalConditions before launch.
        """
        from .maps import build_episode_spec
        from .weather import scenario_weather_patch, to_operational_conditions

        patch: dict = {}
        if weather is not None:
            if isinstance(weather, str):
                patch.update(scenario_weather_patch(weather, time_of_day))
            else:
                patch.update(to_operational_conditions(weather))
                if time_of_day is not None:
                    patch["timeOfDay"] = time_of_day
        if traffic is not None:
            if traffic not in ("light", "moderate", "heavy"):
                raise ValueError(f"traffic={traffic!r} not in ('light', 'moderate', 'heavy')")
            patch["traffic"] = traffic

        spec_path, _instance_path = build_episode_spec(
            map_name, weather_patch=patch or None,
            dev_assets_root=self._dev_assets_root)

        old_connection = self._connection
        self._connection = EnvServerClient(
            spec_path, clip_seconds=self._clip_seconds,
            max_decisions=self._max_decisions,
        )
        hello = self._connection.request({"op": "hello"})
        if hello.get("proto") != ENV_SERVER_PROTOCOL_VERSION:
            raise RuntimeError("env-server protocol mismatch after load_world")
        # A new session means a new scenario/map; drop all cached state and
        # point the scenario reader at the materialized spec.
        if old_connection is not None:
            old_connection.close()
        self._episodes_spec = spec_path
        self._world = None
        self._scenario = None
        return self.get_world()

    reload_world = load_world

    def get_trafficmanager(self, port: int | None = None):
        """The TrafficManager-shaped handle over ambient-traffic config."""
        from .trafficmanager import TrafficManager

        if self._traffic_manager is None:
            self._traffic_manager = TrafficManager(self, port)
        elif port is not None and self._traffic_manager.get_port() != int(port):
            self._traffic_manager = TrafficManager(self, port)
        return self._traffic_manager

    def start_recorder(self, *args, **kwargs):  # pragma: no cover - surface stub
        raise NotImplementedError("client.start_recorder: no recorder on this engine (README)")

    stop_recorder = start_recorder

    # -- internals used by World ---------------------------------------------

    def load_scenario(self, session: int) -> ScenarioInfo:
        if self._scenario is None:
            if not self._episodes_spec:
                raise RuntimeError("no episode spec configured (UNISCENARIO_EPISODES)")
            self._scenario = load_scenario_info(self._episodes_spec, session)
        return self._scenario

    def load_lane_graph(self, map_id: str) -> LaneGraphLite:
        graph = self._lane_graphs.get(map_id)
        if graph is None:
            graph = LaneGraphLite(load_topology_index(find_dev_assets(os.environ.get("UNISCENARIO_DEV_ASSETS")), map_id))
            self._lane_graphs[map_id] = graph
        return graph

    def create_frame_source(self, scenario: ScenarioInfo):
        mode = os.environ.get("UNISCENARIO_FRAMES", "browser").lower()
        if mode == "off" or scenario.trace_path is None:
            return NullFrameSource()
        cache = os.environ.get("UNISCENARIO_FRAME_CACHE") or "/tmp/uniscenarios-carla-frames"
        workdir = Path(cache) / Path(scenario.instance_path).stem
        return BrowserClipFrameSource(
            scenario.instance_path, scenario.trace_path, str(workdir),
        )

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
