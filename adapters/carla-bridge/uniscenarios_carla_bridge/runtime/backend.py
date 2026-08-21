from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from dataclasses import dataclass
import hashlib
import json
from math import atan2, cos, degrees, isfinite, radians, sin, sqrt
import os
from threading import Condition, Lock
from time import monotonic, sleep
from typing import Any, Callable, Mapping, Protocol

from .compiler import LIFECYCLE_ABSENT, ActorBinding, PlanFrame
from .contract import ASSET_CATALOG_SCHEMA, ContractError, Environment, RenderSpec

#: Period of one deterministic flash cycle, 50% duty, phase-locked to plan time.
FLASH_PERIOD_S = 1.0

#: How each authored signal indication is realised on CARLA hardware.
#:
#: `carla.TrafficLightState` has exactly four renderable lamps
#: (Red/Yellow/Green/Off), so the eleven authored indications resolve onto them.
#: Its fifth member, `Unknown = 4`, is a readback sentinel rather than a lamp and
#: is never written; `bind_signals` captures whatever it reads as an opaque token
#: and restores it verbatim, so an `Unknown` read back from the runtime survives
#: the round trip without this table needing an entry for it.
#: This is not a lossy shortcut: a head's arrow/X glyph is hardware derived from
#: the plan's protected turns (`signal-head-model.ts`), never from the phase
#: word, so `green_arrow` genuinely *is* a green lamp on an arrow head. The
#: browser signal overlay (`uniscenario-xodr-tools/src/overlays/signals.ts`)
#: resolves the same eleven words onto the same colours, and renders the two
#: flashing indications by alternating against `off` — which is what the second
#: tuple element asks for here.
SIGNAL_LAMP_BY_INDICATION: Mapping[str, tuple[str, bool]] = {
    "green": ("green", False),
    "yellow": ("yellow", False),
    "red": ("red", False),
    "off": ("off", False),
    "green_arrow": ("green", False),
    "yellow_arrow": ("yellow", False),
    "red_x": ("red", False),
    "proceed": ("green", False),
    "stop": ("red", False),
    "flashing_yellow": ("yellow", True),
    "flashing_red": ("red", True),
}

#: OpenSCENARIO `vehicleLightType` -> the `carla.VehicleLightState` members it
#: raises. CARLA has no dedicated hazard bit, so warning lights are both
#: blinkers; emergency beacons use the vehicle's special-purpose channel. CARLA
#: has no daytime-running-lamp bit either, so `daytimeRunningLights` drives the
#: position-lamp channel, which is the closest thing it can actually render.
#:
#: Every entry here is deliberately DISJOINT from every other. `_apply_vehicle_lights`
#: iterates `sorted(lights)`, so overlapping bit sets would make the final mask
#: depend on the alphabetical order of the light-type names — `highBeam` sorts
#: before `lowBeam`, so a `low` beam setting expressed as overlapping masks
#: would be silently order-dependent. Keeping the sets disjoint means the writer
#: decides the beam combination and this table only translates it.
VEHICLE_LIGHT_BITS: Mapping[str, tuple[str, ...]] = {
    "indicatorLeft": ("LeftBlinker",),
    "indicatorRight": ("RightBlinker",),
    "warningLights": ("LeftBlinker", "RightBlinker"),
    "brakeLights": ("Brake",),
    "reversingLights": ("Reverse",),
    "specialPurposeLights": ("Special1",),
    "daytimeRunningLights": ("Position",),
    "lowBeam": ("LowBeam",),
    "highBeam": ("HighBeam",),
}

#: OpenSCENARIO `vehicleComponentType` -> the `carla.VehicleDoor` member.
#:
#: There is no `trunk` entry and there cannot be one: CARLA 0.10.0's binding
#: exports only `FL=0, FR=1, RL=2, RR=3, All=6`. The C++ enum does define
#: `Hood = 4, Trunk = 5` (`LibCarla/source/carla/rpc/VehicleDoor.h`), but
#: `PythonAPI/carla/src/Actor.cpp` exports only the five — an upstream binding
#: omission, not a UE5 regression. `carla.VehicleDoor(5)` would construct,
#: because boost::python enums accept arbitrary ints, but whether the UE5 asset
#: actually actuates a trunk is unverified, and a silent no-op in a paid render
#: is worse than refusing the scenario at export. So `doors.rear` is rejected by
#: the writer instead. `RL`/`RR` are genuinely available if the set-key schema
#: ever grows a rear-door distinction.
VEHICLE_DOOR_MEMBERS: Mapping[str, str] = {
    "doorFrontLeft": "FL",
    "doorFrontRight": "FR",
}

ENVIRONMENT_FIELDS = (
    "cloudiness", "precipitation", "precipitation_deposits", "wind_intensity",
    "sun_azimuth_angle", "sun_altitude_angle", "fog_density", "fog_distance", "wetness",
)

NATIVE_SENSOR_BLUEPRINTS: Mapping[str, str] = {
    "rgb": "sensor.camera.rgb",
    "depth": "sensor.camera.depth",
    "semantic": "sensor.camera.semantic_segmentation",
    "instance": "sensor.camera.instance_segmentation",
    "normals": "sensor.camera.normals",
    "lidar": "sensor.lidar.ray_cast",
    "semantic-lidar": "sensor.lidar.ray_cast_semantic",
    "radar": "sensor.other.radar",
}

CARLA_IMAGE_INDEX_DIGEST = "sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5"
CARLA_IMAGE_AMD64_MANIFEST_DIGEST = "sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64"
KIA_CARNIVAL_CATALOG_ID = "vehicle.kia.carnival"
KIA_CARNIVAL_BLUEPRINT_ID = "vehicle.kia.carnival"
KIA_CARNIVAL_CLASS_PATH = (
    "/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/"
    "BP_KiaCarnival2025.BP_KiaCarnival2025_C"
)
KIA_CARNIVAL_MAKE = "Kia"
KIA_CARNIVAL_MODEL = "Carnival"
KIA_CARNIVAL_BASE_TYPE = "van"

ENVIRONMENT_READBACK_TIMEOUT_S = 2.0
DEFAULT_RGB_CAMERA_GRADE: Mapping[str, str] = {
    "temp": "5250",
    "scene_color_tint": "210,218,235",
    "slope": "0.96",
    "shadow_constrast_scale": "0.82",
}
MAP_RGB_EXPOSURE: tuple[tuple[str, str], ...] = (
    ("Yale", "-0.4"),
    ("Page_Mill", "-0.3"),
    ("Di_Rosa", "-0.2"),
)
RICHMOND_COOKED_SIGNAL_ID_MAP: Mapping[str, str] = {
    "367": "423",
    "368": "429",
    "369": "422",
    "370": "421",
    "371": "430",
    "372": "428",
    "373": "431",
    "374": "432",
}
COOKED_SIGNAL_ID_MAPS: Mapping[tuple[str, str, str], Mapping[str, str]] = {
    (
        "Richmond_Field_Station_Richmond_CA",
        "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643",
        "1576737df37adb4caad6bef62210e060fcbf5c9a082ddd269515417616a36111",
    ): RICHMOND_COOKED_SIGNAL_ID_MAP,
}
VISUAL_SAMPLE_TARGET = 4096
VISUAL_MIN_LUMA_RANGE = 24
VISUAL_MIN_CHROMATIC_FRACTION = 0.01
VISUAL_MIN_MIDTONE_FRACTION = 0.02
VISUAL_MAX_NEAR_BLACK_FRACTION = 0.98
VISUAL_MAX_NEAR_WHITE_FRACTION = 0.98


def _normalized_map_name(value: object) -> str:
    tail = str(value or "").replace("\\", "/").split("/")[-1]
    return tail[:-5] if tail.lower().endswith(".xodr") else tail

def _is_baked_default_daylight(requested: Mapping[str, float]) -> bool:
    return (
        all(requested[field] == 0.0 for field in (
            "cloudiness", "precipitation", "precipitation_deposits",
            "wind_intensity", "fog_density", "fog_distance", "wetness",
        ))
        and requested["sun_altitude_angle"] >= 0.0
    )






def flash_on(t: float) -> bool:
    """Deterministic 50% duty flash phase for plan time `t`."""
    return int(t / (FLASH_PERIOD_S / 2)) % 2 == 0


def resolve_signal_lamp(indication: str, t: float) -> str:
    """Resolve an authored indication to the lamp CARLA should show at `t`."""
    resolution = SIGNAL_LAMP_BY_INDICATION.get(indication)
    if resolution is None:
        raise RuntimeError(f"execution plan carries an unrenderable traffic signal indication {indication}")
    lamp, flashing = resolution
    return lamp if not flashing or flash_on(t) else "off"


@dataclass(frozen=True)
class _OwnedSignalSnapshot:
    light: Any
    state: Any
    frozen: bool | None
    green_time: float
    yellow_time: float
    red_time: float


def runtime_asset_bindings(
    manifest: Any,
    *,
    expected_catalog_version_id: str,
    abort: Callable[[], None] | None = None,
) -> dict[str, Mapping[str, str]]:
    """Validate a signed asset-catalog manifest and index its exact CARLA bindings."""
    check = abort or (lambda: None)
    check()
    if not isinstance(manifest, Mapping):
        raise ContractError("asset catalog manifest must be a JSON object")
    if manifest.get("contractVersion") != ASSET_CATALOG_SCHEMA:
        raise ContractError(f"asset catalog manifest contractVersion must equal {ASSET_CATALOG_SCHEMA}")
    if manifest.get("catalogVersionId") != expected_catalog_version_id:
        raise ContractError("asset catalog manifest version does not match the execution package")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ContractError("asset catalog manifest entries must be an array")
    bindings: dict[str, Mapping[str, str]] = {}
    for index, entry in enumerate(entries):
        check()
        if not isinstance(entry, Mapping):
            raise ContractError(f"asset catalog entry {index} must be an object")
        asset_id = entry.get("id")
        if not isinstance(asset_id, str) or not asset_id:
            raise ContractError(f"asset catalog entry {index} must have a non-empty id")
        if asset_id in bindings:
            raise ContractError(f"asset catalog contains duplicate id {asset_id}")
        runtime = entry.get("runtimeBindings")
        carla = runtime.get("carla") if isinstance(runtime, Mapping) else None
        blueprint_id = carla.get("blueprintId") if isinstance(carla, Mapping) else None
        if not isinstance(blueprint_id, str) or not blueprint_id:
            raise ContractError(f"asset catalog entry {asset_id} has no exact CARLA blueprintId")
        bindings[asset_id] = {"blueprintId": blueprint_id}
    if not bindings:
        raise ContractError("asset catalog manifest must contain at least one entry")
    check()
    return bindings


