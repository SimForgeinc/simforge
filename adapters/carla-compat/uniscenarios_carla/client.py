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

    def load_world(self, map_name: str):
        raise NotImplementedError(
            "client.load_world: the engine serves exactly its authored episodes; "
            "point UNISCENARIO_EPISODES at a spec for the target map instead"
        )

    reload_world = load_world

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