class RenderBackend(Protocol):
    def set_rpc_timeout(self, timeout_s: float) -> None: ...
    def configure_execution(self, mode: str) -> None: ...
    def configure_environment(self, environment: Environment) -> None: ...
    def load_opendrive(self, map_name: str, xodr: bytes, fixed_timestep_s: float) -> None: ...
    def bind_signals(self, signal_ids: tuple[str, ...], abort: Callable[[], None] | None = None) -> None: ...
    def spawn(self, actors: Mapping[str, ActorBinding], first_frame: PlanFrame, catalog: Mapping[str, Any], abort: Callable[[], None] | None = None) -> None: ...
    def prepare_scenario(self, first_frame: PlanFrame, abort: Callable[[], None] | None = None) -> Mapping[str, Any] | None: ...
    def configure_sensors(self, spec: RenderSpec, output_dir: Path, max_capture_disk_bytes: int, abort: Callable[[], None] | None = None) -> None: ...
    def apply(self, frame: PlanFrame, abort: Callable[[], None] | None = None) -> None: ...
    def tick(self, capture: Mapping[str, float | int] | None = None, abort: Callable[[], None] | None = None) -> Mapping[str, Mapping[str, Any]]: ...
    def finalize_capture(self, expected_frame_count: int, abort: Callable[[], None] | None = None) -> None: ...
    def cleanup(self) -> None: ...
    def sensor_manifest(self, abort: Callable[[], None] | None = None) -> list[Mapping[str, Any]]: ...
    def signal_readback(self, abort: Callable[[], None] | None = None) -> Mapping[str, str]: ...
    def collision_readback(self, frame_index: int, t: float, abort: Callable[[], None] | None = None) -> list[Mapping[str, Any]]: ...
    def runtime_evidence(self, abort: Callable[[], None] | None = None) -> Mapping[str, Any]: ...


class CarlaBackend:
    """Small native CARLA adapter owned by the UniScenario worker."""

    def __init__(self, host: str = "127.0.0.1", port: int = 2000, timeout: float = 60.0):
        try:
            import carla  # type: ignore
        except ImportError as exc:
            raise RuntimeError("CARLA PythonAPI is required in the render container") from exc
        self.carla = carla
        self.static_actor_ids: set[str] = set()
        self.frozen_static_actor_ids: set[str] = set()
        self.client = carla.Client(host, port)
        self.client.set_timeout(timeout)
        self.world = None
        self.actors: dict[str, Any] = {}
        self.sensors: list[Any] = []
        self.signals: dict[str, Any] = {}
        self.signal_snapshots: dict[int, _OwnedSignalSnapshot] = {}
        self.executed_signals: dict[str, str] = {}
        self.executed_signal_lamps: dict[str, Any] = {}
        self.execution_mode = "native-physics"
        self.sensor_records: list[dict[str, Any]] = []
        self.sensor_lock = Lock()
        self.sensor_condition = Condition(self.sensor_lock)
        self.sensor_pending: dict[int, dict[str, Any]] = {}
        self.sensor_last_frame: dict[str, int] = {}
        self.sensor_configs: dict[str, dict[str, Any]] = {}
        self.sensor_error: RuntimeError | None = None
        self.sensor_closed = False
        self.capture_disk_bytes = 0
        self.max_capture_disk_bytes = 0
        self.sensor_timeout_s = float(os.environ.get("UNISCENARIO_SENSOR_FRAME_TIMEOUT_S", "10"))
        self.sensor_writer_workers = max(
            1, min(32, int(os.environ.get("UNISCENARIO_SENSOR_WRITER_WORKERS", "8"))),
        )
        self.actor_asset_evidence: dict[str, dict[str, Any]] = {}
        self.pronto_sensor_host_actor_id: str | None = None
        self.presentation_camera_key: str | None = None
        self.sensor_writer_pool: ThreadPoolExecutor | None = None
        self.map_evidence: dict[str, Any] = {"available": False}
        self.signal_id_map: dict[str, str] = {}
        self.streaming_evidence: dict[str, Any] = {"available": False}
        self.streaming_primary_actor_id: str | None = None
        self.camera_grade_evidence: dict[str, dict[str, Any]] = {}
        self.visual_quality_stats: dict[str, dict[str, int]] = {}
        self.visual_quality_evidence: dict[str, Any] = {
            "schema": "uniscenario.visual-quality-evidence/v1",
            "verdict": "not-evaluated",
            "cameras": {},
        }
        if not isfinite(self.sensor_timeout_s) or self.sensor_timeout_s <= 0:
            raise RuntimeError("UNISCENARIO_SENSOR_FRAME_TIMEOUT_S must be finite and positive")
        self.fixed_timestep_s = 0.02
        self.speed_integrals: dict[str, float] = {}
        self.absent_actors: set[str] = set()
        self.door_states: dict[tuple[str, str], str] = {}
        self.actor_lifecycle: dict[str, str] = {}
        self.applied_appearance: dict[str, dict[str, str]] = {}
        self.appearance_verification: dict[str, dict[str, str]] = {}
        self.environment_evidence: dict[str, Any] = {"available": False}
        self.collision_sensors: list[Any] = []
        self.collision_lock = Lock()
        self.collision_pending: list[dict[str, Any]] = []
        self.collision_history: list[dict[str, Any]] = []
        self.actor_id_by_runtime_id: dict[int, str] = {}
        self.last_carla_frame: int | None = None
        self.current_plan_frame: tuple[int, float] | None = None
        self.carla_to_plan_frame: dict[int, tuple[int, float]] = {}
        self.last_controls: dict[str, dict[str, Any]] = {}

    def configure_execution(self, mode: str) -> None:
        if mode not in {"native-physics", "diagnostic-replay"}:
            raise RuntimeError(f"unsupported execution mode {mode}")
        self.execution_mode = mode

    def set_rpc_timeout(self, timeout_s: float) -> None:
        if not isfinite(timeout_s) or timeout_s <= 0:
            raise RuntimeError("CARLA RPC timeout must be finite and positive")
        self.client.set_timeout(min(60.0, timeout_s))

    def configure_environment(self, environment: Environment) -> None:
        assert self.world is not None
        self.environment_evidence = {"available": False}
        requested = {field: float(getattr(environment, field)) for field in ENVIRONMENT_FIELDS}
        enabled = getattr(self.world, "is_weather_enabled", None)
        if not callable(enabled):
            raise RuntimeError("CARLA weather availability API is unavailable")
        if not enabled():
            if not _is_baked_default_daylight(requested):
                raise RuntimeError(
                    "the cooked custom map supports only its baked default clear-daylight environment"
                )
            self.environment_evidence = {
                "schema": "uniscenario.environment-evidence/v1",
                "available": True,
                "exact": False,
                "requested": requested,
                "observed": None,
                "mode": "cooked-baked-default",
                "reason": "custom-map-baked-default-daylight",
            }
            return
        setter = getattr(self.world, "set_weather", None)
        getter = getattr(self.world, "get_weather", None)
        if not callable(setter) or not callable(getter):
            raise RuntimeError("CARLA environment mutation/readback API is unavailable")
        setter(self.carla.WeatherParameters(**requested))
        deadline = monotonic() + ENVIRONMENT_READBACK_TIMEOUT_S
        while True:
            observed_weather = getter()
            observed = {field: float(getattr(observed_weather, field)) for field in ENVIRONMENT_FIELDS}
            mismatches = {
                field: {"requested": requested[field], "observed": observed[field]}
                for field in ENVIRONMENT_FIELDS
                if (
                    abs((requested[field] - observed[field] + 180.0) % 360.0 - 180.0)
                    if field == "sun_azimuth_angle"
                    else abs(requested[field] - observed[field])
                ) > 1e-4
            }
            if not mismatches:
                self.environment_evidence = {
                    "schema": "uniscenario.environment-evidence/v1",
                    "available": True,
                    "requested": requested,
                    "observed": observed,
                    "exact": True,
                }
                return
            if monotonic() >= deadline:
                raise RuntimeError(
                    f"CARLA environment readback differs from the render specification: {mismatches}"
                )
            sleep(0.01)

    def load_opendrive(self, map_name: str, xodr: bytes, fixed_timestep_s: float) -> None:
        requested_name = _normalized_map_name(map_name)
        if not requested_name or requested_name != map_name or any(
            token in requested_name for token in ("/", "\\", "..")
        ):
            raise RuntimeError("execution package must name one exact cooked CARLA map")
        available_getter = getattr(self.client, "get_available_maps", None)
        available = list(available_getter() or ()) if callable(available_getter) else []
        matching = [value for value in available if _normalized_map_name(value) == requested_name]
        if len(matching) != 1:
            if os.environ.get("UNISCENARIO_CARLA_ALLOW_GENERATED_XODR") != "1":
                raise RuntimeError(
                    f"CARLA runtime does not contain exactly one cooked custom map named {requested_name}"
                )
            params = self.carla.OpendriveGenerationParameters(
                vertex_distance=2.0, max_road_length=500.0, wall_height=0.0,
                additional_width=0.6, smooth_junctions=True, enable_mesh_visibility=True,
            )
            self.world = self.client.generate_opendrive_world(xodr.decode("utf-8"), params)
            observed_name = _normalized_map_name(self.world.get_map().name)
            self.signal_id_map = {}
            self.map_evidence = {
                "schema": "uniscenario.carla-map-evidence/v1",
                "available": True,
                "source": "generated-opendrive-world",
                "identityMode": "generated-opendrive",
                "requestedMapName": requested_name,
                "loadedMapName": observed_name,
                "packageXodrSha256": hashlib.sha256(xodr).hexdigest(),
                "runtimeXodrSha256": hashlib.sha256(xodr).hexdigest(),
                "xodrByteExact": True,
                "signalIdentityMode": "direct-opendrive-id",
                "signalIdMap": {},
                "exact": True,
            }
        else:
            self.client.set_timeout(180.0)
            loaded = self.client.load_world(requested_name)
            self.world = loaded if loaded is not None else self.client.get_world()
            runtime_map = self.world.get_map()
            loaded_name = _normalized_map_name(getattr(runtime_map, "name", ""))
            if loaded_name != requested_name:
                raise RuntimeError(
                    f"loaded CARLA map {loaded_name or 'unknown'} does not match {requested_name}"
                )
            runtime_xodr = str(runtime_map.to_opendrive() or "")
            if not runtime_xodr:
                raise RuntimeError("loaded cooked CARLA map exposes no OpenDRIVE identity")
            package_sha256 = hashlib.sha256(xodr).hexdigest()
            runtime_sha256 = hashlib.sha256(runtime_xodr.encode("utf-8")).hexdigest()
            self.signal_id_map = dict(COOKED_SIGNAL_ID_MAPS.get(
                (requested_name, package_sha256, runtime_sha256),
                {},
            ))
            self.map_evidence = {
                "schema": "uniscenario.carla-map-evidence/v1",
                "available": True,
                "source": "cooked-custom-map",
                "identityMode": "cooked-map-name",
                "requestedMapName": requested_name,
                "loadedMapName": loaded_name,
                "packageXodrSha256": package_sha256,
                "runtimeXodrSha256": runtime_sha256,
                "xodrByteExact": runtime_sha256 == package_sha256,
                "signalIdentityMode": (
                    "approved-cooked-map-remap" if self.signal_id_map else "direct-opendrive-id"
                ),
                "signalIdMap": dict(sorted(self.signal_id_map.items())),
                "exact": True,
            }
        self.fixed_timestep_s = fixed_timestep_s
        settings = self.world.get_settings()
        settings.synchronous_mode = True
        settings.fixed_delta_seconds = fixed_timestep_s
        settings.no_rendering_mode = False
        streaming = {}
        for field in ("tile_stream_distance", "actor_active_distance"):
            if hasattr(settings, field):
                target = max(float(getattr(settings, field)), 2000.0)
                setattr(settings, field, target)
                streaming[field] = target
        self.world.apply_settings(settings)
        self.streaming_evidence = {
            "available": True,
            "settings": streaming,
            "spectatorFollow": "pending",
        }

    def spawn(self, actors: Mapping[str, ActorBinding], first_frame: PlanFrame, catalog: Mapping[str, Any], abort: Callable[[], None] | None = None) -> None:
        assert self.world is not None
        check = abort or (lambda: None)
        check()
        # A few pure unit fakes construct the backend without importing CARLA.
        # Keep the production state initialized here as well as in __init__ so
        # those tests exercise the same spawn path without a more-capable mock.
        self.actor_id_by_runtime_id = getattr(self, "actor_id_by_runtime_id", {})
        self.actor_lifecycle = getattr(self, "actor_lifecycle", {})
        self.collision_sensors = getattr(self, "collision_sensors", [])
        self.actor_asset_evidence = getattr(self, "actor_asset_evidence", {})
        self.static_actor_ids = {actor_id for actor_id, binding in actors.items() if binding.static}
        self.frozen_static_actor_ids = set()
        library = self.world.get_blueprint_library()
        for actor_id, binding in actors.items():
            check()
            state = first_frame.actors[actor_id]
            entry = catalog.get(binding.catalog_name, {}) if isinstance(catalog, Mapping) else {}
            blueprint_id = entry.get("blueprintId") if isinstance(entry, Mapping) else None
            if not isinstance(blueprint_id, str) or not blueprint_id:
                raise RuntimeError(f"asset catalog has no exact CARLA binding for {actor_id} ({binding.catalog_name})")
            try:
                blueprint = library.find(blueprint_id)
            except RuntimeError as exc:
                raise RuntimeError(
                    f"CARLA runtime is missing required catalog blueprint for {actor_id} ({blueprint_id}, {binding.kind})"
                ) from exc
            entry_dims = entry.get("dims") if isinstance(entry, Mapping) else None
            entry_height = (
                entry_dims.get("h") or entry_dims.get("height")
                if isinstance(entry_dims, Mapping) else None
            )
            half_height = (
                float(entry_height) / 2.0
                if isinstance(entry_height, (int, float)) else 0.0
            )
            spawn_lift = max(0.25, half_height + 0.15)
            transform = self.carla.Transform(
                self.carla.Location(x=state.x, y=-state.y, z=state.z + spawn_lift),
                self.carla.Rotation(yaw=-state.heading_deg),
            )
            actor = self.world.try_spawn_actor(blueprint, transform)
            check()
            if actor is None:
                raise RuntimeError(f"CARLA failed to spawn {actor_id} as {blueprint_id}")
            observed_type_id = str(getattr(actor, "type_id", ""))
            if observed_type_id != blueprint_id:
                try:
                    actor.destroy()
                finally:
                    raise RuntimeError(
                        f"CARLA actor {actor_id} spawned as {observed_type_id!r}, "
                        f"expected exact blueprint {blueprint_id!r}"
                    )
            if blueprint_id.startswith("walker."):
                set_gravity = getattr(actor, "set_enable_gravity", None)
                if not callable(set_gravity):
                    actor.destroy()
                    raise RuntimeError(f"CARLA walker {actor_id} cannot disable uncontrolled vertical drift")
                set_gravity(False)
            self.actor_asset_evidence[actor_id] = {
                "catalogId": binding.catalog_name,
                "requestedBlueprintId": blueprint_id,
                "observedBlueprintId": observed_type_id,
                "verification": "runtime-type-id-readback",
            }
            self.actors[actor_id] = actor
            runtime_id = getattr(actor, "id", None)
            if isinstance(runtime_id, int):
                self.actor_id_by_runtime_id[runtime_id] = actor_id
            self.actor_lifecycle[actor_id] = state.lifecycle
        self.streaming_primary_actor_id = next(iter(self.actors), None)
        self._configure_collision_sensors(library, check)

    def _configure_collision_sensors(self, library: Any, abort: Callable[[], None]) -> None:
        """Attach passive collision observation without affecting vehicle motion."""
        spawn_actor = getattr(self.world, "spawn_actor", None)
        if not callable(spawn_actor):
            return
        try:
            blueprint = library.find("sensor.other.collision")
        except (KeyError, RuntimeError):
            return
        for actor_id, actor in self.actors.items():
            abort()
            sensor = spawn_actor(blueprint, self.carla.Transform(), attach_to=actor)
            if sensor is None:
                raise RuntimeError(f"CARLA failed to attach collision observation to {actor_id}")
            sensor.listen(lambda event, owner=actor_id: self._receive_collision(owner, event))
            self.collision_sensors.append(sensor)

    def _receive_collision(self, actor_id: str, event: Any) -> None:
        other = getattr(event, "other_actor", None)
        other_runtime_id = getattr(other, "id", None)
        other_id = self.actor_id_by_runtime_id.get(other_runtime_id)
        if other_id is None:
            suffix = f"#{other_runtime_id}" if isinstance(other_runtime_id, int) else ""
            other_id = f"carla:{getattr(other, 'type_id', 'unknown')}{suffix}"
        pair = tuple(sorted((actor_id, other_id)))
        impulse = getattr(event, "normal_impulse", None)
        impulse_magnitude = sqrt(
            float(getattr(impulse, "x", 0.0)) ** 2
            + float(getattr(impulse, "y", 0.0)) ** 2
            + float(getattr(impulse, "z", 0.0)) ** 2
        )
        item = {
            "carlaFrame": int(getattr(event, "frame")),
            "carlaTimestamp": float(getattr(event, "timestamp", 0.0)),
            "pair": pair,
            "normalImpulse": impulse_magnitude,
        }
        with self.collision_lock:
            key = (item["carlaFrame"], pair)
            prior_events = [*self.collision_pending, *self.collision_history]
            if not any((prior["carlaFrame"], tuple(prior["pair"])) == key for prior in prior_events):
                self.collision_pending.append(item)

    def bind_signals(self, signal_ids: tuple[str, ...], abort: Callable[[], None] | None = None) -> None:
        """Own every authored runtime light while leaving unrelated map lights untouched."""
        check = abort or (lambda: None)
        check()
        assert self.world is not None
        authored = set(signal_ids)
        raw_remap = os.environ.get("UNISCENARIO_CARLA_SIGNAL_ID_MAP", "{}")
        try:
            configured_remap = json.loads(raw_remap)
        except json.JSONDecodeError as exc:
            raise RuntimeError("UNISCENARIO_CARLA_SIGNAL_ID_MAP must be valid JSON") from exc
        if not isinstance(configured_remap, Mapping):
            raise RuntimeError("UNISCENARIO_CARLA_SIGNAL_ID_MAP must be a JSON object")
        signal_remap = dict(getattr(self, "signal_id_map", {}))
        for key, value in configured_remap.items():
            if key in signal_remap and signal_remap[key] != value:
                raise RuntimeError(f"configured CARLA signal remap conflicts with cooked map identity for {key}")
            signal_remap[key] = value
        if (
            any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in signal_remap.items())
            or set(signal_remap) - authored
            or len(set(signal_remap.values())) != len(signal_remap)
        ):
            raise RuntimeError("CARLA signal remapping must be a one-to-one map of authored signal ids")
        try:
            lights = list(self.world.get_actors().filter("traffic.traffic_light*"))
        except Exception as exc:  # noqa: BLE001 - this is an execution ownership boundary.
            raise RuntimeError("CARLA traffic light enumeration failed before ownership") from exc
        check()
        runtime_id_by_authored = {
            signal_id: signal_remap.get(signal_id, signal_id)
            for signal_id in authored
        }
        expected_runtime_ids = set(runtime_id_by_authored.values())

        resolved: dict[str, Any] = {}
        duplicate_ids: list[str] = []
        for light in lights:
            check()
            try:
                signal_id = str(light.get_opendrive_id() or "").strip()
            except Exception as exc:  # noqa: BLE001 - reject the full map before mutation.
                raise RuntimeError("CARLA traffic light identity read failed before ownership") from exc
            if not signal_id:
                continue
            if signal_id in resolved and signal_id in expected_runtime_ids:
                duplicate_ids.append(signal_id)
            resolved[signal_id] = light
        runtime_ids = set(resolved)
        missing = sorted(
            signal_id for signal_id, runtime_id in runtime_id_by_authored.items()
            if runtime_id not in runtime_ids
        )
        if missing or duplicate_ids:
            details = []
            if missing:
                details.append(
                    "missing: "
                    + ", ".join(
                        f"{signal_id}->{runtime_id_by_authored[signal_id]}"
                        if runtime_id_by_authored[signal_id] != signal_id else signal_id
                        for signal_id in missing
                    )
                )
            if duplicate_ids:
                details.append(f"duplicate OpenDRIVE ids: {', '.join(sorted(set(duplicate_ids)))}")
            raise RuntimeError(
                "authored OpenDRIVE traffic signal heads cannot be safely owned in CARLA ("
                + "; ".join(details)
                + ")"
            )
        if not lights:
            self.signals = {}
            self.signal_snapshots = {}
            self.executed_signals = {}
            self.executed_signal_lamps = {}
            return
        self.signals = {
            authored_id: resolved[runtime_id]
            for authored_id, runtime_id in runtime_id_by_authored.items()
        }

        snapshots: dict[int, _OwnedSignalSnapshot] = {}
        owned_lights = {self._signal_identity(light): light for light in self.signals.values()}
        for light in owned_lights.values():
            check()
            key = self._signal_identity(light)
            if key in snapshots:
                raise RuntimeError("CARLA returned duplicate traffic light actor identities before ownership")
            get_state = getattr(light, "get_state", None)
            is_frozen = getattr(light, "is_frozen", None)
            duration_getters = (
                getattr(light, "get_green_time", None),
                getattr(light, "get_yellow_time", None),
                getattr(light, "get_red_time", None),
            )
            mutation_methods = (
                getattr(light, "set_state", None),
                getattr(light, "freeze", None),
                getattr(light, "set_green_time", None),
                getattr(light, "set_yellow_time", None),
                getattr(light, "set_red_time", None),
            )
            if (
                not callable(get_state)
                or not callable(is_frozen)
                or not all(callable(getter) for getter in duration_getters)
                or not all(callable(method) for method in mutation_methods)
            ):
                raise RuntimeError("CARLA traffic light ownership API is incomplete before mutation")
            try:
                state = get_state()
                frozen = bool(is_frozen())
                green_time, yellow_time, red_time = (float(getter()) for getter in duration_getters)
            except Exception as exc:  # noqa: BLE001 - reject before taking ownership.
                raise RuntimeError("CARLA traffic signal state snapshot failed before ownership") from exc
            if not all(isfinite(value) and value >= 0 for value in (green_time, yellow_time, red_time)):
                raise RuntimeError("CARLA traffic light timing snapshot is invalid before mutation")
            snapshots[key] = _OwnedSignalSnapshot(
                light, state, frozen, green_time, yellow_time, red_time,
            )

        self.signal_snapshots = snapshots
        self.executed_signals = {}
        self.executed_signal_lamps = {}
        try:
            for snapshot in snapshots.values():
                check()
                snapshot.light.freeze(True)
            check()
            self.world.tick()
            check()
        except Exception as original_error:
            try:
                self._restore_owned_signals()
            except Exception as cleanup_error:
                raise original_error.with_traceback(original_error.__traceback__) from cleanup_error
            raise

    @staticmethod
    def _signal_identity(light: Any) -> int:
        actor_id = getattr(light, "id", None)
        return actor_id if isinstance(actor_id, int) else id(light)

    def _restore_owned_signals(self) -> None:
        snapshots = list(getattr(self, "signal_snapshots", {}).values())
        self.signal_snapshots = {}
        self.signals = {}
        if not snapshots:
            return
        errors: list[Exception] = []
        for snapshot in snapshots:
            for setter_name, value in (
                ("set_state", snapshot.state),
                ("set_green_time", snapshot.green_time),
                ("set_yellow_time", snapshot.yellow_time),
                ("set_red_time", snapshot.red_time),
            ):
                try:
                    getattr(snapshot.light, setter_name)(value)
                except Exception as exc:  # noqa: BLE001 - attempt every restoration operation.
                    errors.append(exc)
        try:
            self.world.tick()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        for snapshot in snapshots:
            try:
                snapshot.light.freeze(False if snapshot.frozen is None else snapshot.frozen)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        try:
            self.world.tick()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        if errors:
            raise RuntimeError(f"CARLA traffic light restoration failed in {len(errors)} operation(s)") from errors[0]

    def prepare_scenario(self, first_frame: PlanFrame, abort: Callable[[], None] | None = None) -> Mapping[str, Any] | None:
        """Settle native actors before scenario t=0 and reset dynamic state.

        CARLA vehicles must be spawned slightly above the OpenDRIVE surface so
        their collision shapes do not intersect it.  Sampling immediately after
        spawn consequently records the short gravity-driven drop as scenario
        motion.  Pre-rolling with deterministic braking lets native suspension
        and contacts settle without weakening parity or replaying kinematics.
        Sensors are attached before this method runs so their asynchronous
        streams warm during pre-roll; warm-up frames are discarded before t=0.
        """
        if self.execution_mode != "native-physics":
            return None
        check = abort or (lambda: None)
        check()
        assert self.world is not None
        for actor in self.actors.values():
            check()
            if actor.type_id.startswith(("vehicle.", "bike.")):
                actor.apply_control(self.carla.VehicleControl(throttle=0.0, brake=1.0, steer=0.0))
            elif actor.type_id.startswith("walker."):
                actor.apply_control(self.carla.WalkerControl(speed=0.0, jump=False))
        reports = [self._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=500, abort=abort)]
        zero = self.carla.Vector3D(x=0.0, y=0.0, z=0.0)
        for actor_id, actor in self.actors.items():
            check()
            state = first_frame.actors[actor_id]
            settled = actor.get_transform()
            actor.set_transform(self.carla.Transform(
                self.carla.Location(x=state.x, y=-state.y, z=settled.location.z),
                self.carla.Rotation(yaw=-state.heading_deg),
            ))
            actor.set_target_velocity(zero)
            actor.set_target_angular_velocity(zero)
            self.speed_integrals[actor_id] = 0.0
        reports.append(self._wait_for_native_stability("post-reset", minimum_ticks=5, maximum_ticks=100, abort=abort))
        # The stability window can introduce tiny horizontal suspension drift.
        # Restore the authored planar pose once more without changing settled z;
        # no world tick occurs between this reset and scenario frame zero.
        for actor_id, actor in self.actors.items():
            check()
            state = first_frame.actors[actor_id]
            settled = actor.get_transform()
            initial = self.carla.Transform(
                self.carla.Location(x=state.x, y=-state.y, z=settled.location.z),
                self.carla.Rotation(yaw=-state.heading_deg),
            )
            actor.set_transform(initial)
            if actor_id in getattr(self, "static_actor_ids", set()):
                actor.set_target_velocity(zero)
            else:
                forward = self._forward_vector(initial)
                actor.set_target_velocity(self.carla.Vector3D(
                    x=forward[0] * state.speed_mps,
                    y=forward[1] * state.speed_mps,
                    z=forward[2] * state.speed_mps,
                ))
            actor.set_target_angular_velocity(zero)
        if getattr(self, "sensor_configs", {}):
            deadline = monotonic() + self.sensor_timeout_s
            with self.sensor_condition:
                missing = set(self.sensor_configs) - set(self.sensor_last_frame)
                while missing:
                    if self.sensor_error:
                        raise self.sensor_error
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise RuntimeError(
                            "sensor warmup did not observe callbacks for: "
                            + ", ".join(sorted(missing))
                        )
                    self.sensor_condition.wait(min(0.25, remaining))
                    missing = set(self.sensor_configs) - set(self.sensor_last_frame)
                self.sensor_pending.clear()
                self.sensor_last_frame.clear()
        return {
            "schema": "uniscenario.native-stability/v1",
            "thresholds": {
                "linearMps": 0.02,
                "verticalMps": 0.01,
                "angularRadps": 0.02,
                "horizontalDriftM": 0.001,
                "verticalDriftM": 0.001,
                "yawDriftDeg": 0.02,
                "consecutiveTicks": 5,
            },
            "initialVelocityMps": {
                actor_id: first_frame.actors[actor_id].speed_mps for actor_id in sorted(self.actors)
            },
            "phases": reports,
        }

    def _wait_for_native_stability(self, phase: str, *, minimum_ticks: int, maximum_ticks: int, abort: Callable[[], None] | None = None) -> Mapping[str, Any]:
        """Fail closed unless every actor is physically stable for five ticks."""
        assert self.world is not None
        check = abort or (lambda: None)
        check()
        previous = {actor_id: actor.get_transform() for actor_id, actor in self.actors.items()}
        consecutive = 0
        residuals: dict[str, dict[str, float]] = {}
        unstable_actor_ids: set[str] = set()
        for tick in range(1, maximum_ticks + 1):
            check()
            self.world.tick()
            sensor_condition = getattr(self, "sensor_condition", None)
            if sensor_condition is not None:
                with sensor_condition:
                    if self.sensor_error:
                        raise self.sensor_error
                    self.sensor_pending.clear()
            if tick == minimum_ticks:
                static_actor_ids = getattr(self, "static_actor_ids", set())
                frozen_static_actor_ids = getattr(self, "frozen_static_actor_ids", set())
                if static_actor_ids - frozen_static_actor_ids:
                    zero = self.carla.Vector3D(x=0.0, y=0.0, z=0.0)
                for actor_id in sorted(static_actor_ids - frozen_static_actor_ids):
                    actor = self.actors.get(actor_id)
                    if actor is None:
                        continue
                    freeze = getattr(actor, "set_simulate_physics", None)
                    if not callable(freeze):
                        raise RuntimeError(
                            f"CARLA actor {actor_id} cannot be held as an authored static actor"
                        )
                    freeze(False)
                    actor.set_target_velocity(zero)
                    actor.set_target_angular_velocity(zero)
                    frozen_static_actor_ids.add(actor_id)
                self.frozen_static_actor_ids = frozen_static_actor_ids
            residuals = {}
            unstable_actor_ids = set()
            stable = True
            current = {}
            for actor_id, actor in self.actors.items():
                check()
                transform = actor.get_transform()
                velocity = actor.get_velocity()
                angular = actor.get_angular_velocity()
                prior = previous[actor_id]
                linear_speed = sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2)
                # CARLA reports actor angular velocity in degrees per second.
                angular_speed = radians(sqrt(angular.x ** 2 + angular.y ** 2 + angular.z ** 2))
                horizontal_drift = sqrt(
                    (transform.location.x - prior.location.x) ** 2
                    + (transform.location.y - prior.location.y) ** 2
                )
                vertical_drift = abs(transform.location.z - prior.location.z)
                yaw_drift = abs(((transform.rotation.yaw - prior.rotation.yaw + 180) % 360) - 180)
                residuals[actor_id] = {
                    "linearMps": linear_speed,
                    "verticalMps": abs(velocity.z),
                    "angularRadps": angular_speed,
                    "horizontalDriftM": horizontal_drift,
                    "verticalDriftM": vertical_drift,
                    "yawDriftDeg": yaw_drift,
                }
                if (
                    linear_speed > 0.02
                    or abs(velocity.z) > 0.01
                    or angular_speed > 0.02
                    or horizontal_drift > 0.001
                    or vertical_drift > 0.001
                    or yaw_drift > 0.02
                ):
                    unstable_actor_ids.add(actor_id)
                    stable = False
                current[actor_id] = transform
            previous = current
            consecutive = consecutive + 1 if stable and tick >= minimum_ticks else 0
            if consecutive >= 5:
                return {"phase": phase, "ticks": tick, "residuals": residuals}
        unstable = {
            actor_id: residuals[actor_id]
            for actor_id in sorted(unstable_actor_ids)
        }
        raise RuntimeError(
            f"native actor stability did not converge during {phase} after {maximum_ticks} ticks: {unstable}"
        )

    def _vehicle_longitudinal_control(self, actor_id: str, target_speed: float, speed: float) -> tuple[float, float]:
        """Return native throttle/brake controls, including crawl-speed actuation.

        A pure proportional command falls below CARLA vehicle driveline static
        friction for OSC crawl trajectories.  Feed-forward supplies the minimum
        useful native actuation while the bounded integral closes the remaining
        error.  Overspeed always clears the integral and applies braking, which
        prevents wind-up and limits the small unavoidable crawl-speed ripple.
        """
        target = max(0.0, target_speed)
        error = target - speed
        # Do not apply throttle against a vehicle that is still rolling in the
        # opposite direction. Brake first and let CARLA's native transmission
        # engage the requested direction near standstill.
        if speed < -0.02:
            self.speed_integrals[actor_id] = 0.0
            return 0.0, min(1.0, 0.2 + (-speed) * 0.8)
        if target <= 1e-4:
            self.speed_integrals[actor_id] = 0.0
            return 0.0, min(1.0, 0.15 + speed * 0.8) if speed > 1e-3 else 1.0
        overspeed_deadband = max(0.015, target * 0.08)
        if error < -overspeed_deadband:
            self.speed_integrals[actor_id] = 0.0
            return 0.0, min(1.0, 0.08 + (-error) * 0.65)
        integral = self.speed_integrals.get(actor_id, 0.0)
        integral = min(0.35, max(-0.1, integral + error * self.fixed_timestep_s))
        feed_forward = (0.18 if target < 0.5 else 0.08) + min(0.18, target * 0.012)
        command = feed_forward + error * 0.32 + integral * 0.18
        throttle = min(1.0, max(0.0, command))
        # Do not integrate further while the actuator is saturated in the same
        # direction as the error.
        if throttle < 1.0 or error < 0.0:
            self.speed_integrals[actor_id] = integral
        return throttle, 0.0

    def configure_sensors(self, spec: RenderSpec, output_dir: Path, max_capture_disk_bytes: int, abort: Callable[[], None] | None = None) -> None:
        assert self.world is not None
        check = abort or (lambda: None)
        check()
        if max_capture_disk_bytes <= 0:
            raise ContractError("capture disk quota must be positive")
        self.capture_disk_bytes = 0
        self.max_capture_disk_bytes = max_capture_disk_bytes
        self.sensor_configs = {}
        output_dir.mkdir(parents=True, exist_ok=True)
        camera_modalities = {"rgb", "depth", "semantic", "instance", "normals"}
        pronto_counts = (
            sum(sensor.modality in camera_modalities for sensor in spec.sensors),
            sum(sensor.modality in {"lidar", "semantic-lidar"} for sensor in spec.sensors),
            sum(sensor.modality == "radar" for sensor in spec.sensors),
        )
        if pronto_counts == (8, 6, 4) and len(spec.sensors) == 18:
            host_ids = {sensor.actor_id for sensor in spec.sensors}
            if len(host_ids) != 1 or None in host_ids:
                raise ContractError("the Pronto 8-camera/6-LiDAR/4-radar rig must attach to one actor")
            host_actor_id = next(iter(host_ids))
            host = self.actor_asset_evidence.get(host_actor_id)
            if (
                not isinstance(host, Mapping)
                or host.get("catalogId") != KIA_CARNIVAL_CATALOG_ID
                or host.get("requestedBlueprintId") != KIA_CARNIVAL_BLUEPRINT_ID
                or host.get("observedBlueprintId") != KIA_CARNIVAL_BLUEPRINT_ID
            ):
                raise ContractError(
                    "the Pronto sensor host must be exact catalog/blueprint vehicle.kia.carnival"
                )
            self.pronto_sensor_host_actor_id = host_actor_id
        elif len(spec.sensors) == 18:
            raise ContractError(
                "an 18-sensor CARLA rig must contain exactly 8 cameras, 6 LiDARs, and 4 radars"
            )
        library = self.world.get_blueprint_library()
        sensor_blueprints = NATIVE_SENSOR_BLUEPRINTS
        quality_attributes = {
            "preview": {"enable_postprocess_effects": "False", "motion_blur_intensity": "0.0", "gamma": "2.2"},
            "standard": {"enable_postprocess_effects": "True", "motion_blur_intensity": "0.0", "gamma": "2.2"},
            "high": {"enable_postprocess_effects": "True", "motion_blur_intensity": "0.0", "gamma": "2.2"},
            "cinematic": {"enable_postprocess_effects": "True", "motion_blur_intensity": "0.0", "gamma": "2.2"},
        }
        for requested in spec.sensors:
            check()
            key = requested.artifact_name
            try:
                blueprint = library.find(sensor_blueprints[requested.modality])
            except (KeyError, RuntimeError) as exc:
                raise RuntimeError(
                    f"CARLA runtime is missing native {requested.modality} blueprint "
                    f"{sensor_blueprints[requested.modality]}"
                ) from exc
            config = requested.config
            if requested.modality in {"rgb", "depth", "semantic", "instance", "normals"}:
                attributes = {
                    "image_size_x": config["width"],
                    "image_size_y": config["height"],
                    "fov": config["fov"],
                }
                if requested.modality == "rgb":
                    requested_grade = dict(DEFAULT_RGB_CAMERA_GRADE)
                    loaded_map_name = str(self.map_evidence.get("loadedMapName", ""))
                    for map_token, exposure in MAP_RGB_EXPOSURE:
                        if map_token in loaded_map_name:
                            requested_grade["exposure_compensation"] = exposure
                            break
                    applied_grade = {}
                    missing_grade = []
                    for name, value in requested_grade.items():
                        if blueprint.has_attribute(name):
                            blueprint.set_attribute(name, value)
                            applied_grade[name] = value
                        else:
                            missing_grade.append(name)
                    self.camera_grade_evidence[key] = {
                        "schema": "uniscenario.camera-grade-evidence/v1",
                        "profile": "rrmaps-accepted-v1",
                        "mapName": loaded_map_name,
                        "attributes": dict(sorted(applied_grade.items())),
                        "exact": not missing_grade,
                        "missingAttributes": sorted(missing_grade),
                        "postprocess": spec.quality != "preview",
                        "motionBlurIntensity": 0.0,
                    }
                    self.visual_quality_stats[key] = {
                        "sampleCount": 0,
                        "nearBlackCount": 0,
                        "nearWhiteCount": 0,
                        "chromaticCount": 0,
                        "midtoneCount": 0,
                        "minLuma": 255,
                        "maxLuma": 0,
                    }
                for name, value in quality_attributes[spec.quality].items():
                    if blueprint.has_attribute(name):
                        blueprint.set_attribute(name, value)
                extension = "png"
                converter = None if requested.modality == "rgb" else self.carla.ColorConverter.Raw
            elif requested.modality in {"lidar", "semantic-lidar"}:
                attributes = {
                    "channels": config["channels"],
                    "range": config["rangeM"],
                    "points_per_second": config["pointsPerSecond"],
                    "rotation_frequency": config["rotationFrequencyHz"],
                    "upper_fov": config["upperFovDeg"],
                    "lower_fov": config["lowerFovDeg"],
                }
                extension = "ply"
                converter = None
            else:
                attributes = {
                    "horizontal_fov": config["horizontalFovDeg"],
                    "vertical_fov": config["verticalFovDeg"],
                    "range": config["rangeM"],
                    "points_per_second": config["pointsPerSecond"],
                }
                extension = "csv"
                converter = None
            attributes["sensor_tick"] = self.fixed_timestep_s
            for name, value in attributes.items():
                if not blueprint.has_attribute(name):
                    raise RuntimeError(
                        f"CARLA native {requested.modality} blueprint lacks required attribute {name}"
                    )
                blueprint.set_attribute(name, str(value))
            t = requested.transform
            transform = self.carla.Transform(
                self.carla.Location(x=t["x"], y=-t["y"], z=t["z"]),
                self.carla.Rotation(pitch=t["pitch"], yaw=-t["yaw"], roll=t["roll"]),
            )
            parent = self.actors.get(requested.actor_id) if requested.actor_id is not None else None
            sensor_actor = self.world.spawn_actor(blueprint, transform, attach_to=parent)
            if sensor_actor is None:
                raise RuntimeError(f"CARLA failed to spawn native sensor {key}")
            observed_sensor_type = str(getattr(sensor_actor, "type_id", ""))
            expected_sensor_type = sensor_blueprints[requested.modality]
            if observed_sensor_type != expected_sensor_type:
                sensor_actor.destroy()
                raise RuntimeError(
                    f"CARLA sensor {key} spawned as {observed_sensor_type!r}, "
                    f"expected {expected_sensor_type!r}"
                )
            if self.pronto_sensor_host_actor_id is not None:
                observed_parent = getattr(sensor_actor, "parent", None)
                if (
                    parent is None
                    or observed_parent is None
                    or getattr(observed_parent, "id", None) != getattr(parent, "id", None)
                    or getattr(observed_parent, "type_id", None) != KIA_CARNIVAL_BLUEPRINT_ID
                ):
                    sensor_actor.destroy()
                    raise RuntimeError(
                        f"CARLA sensor {key} did not read back exact Kia Carnival parent ownership"
                    )
            check()
            target_dir = output_dir / key
            target_dir.mkdir(parents=True, exist_ok=False)
            self.sensor_configs[key] = {
                "target": target_dir,
                "role": requested.role,
                "actorId": requested.actor_id,
                "sensorId": requested.sensor_id,
                "modality": requested.modality,
                "converter": converter,
                "extension": extension,
                "transform": dict(requested.transform),
                "config": dict(requested.config),
            }
            sensor_actor.listen(lambda data, sensor_key=key: self._receive_sensor_frame(sensor_key, data))
            self.sensors.append(sensor_actor)
            check()

        if "video" in spec.outputs and self.pronto_sensor_host_actor_id is not None:
            self._configure_presentation_camera(spec, output_dir, library, quality_attributes, check)

    def _configure_presentation_camera(
        self,
        spec: RenderSpec,
        output_dir: Path,
        library: Any,
        quality_attributes: Mapping[str, Mapping[str, str]],
        check: Callable[[], None],
    ) -> None:
        """Attach a presentation-only chase camera without changing the authored rig."""
        key = "presentation-trailing-camera"
        host_actor_id = self.pronto_sensor_host_actor_id
        assert host_actor_id is not None
        host = self.actors.get(host_actor_id)
        if host is None:
            raise RuntimeError("the Pronto presentation camera has no runtime host actor")
        blueprint = library.find(NATIVE_SENSOR_BLUEPRINTS["rgb"])
        primary_rgb = next(sensor for sensor in spec.sensors if sensor.modality == "rgb")
        attributes = {
            "image_size_x": primary_rgb.config["width"],
            "image_size_y": primary_rgb.config["height"],
            "fov": 90.0,
            "sensor_tick": self.fixed_timestep_s,
        }
        requested_grade = dict(DEFAULT_RGB_CAMERA_GRADE)
        loaded_map_name = str(self.map_evidence.get("loadedMapName", ""))
        for map_token, exposure in MAP_RGB_EXPOSURE:
            if map_token in loaded_map_name:
                requested_grade["exposure_compensation"] = exposure
                break
        applied_grade = {}
        missing_grade = []
        for name, value in requested_grade.items():
            if blueprint.has_attribute(name):
                blueprint.set_attribute(name, value)
                applied_grade[name] = value
            else:
                missing_grade.append(name)
        for name, value in quality_attributes[spec.quality].items():
            if blueprint.has_attribute(name):
                blueprint.set_attribute(name, value)
        for name, value in attributes.items():
            if not blueprint.has_attribute(name):
                raise RuntimeError(f"CARLA presentation camera blueprint lacks required attribute {name}")
            blueprint.set_attribute(name, str(value))
        transform = self.carla.Transform(
            self.carla.Location(x=-8.0, y=0.0, z=4.0),
            self.carla.Rotation(pitch=-12.0, yaw=0.0, roll=0.0),
        )
        sensor_actor = self.world.spawn_actor(blueprint, transform, attach_to=host)
        if sensor_actor is None:
            raise RuntimeError("CARLA failed to spawn the Pronto presentation camera")
        if (
            str(getattr(sensor_actor, "type_id", "")) != NATIVE_SENSOR_BLUEPRINTS["rgb"]
            or getattr(getattr(sensor_actor, "parent", None), "id", None) != getattr(host, "id", None)
        ):
            sensor_actor.destroy()
            raise RuntimeError("CARLA presentation camera did not read back exact host ownership")
        target_dir = output_dir / key
        target_dir.mkdir(parents=True, exist_ok=False)
        self.sensor_configs[key] = {
            "target": target_dir,
            "role": key,
            "actorId": host_actor_id,
            "sensorId": key,
            "modality": "rgb",
            "converter": None,
            "extension": "png",
            "transform": {"x": -8.0, "y": 0.0, "z": 4.0, "pitch": -12.0, "yaw": 0.0, "roll": 0.0},
            "config": {
                "width": primary_rgb.config["width"],
                "height": primary_rgb.config["height"],
                "fov": 90.0,
            },
        }
        self.camera_grade_evidence[key] = {
            "schema": "uniscenario.camera-grade-evidence/v1",
            "profile": "rrmaps-accepted-v1",
            "mapName": loaded_map_name,
            "attributes": dict(sorted(applied_grade.items())),
            "exact": not missing_grade,
            "missingAttributes": sorted(missing_grade),
            "postprocess": spec.quality != "preview",
            "motionBlurIntensity": 0.0,
        }
        sensor_actor.listen(lambda data: self._receive_sensor_frame(key, data))
        self.sensors.append(sensor_actor)
        self.presentation_camera_key = key
        check()

    def _receive_sensor_frame(self, sensor_key: str, data: Any) -> None:
        with self.sensor_condition:
            if self.sensor_closed:
                return
            frame = int(data.frame)
            prior = self.sensor_last_frame.get(sensor_key)
            if prior is not None and frame <= prior:
                kind = "duplicate" if frame == prior else "out-of-order"
                self.sensor_error = RuntimeError(f"{kind} sensor callback for {sensor_key}: {frame} after {prior}")
            elif sensor_key in self.sensor_pending.setdefault(frame, {}):
                self.sensor_error = RuntimeError(f"duplicate sensor callback for {sensor_key}: {frame}")
            else:
                self.sensor_last_frame[sensor_key] = frame
                self.sensor_pending[frame][sensor_key] = data
                if len(self.sensor_pending) > 4:
                    self.sensor_error = RuntimeError("CARLA sensor callback backpressure exceeded four world frames")
            self.sensor_condition.notify_all()

    @staticmethod
    def _write_radar_csv(target: Path, measurement: Any) -> None:
        with target.open("w", encoding="utf-8", newline="\n") as output:
            output.write("depth_m,azimuth_rad,altitude_rad,velocity_mps\n")
            for detection in measurement:
                output.write(
                    f"{float(detection.depth):.9g},{float(detection.azimuth):.9g},"
                    f"{float(detection.altitude):.9g},{float(detection.velocity):.9g}\n"
                )

    def _sample_rgb_visual_quality(self, camera_id: str, image: Any) -> None:
        config = self.sensor_configs[camera_id]
        raw = memoryview(image.raw_data)
        sensor_config = config.get("config", config)
        pixel_count = int(sensor_config["width"]) * int(sensor_config["height"])
        if len(raw) != pixel_count * 4:
            raise RuntimeError(f"RGB camera {camera_id} returned an invalid BGRA frame")
        stride = max(1, pixel_count // VISUAL_SAMPLE_TARGET)
        stats = self.visual_quality_stats.setdefault(camera_id, {
            "sampleCount": 0,
            "nearBlackCount": 0,
            "nearWhiteCount": 0,
            "midtoneCount": 0,
            "chromaticCount": 0,
            "minLuma": 255,
            "maxLuma": 0,
        })
        for pixel in range(0, pixel_count, stride):
            offset = pixel * 4
            blue, green, red = int(raw[offset]), int(raw[offset + 1]), int(raw[offset + 2])
            low, high = min(red, green, blue), max(red, green, blue)
            luma = (77 * red + 150 * green + 29 * blue) >> 8
            stats["sampleCount"] += 1
            stats["nearBlackCount"] += int(high <= 16)
            stats["nearWhiteCount"] += int(low >= 240)
            stats["midtoneCount"] += int(32 <= luma <= 223)
            stats["chromaticCount"] += int(high - low >= 8)
            stats["minLuma"] = min(stats["minLuma"], luma)
            stats["maxLuma"] = max(stats["maxLuma"], luma)

    def _visual_quality_report(self) -> Mapping[str, Any]:
        cameras: dict[str, Any] = {}
        overall = True
        for camera_id, stats in sorted(self.visual_quality_stats.items()):
            count = stats["sampleCount"]
            near_black = stats["nearBlackCount"] / count if count else 1.0
            near_white = stats["nearWhiteCount"] / count if count else 1.0
            chromatic = stats["chromaticCount"] / count if count else 0.0
            midtone = stats["midtoneCount"] / count if count else 0.0
            luma_range = stats["maxLuma"] - stats["minLuma"] if count else 0
            checks = {
                "hasSamples": count > 0,
                "notNearBlack": near_black <= VISUAL_MAX_NEAR_BLACK_FRACTION,
                "notNearWhite": near_white <= VISUAL_MAX_NEAR_WHITE_FRACTION,
                "luminanceRange": luma_range >= VISUAL_MIN_LUMA_RANGE,
                "chromaticContent": chromatic >= VISUAL_MIN_CHROMATIC_FRACTION,
                "midtoneContent": midtone >= VISUAL_MIN_MIDTONE_FRACTION,
            }
            passed = all(checks.values())
            overall = overall and passed
            cameras[camera_id] = {
                "verdict": "pass" if passed else "fail",
                "sampleCount": count,
                "nearBlackFraction": near_black,
                "nearWhiteFraction": near_white,
                "chromaticFraction": chromatic,
                "midtoneFraction": midtone,
                "lumaRange": luma_range,
                "checks": checks,
            }
        return {
            "schema": "uniscenario.visual-quality-evidence/v1",
            "verdict": "pass" if overall and cameras else "fail",
            "cameras": cameras,
        }

    def _write_sensor_frame(
        self,
        sensor_key: str,
        data: Any,
        output_index: int,
        scheduled_time: float,
        carla_frame: int,
    ) -> tuple[dict[str, Any], Path, int]:
        config = self.sensor_configs[sensor_key]
        converter = config["converter"]
        if config["modality"] == "rgb" and hasattr(data, "raw_data"):
            self._sample_rgb_visual_quality(sensor_key, data)
        if converter is not None:
            data.convert(converter)
        filename = f"{output_index:08d}.{config['extension']}"
        target = config["target"] / filename
        if config["modality"] == "radar":
            self._write_radar_csv(target, data)
        else:
            data.save_to_disk(str(target))
        size = target.stat().st_size
        relative = f"{sensor_key}/{filename}"
        record = {
            "artifactName": sensor_key,
            "role": config["role"],
            "actorId": config["actorId"],
            "sensorId": config["sensorId"],
            "modality": config["modality"],
            "outputFrameIndex": output_index,
            "scheduledTimeS": scheduled_time,
            "carlaFrame": carla_frame,
            "actualCarlaTimeS": float(data.timestamp),
            "relativePath": relative,
        }
        return record, target, size

    def _capture_world_frame(self, carla_frame: int, capture: Mapping[str, float | int], abort: Callable[[], None] | None = None) -> None:
        check = abort or (lambda: None)
        check()
        expected = set(self.sensor_configs)
        deadline = monotonic() + self.sensor_timeout_s
        while True:
            with self.sensor_condition:
                if self.sensor_error:
                    raise self.sensor_error
                received = set(self.sensor_pending.get(carla_frame, {}))
                if received == expected:
                    images = self.sensor_pending.pop(carla_frame)
                    for old_frame in [frame for frame in self.sensor_pending if frame < carla_frame]:
                        del self.sensor_pending[old_frame]
                    break
                remaining = deadline - monotonic()
                if remaining <= 0:
                    missing = sorted(expected - received)
                    raise RuntimeError(f"sensor frame timeout at CARLA frame {carla_frame}; missing: {', '.join(missing)}")
                self.sensor_condition.wait(min(0.25, remaining))
            check()
        output_index = int(capture["outputFrameIndex"])
        scheduled_time = float(capture["scheduledTimeS"])
        if self.sensor_writer_pool is None:
            self.sensor_writer_pool = ThreadPoolExecutor(
                max_workers=self.sensor_writer_workers,
                thread_name_prefix="carla-sensor-writer",
            )
        futures = [
            self.sensor_writer_pool.submit(
                self._write_sensor_frame,
                sensor_key,
                images[sensor_key],
                output_index,
                scheduled_time,
                carla_frame,
            )
            for sensor_key in sorted(images)
        ]
        written = [future.result() for future in futures]
        check()
        charged = sum(size + 4096 for _record, _target, size in written)
        if self.capture_disk_bytes + charged > self.max_capture_disk_bytes:
            for _record, target, _size in written:
                target.unlink(missing_ok=True)
            raise ContractError("captured frames exceed the incremental temporary-disk quota")
        self.capture_disk_bytes += charged
        with self.sensor_lock:
            self.sensor_records.extend(record for record, _target, _size in written)
        check()

    def sensor_manifest(self, abort: Callable[[], None] | None = None) -> list[Mapping[str, Any]]:
        check = abort or (lambda: None)
        check()
        with self.sensor_lock:
            presentation_camera_key = getattr(self, "presentation_camera_key", None)
            snapshot = [
                item for item in self.sensor_records
                if item["artifactName"] != presentation_camera_key
            ]
        records = []
        for item in snapshot:
            check()
            records.append(dict(item))
        check()
        return sorted(
            records,
            key=lambda item: (
                item["outputFrameIndex"], item["role"], item["actorId"] or "",
                item["sensorId"], item["modality"],
            ),
        )

    def apply(self, frame: PlanFrame, abort: Callable[[], None] | None = None) -> None:
        check = abort or (lambda: None)
        check()
        self.absent_actors = getattr(self, "absent_actors", set())
        self.actor_lifecycle = getattr(self, "actor_lifecycle", {})
        self.applied_appearance = getattr(self, "applied_appearance", {})
        self.appearance_verification = getattr(self, "appearance_verification", {})
        self.last_controls = getattr(self, "last_controls", {})
        self.downed_actor_ids = getattr(self, "downed_actor_ids", set())
        self.current_plan_frame = (frame.index, frame.t)
        if not set(frame.signals).issubset(self.signals):
            missing = sorted(set(frame.signals) - set(self.signals))
            raise RuntimeError(f"authored OpenDRIVE traffic signal heads were not preflighted: {', '.join(missing)}")
        if frame.signals:
            light_states = {
                "red": self.carla.TrafficLightState.Red,
                "yellow": self.carla.TrafficLightState.Yellow,
                "green": self.carla.TrafficLightState.Green,
                "off": self.carla.TrafficLightState.Off,
            }
            for signal_id, indication in frame.signals.items():
                check()
                lamp = light_states[resolve_signal_lamp(indication, frame.t)]
                self.signals[signal_id].set_state(lamp)
                self.executed_signals[signal_id] = indication
                self.executed_signal_lamps[signal_id] = lamp
        for actor_id, state in frame.actors.items():
            check()
            if state.lifecycle == LIFECYCLE_ABSENT:
                self._destroy_absent_actor(actor_id)
                continue
            actor = self.actors.get(actor_id)
            if actor is None:
                raise RuntimeError(f"active actor {actor_id} is missing from CARLA")
            self.actor_lifecycle[actor_id] = state.lifecycle
            self._apply_appearance(actor_id, actor, state.appearance, frame.t)
            target = self.carla.Transform(self.carla.Location(x=state.x, y=-state.y, z=state.z), self.carla.Rotation(yaw=-state.heading_deg))
            if self.execution_mode == "diagnostic-replay":
                actor.set_transform(target)
                actor.set_target_velocity(target.transform_vector(self.carla.Vector3D(x=state.speed_mps, y=0, z=0)))
                continue
            if actor_id in getattr(self, "static_actor_ids", set()):
                if abs(state.speed_mps) > 1e-6:
                    raise RuntimeError(f"authored static actor {actor_id} has non-zero speed")
                continue
            velocity = actor.get_velocity()
            if actor.type_id.startswith("walker."):
                if state.speed_mps < -1e-6:
                    raise RuntimeError(f"native physics does not support reverse pedestrian motion for {actor_id}")
                if state.downed:
                    actor.apply_control(
                        self.carla.WalkerControl(direction=target.get_forward_vector(), speed=0.0, jump=False)
                    )
                    if actor_id not in self.downed_actor_ids:
                        actor.set_simulate_physics(False)
                        self.downed_actor_ids.add(actor_id)
                    walker_z = actor.get_transform().location.z
                    actor.set_transform(self.carla.Transform(
                        self.carla.Location(x=state.x, y=-state.y, z=walker_z + 0.25),
                        self.carla.Rotation(pitch=90.0, yaw=-state.heading_deg),
                    ))
                    continue
                direction = target.get_forward_vector()
                actor.apply_control(
                    self.carla.WalkerControl(direction=direction, speed=state.speed_mps, jump=False)
                )
                walker_z = actor.get_transform().location.z
                actor.set_transform(self.carla.Transform(
                    self.carla.Location(x=state.x, y=-state.y, z=walker_z),
                    self.carla.Rotation(yaw=-state.heading_deg),
                ))
                continue
            if actor.type_id.startswith(("vehicle.", "bike.")):
                current_transform = actor.get_transform()
                current_yaw = current_transform.rotation.yaw
                yaw_error = ((-state.heading_deg - current_yaw + 180) % 360) - 180
                forward = self._forward_vector(current_transform)
                signed_speed = velocity.x * forward[0] + velocity.y * forward[1] + velocity.z * forward[2]
                reverse = state.speed_mps < -1e-6
                progress_speed = -signed_speed if reverse else signed_speed
                delta_x = state.x - current_transform.location.x
                delta_y = -state.y - current_transform.location.y
                along_error = delta_x * forward[0] + delta_y * forward[1]
                movement_sign = -1.0 if reverse else 1.0
                requested_progress = max(
                    0.0,
                    abs(state.speed_mps) + max(-2.0, min(2.0, movement_sign * along_error * 0.45)),
                )
                throttle, brake = self._vehicle_longitudinal_control(actor_id, requested_progress, progress_speed)
                lateral_error = -forward[1] * delta_x + forward[0] * delta_y
                lookahead = max(2.0, abs(state.speed_mps) * 0.8)
                path_correction_deg = degrees(atan2(lateral_error, lookahead))
                steer_sign = -1.0 if reverse else 1.0
                steer = min(1.0, max(-1.0, steer_sign * (yaw_error + path_correction_deg) / 35.0))
                control = self.carla.VehicleControl(throttle=throttle, brake=brake, steer=steer)
                try:
                    control.reverse = reverse
                except (AttributeError, TypeError) as exc:
                    if reverse:
                        raise RuntimeError("CARLA VehicleControl cannot express reverse motion") from exc
                actor.apply_control(control)
                self.last_controls[actor_id] = {
                    "targetSpeedMps": state.speed_mps,
                    "observedSignedSpeedMps": signed_speed,
                    "alongTrackErrorM": along_error,
                    "lateralErrorM": lateral_error,
                    "headingErrorDeg": yaw_error,
                    "throttle": throttle,
                    "brake": brake,
                    "steer": steer,
                    "reverse": reverse,
                }
                continue
            if abs(state.speed_mps) > 1e-6:
                raise RuntimeError(f"native physics does not support moving actor type {actor.type_id}")
        check()

    def _destroy_absent_actor(self, actor_id: str) -> None:
        """Execute DeleteEntityAction without teleporting a native actor."""
        if actor_id in self.absent_actors:
            return
        actor = self.actors.pop(actor_id, None)
        if actor is None:
            raise RuntimeError(f"DeleteEntityAction references missing CARLA actor {actor_id}")
        self.absent_actors.add(actor_id)
        self.actor_lifecycle[actor_id] = LIFECYCLE_ABSENT
        if actor.destroy() is False:
            raise RuntimeError(f"CARLA failed to destroy absent actor {actor_id}")

    def _apply_appearance(self, actor_id: str, actor: Any, appearance: Mapping[str, str], t: float) -> None:
        """Drive the authored appearance state CARLA can physically render.

        `cue.*` entries are OpenSCENARIO `UserDefinedAnimation` requests
        (`pose.*` articulation, `audio.horn`). CARLA 0.10.0's Python API exposes
        no audio at all, and no *named* animations — only raw per-bone transform
        injection on `carla.Walker` (`get_bones`/`set_bones`, `blend_pose`,
        `show_pose`/`hide_pose`, `get_pose_from_animation`, with the module-level
        `WalkerBoneControlIn`/`Out` payloads). `carla.Vehicle` and `carla.Actor`
        have no bone members at all.

        The cues in flight are *named semantic* poses — `pose.stopArm:extended`,
        `pose.gesture:halt`, `pose.paddle:stop` — and there is no named-animation
        library to resolve them against, so rendering one would mean
        hand-authoring bone transforms for the pedestrian skeleton. That is a
        real feature, not an impossibility; until it exists these are deliberately
        not applied here and the render manifest reports them as unrendered cues.
        """
        self.applied_appearance = getattr(self, "applied_appearance", {})
        self.appearance_verification = getattr(self, "appearance_verification", {})
        self.door_states = getattr(self, "door_states", {})
        lights = {key[len("light."):]: value for key, value in appearance.items() if key.startswith("light.")}
        doors = {key[len("door."):]: value for key, value in appearance.items() if key.startswith("door.")}
        if lights:
            self._apply_vehicle_lights(actor_id, actor, lights, t)
        if doors:
            self._apply_vehicle_doors(actor_id, actor, doors)
        self.applied_appearance[actor_id] = dict(appearance)

    def _apply_vehicle_lights(self, actor_id: str, actor: Any, lights: Mapping[str, str], t: float) -> None:
        """Write the authored light bits, leaving every unowned bit untouched.

        This method is the ONLY writer of the vehicle light mask in this worker.
        There is no autopilot, no Traffic Manager, and no sun-altitude headlight
        pass here, so authored scenario intent is authoritative by construction:
        a scenario that sets `lights.headlights: off` keeps the vehicle dark even
        in a midnight render, and one that never mentions headlights leaves them
        exactly as the blueprint spawned them.

        That is a deliberate difference from the legacy render fleet, whose
        low-sun pass drives headlights automatically and therefore has to contend
        with the blinker writer over one shared mask. This worker is a separate
        service with no shared runtime (an import-boundary test pins that), so the
        contention does not exist and must not be reintroduced: the scenario is
        the artifact under test, and render determinism outranks the visual
        plausibility of an automatically-lit night scene.
        """
        light_state_cls = getattr(self.carla, "VehicleLightState", None)
        if light_state_cls is None:
            raise RuntimeError("this .xosc authors vehicle light states but the CARLA runtime has no VehicleLightState")
        owned = 0
        wanted_bits = 0
        # Sorted so `warningLights` resolves after the individual indicators it
        # overlaps, making hazard flashers win over a stale indicator setting.
        for light_type in sorted(lights):
            bit = 0
            for member in VEHICLE_LIGHT_BITS[light_type]:
                value = getattr(light_state_cls, member, None)
                if value is None:
                    raise RuntimeError(f"the CARLA runtime has no VehicleLightState.{member} for {light_type}")
                bit |= int(value)
            owned |= bit
            mode = lights[light_type]
            if mode == "on" or (mode == "flashing" and flash_on(t)):
                wanted_bits |= bit
            else:
                wanted_bits &= ~bit
        current = int(actor.get_light_state())
        wanted = (current & ~owned) | wanted_bits
        if wanted != current:
            actor.set_light_state(light_state_cls(wanted))
        observed = int(actor.get_light_state())
        if observed & owned != wanted & owned:
            raise RuntimeError("CARLA vehicle light readback differs from the authored state")
        verification = self.appearance_verification.setdefault(actor_id, {})
        for light_type in lights:
            verification[f"light.{light_type}"] = "runtime-readback"

    def _apply_vehicle_doors(self, actor_id: str, actor: Any, doors: Mapping[str, str]) -> None:
        door_cls = getattr(self.carla, "VehicleDoor", None)
        opener, closer = getattr(actor, "open_door", None), getattr(actor, "close_door", None)
        if door_cls is None or not callable(opener) or not callable(closer):
            raise RuntimeError("this .xosc authors vehicle door states but the CARLA runtime has no door control API")
        for component in sorted(doors):
            state = doors[component]
            if self.door_states.get((actor_id, component)) == state:
                continue
            member = getattr(door_cls, VEHICLE_DOOR_MEMBERS[component], None)
            if member is None:
                raise RuntimeError(f"the CARLA runtime has no VehicleDoor.{VEHICLE_DOOR_MEMBERS[component]}")
            (opener if state == "open" else closer)(member)
            self.door_states[(actor_id, component)] = state
            self.appearance_verification.setdefault(actor_id, {})[f"door.{component}"] = "command-confirmed"

    @staticmethod
    def _forward_vector(transform: Any) -> tuple[float, float, float]:
        getter = getattr(transform, "get_forward_vector", None)
        if callable(getter):
            value = getter()
            return float(value.x), float(value.y), float(value.z)
        yaw = radians(float(transform.rotation.yaw))
        return cos(yaw), sin(yaw), 0.0

    def tick(self, capture: Mapping[str, float | int] | None = None, abort: Callable[[], None] | None = None) -> Mapping[str, Mapping[str, Any]]:
        assert self.world is not None
        check = abort or (lambda: None)
        check()
        self.current_plan_frame = getattr(self, "current_plan_frame", None)
        self.carla_to_plan_frame = getattr(self, "carla_to_plan_frame", {})
        primary = self.actors.get(getattr(self, "streaming_primary_actor_id", None) or "")
        streaming_evidence = getattr(self, "streaming_evidence", None)
        if primary is not None:
            try:
                source = primary.get_transform()
                spectator = self.world.get_spectator()
                spectator.set_transform(self.carla.Transform(
                    self.carla.Location(
                        x=float(source.location.x),
                        y=float(source.location.y),
                        z=float(source.location.z) + 30.0,
                    ),
                    self.carla.Rotation(
                        pitch=-15.0,
                        yaw=float(source.rotation.yaw),
                        roll=0.0,
                    ),
                ))
                if streaming_evidence is not None:
                    streaming_evidence["spectatorFollow"] = "active"
            except Exception:
                if streaming_evidence is not None:
                    streaming_evidence["spectatorFollow"] = "unavailable"
        carla_frame = int(self.world.tick())
        self.last_carla_frame = carla_frame
        if self.current_plan_frame is not None:
            self.carla_to_plan_frame[carla_frame] = self.current_plan_frame
        check()
        if capture is not None:
            self._capture_world_frame(carla_frame, capture, abort)
        else:
            with self.sensor_condition:
                if self.sensor_error:
                    raise self.sensor_error
                for old_frame in [frame for frame in self.sensor_pending if frame <= carla_frame]:
                    del self.sensor_pending[old_frame]
            check()
        absent_actors = getattr(self, "absent_actors", set())
        actor_lifecycle = getattr(self, "actor_lifecycle", {})
        applied_appearance = getattr(self, "applied_appearance", {})
        result = {}
        for actor_id, actor in self.actors.items():
            check()
            transform, velocity = actor.get_transform(), actor.get_velocity()
            forward = self._forward_vector(transform)
            signed_speed = velocity.x * forward[0] + velocity.y * forward[1] + velocity.z * forward[2]
            acceleration_getter = getattr(actor, "get_acceleration", None)
            acceleration = acceleration_getter() if callable(acceleration_getter) else None
            signed_acceleration = (
                acceleration.x * forward[0] + acceleration.y * forward[1] + acceleration.z * forward[2]
                if acceleration is not None else None
            )
            result[actor_id] = {
                "x": transform.location.x,
                "y": -transform.location.y,
                "z": transform.location.z,
                "headingDeg": -transform.rotation.yaw,
                "speedMps": signed_speed,
                "speedMagnitudeMps": sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2),
                "accelerationMps2": signed_acceleration,
                "present": True,
                "lifecycle": actor_lifecycle.get(actor_id, "active"),
                "appearance": dict(applied_appearance.get(actor_id, {})),
            }
        for actor_id in sorted(absent_actors):
            result[actor_id] = {
                "present": False,
                "lifecycle": LIFECYCLE_ABSENT,
                "appearance": dict(applied_appearance.get(actor_id, {})),
            }
        return result

    def collision_readback(self, frame_index: int, t: float, abort: Callable[[], None] | None = None) -> list[Mapping[str, Any]]:
        check = abort or (lambda: None)
        check()
        boundary = self.last_carla_frame
        if boundary is None:
            return []
        with self.collision_lock:
            ready = [item for item in self.collision_pending if int(item["carlaFrame"]) <= boundary]
            self.collision_pending = [item for item in self.collision_pending if int(item["carlaFrame"]) > boundary]
        result = []
        for item in sorted(ready, key=lambda value: (value["carlaFrame"], tuple(value["pair"]))):
            check()
            source_frame, source_t = self.carla_to_plan_frame.get(int(item["carlaFrame"]), (frame_index, t))
            normalized = {**item, "frame": source_frame, "t": source_t, "pair": list(item["pair"])}
            result.append(normalized)
            self.collision_history.append(normalized)
        check()
        return result

    def runtime_evidence(self, abort: Callable[[], None] | None = None) -> Mapping[str, Any]:
        check = abort or (lambda: None)
        check()
        client_version = getattr(self.client, "get_client_version", lambda: "unavailable")()
        server_version = getattr(self.client, "get_server_version", lambda: "unavailable")()
        check()
        managed = os.environ.get("SIMFORGE_MANAGED_EXECUTION") == "1"
        configured_manifest_sha256 = os.environ.get("UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256")
        configured_blueprint = os.environ.get("UNISCENARIOS_CARLA_BLUEPRINT_ID")
        configured_class = os.environ.get("UNISCENARIOS_CARLA_BLUEPRINT_CLASS")
        image_exact = (
            configured_manifest_sha256 == CARLA_IMAGE_AMD64_MANIFEST_DIGEST.removeprefix("sha256:")
            and configured_blueprint == KIA_CARNIVAL_BLUEPRINT_ID
            and configured_class == KIA_CARNIVAL_CLASS_PATH
        )
        if managed and not image_exact:
            raise RuntimeError(
                "managed CARLA execution is not running the pinned Kia image/blueprint identity"
            )
        pronto_host = None
        if self.pronto_sensor_host_actor_id is not None:
            pronto_host = {
                "actorId": self.pronto_sensor_host_actor_id,
                **self.actor_asset_evidence[self.pronto_sensor_host_actor_id],
                "requiredCatalogId": KIA_CARNIVAL_CATALOG_ID,
                "requiredBlueprintId": KIA_CARNIVAL_BLUEPRINT_ID,
                "classPath": KIA_CARNIVAL_CLASS_PATH,
                "make": KIA_CARNIVAL_MAKE,
                "model": KIA_CARNIVAL_MODEL,
                "baseType": KIA_CARNIVAL_BASE_TYPE,
                "verification": "catalog-binding-and-runtime-type-id-readback",
            }
        return {
            "schema": "uniscenario.carla-runtime-evidence/v1",
            "available": True,
            "executionMode": self.execution_mode,
            "physicsAuthority": self.execution_mode == "native-physics",
            "acceptanceEligible": self.execution_mode == "native-physics",
            "motionApplication": "native-controls" if self.execution_mode == "native-physics" else "diagnostic-teleport-replay",
            "carlaClientVersion": str(client_version),
            "carlaServerVersion": str(server_version),
            "runtimeImage": {
                "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
                "indexSha256": CARLA_IMAGE_INDEX_DIGEST.removeprefix("sha256:"),
                "linuxAmd64ManifestSha256": CARLA_IMAGE_AMD64_MANIFEST_DIGEST.removeprefix("sha256:"),
                "configuredManifestSha256": configured_manifest_sha256,
                "configuredBlueprintId": configured_blueprint,
                "configuredClassPath": configured_class,
                "managed": managed,
                "exact": image_exact,
            },
            "actorAssets": {
                actor_id: dict(values)
                for actor_id, values in sorted(self.actor_asset_evidence.items())
            },
            "prontoSensorHost": pronto_host,
            "map": dict(self.map_evidence),
            "environment": dict(self.environment_evidence),
            "streaming": dict(self.streaming_evidence),
            "cameraGrade": {
                camera_id: dict(evidence)
                for camera_id, evidence in sorted(self.camera_grade_evidence.items())
            },
            "visualQuality": dict(self.visual_quality_evidence),
            "lifecycle": dict(sorted(self.actor_lifecycle.items())),
            "appearance": {
                actor_id: {
                    "applied": dict(sorted(values.items())),
                    "verification": dict(sorted(self.appearance_verification.get(actor_id, {}).items())),
                }
                for actor_id, values in sorted(self.applied_appearance.items())
            },
            "signals": {
                signal_id: {"authored": indication, "verification": "runtime-readback"}
                for signal_id, indication in sorted(self.executed_signals.items())
            },
            "nativeControls": {
                actor_id: dict(values) for actor_id, values in sorted(self.last_controls.items())
            },
            "collisions": list(self.collision_history),
            "sensors": {
                sensor_key: {
                    "role": config["role"],
                    "actorId": config["actorId"],
                    "sensorId": config["sensorId"],
                    "modality": config["modality"],
                    "transform": dict(config["transform"]),
                    "config": dict(config["config"]),
                    "capturedFrames": sum(
                        1 for item in self.sensor_records
                        if item["artifactName"] == sensor_key
                    ),
                    "verification": "frame-closed-runtime-readback",
                }
                for sensor_key, config in sorted(self.sensor_configs.items())
            },
        }

    def finalize_capture(self, expected_frame_count: int, abort: Callable[[], None] | None = None) -> None:
        check = abort or (lambda: None)
        check()
        with self.sensor_condition:
            self.sensor_closed = True
            if self.sensor_error:
                raise self.sensor_error
            records = list(self.sensor_records)
            self.sensor_pending.clear()
        for sensor in self.sensors:
            check()
            sensor.stop()
        indexes_by_sensor = {sensor_key: [] for sensor_key in self.sensor_configs}
        for item in records:
            check()
            indexes_by_sensor[item["artifactName"]].append(int(item["outputFrameIndex"]))
        for sensor_key, indexes in indexes_by_sensor.items():
            check()
            if indexes != list(range(expected_frame_count)):
                raise RuntimeError(
                    f"sensor {sensor_key} capture is not frame-closed: "
                    f"{len(indexes)} of {expected_frame_count}"
                )
        if any(config["modality"] == "rgb" for config in self.sensor_configs.values()):
            self.visual_quality_evidence = dict(self._visual_quality_report())
            if self.visual_quality_evidence["verdict"] != "pass":
                raise RuntimeError("CARLA RGB visual quality gate rejected captured output")
        check()

    def signal_readback(self, abort: Callable[[], None] | None = None) -> Mapping[str, str]:
        check = abort or (lambda: None)
        result: dict[str, str] = {}
        for signal_id, indication in sorted(self.executed_signals.items()):
            check()
            actual = self.signals[signal_id].get_state()
            if actual != self.executed_signal_lamps[signal_id]:
                raise RuntimeError(f"CARLA traffic signal {signal_id} did not retain its executed state")
            result[signal_id] = indication
        check()
        return result

    def cleanup(self) -> None:
        errors: list[Exception] = []
        try:
            self._restore_owned_signals()
        except Exception as exc:  # noqa: BLE001 - continue the rest of cleanup.
            errors.append(exc)
        writer_pool = getattr(self, "sensor_writer_pool", None)
        if writer_pool is not None:
            try:
                writer_pool.shutdown(wait=True, cancel_futures=True)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
            self.sensor_writer_pool = None
        for actor in [*getattr(self, "sensors", []), *getattr(self, "collision_sensors", []), *getattr(self, "actors", {}).values()]:
            try:
                actor.stop() if hasattr(actor, "stop") else None
                actor.destroy()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        self.sensors = []
        self.collision_sensors = []
        self.actors = {}
        self.executed_signals = {}
        self.executed_signal_lamps = {}
        if getattr(self, "world", None) is not None:
            try:
                settings = self.world.get_settings()
                settings.synchronous_mode = False
                settings.fixed_delta_seconds = None
                self.world.apply_settings(settings)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        if errors:
            raise RuntimeError(f"CARLA cleanup failed in {len(errors)} operation(s)") from errors[0]
