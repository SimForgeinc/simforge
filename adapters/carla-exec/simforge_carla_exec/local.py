"""Local process entry point for the SimForge-owned CARLA renderer."""

from __future__ import annotations

from ._compat_env import simforge_env
import argparse
import hashlib
import json
import os
import xml.etree.ElementTree as ET
import tempfile
from dataclasses import replace
from time import monotonic
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .capabilities import native_sensor_capabilities
from .runtime.backend import (
    CARLA_IMAGE_AMD64_MANIFEST_DIGEST,
    CARLA_IMAGE_INDEX_DIGEST,
    KIA_CARNIVAL_BASE_TYPE,
    KIA_CARNIVAL_BLUEPRINT_ID,
    KIA_CARNIVAL_CATALOG_ID,
    KIA_CARNIVAL_CLASS_PATH,
    KIA_CARNIVAL_MAKE,
    KIA_CARNIVAL_MODEL,
    PRONTO_CHASE_CAMERA_SENSOR_ID,
    CarlaBackend,
    cooked_map_name_for_xodr,
)
from .runtime.compiler import compile_xosc14
from .runtime.contract import (
    ASSET_CATALOG_SCHEMA,
    EMPTY_AMBIENT_CONFIG_SHA256,
    MAX_SENSOR_COUNT,
    OFFICIAL_XSD_SHA256,
    ContractError,
    RenderSpec,
    canonical_json,
    canonical_sha256,
    _control_value,
    parse_lease,
)
from .runtime.executor import execute_lease, filesystem_validator

DEFAULT_XSD = Path(__file__).parent / "assets" / "OpenSCENARIO.xsd"
INTENT_SCHEMA = "uniscenario.render-intent/v1"
INPUT_PACKAGE_SCHEMA_FIELDS = {"intentSha256", "inputs"}


def _probe(host: str, port: int) -> dict[str, object]:
    backend = CarlaBackend(host, port)
    try:
        # A listening RPC socket is insufficient: wedged CARLA servers still
        # answer version requests but fail every world operation.
        backend.client.get_world()
        return {
            "schema": "uniscenarios.carla-probe/v2",
            "clientVersion": str(getattr(backend.carla, "__version__", "unknown")),
            "serverVersion": str(backend.client.get_server_version()),
            "maxSimultaneousSensors": MAX_SENSOR_COUNT,
            "nativeSensors": native_sensor_capabilities(),
            "runtimeImage": {
                "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
                "indexDigest": CARLA_IMAGE_INDEX_DIGEST,
                "linuxAmd64ManifestDigest": CARLA_IMAGE_AMD64_MANIFEST_DIGEST,
            },
            "prontoSensorHost": {
                "catalogId": KIA_CARNIVAL_CATALOG_ID,
                "blueprintId": KIA_CARNIVAL_BLUEPRINT_ID,
                "classPath": KIA_CARNIVAL_CLASS_PATH,
                "make": KIA_CARNIVAL_MAKE,
                "model": KIA_CARNIVAL_MODEL,
                "baseType": KIA_CARNIVAL_BASE_TYPE,
            },
        }
    finally:
        backend.cleanup()


def _probe_tick_barrier(
    host: str,
    port: int,
    fixed_delta_s: float = 0.02,
    ticks: int = 120,
) -> dict[str, object]:
    """Verify the server honors the synchronous tick barrier under load.

    The CARLA 0.10 UE5 runtime can keep ticking a POPULATED world by itself
    while synchronous mode is on, silently inflating simulated time (measured
    2x on an affected server) — every trajectory then runs faster than its
    plan and impacts carry multiplied energy. The render worker fails closed
    on this at execution time; this probe is the cheap pre-rollout gate.

    Spawns one probe vehicle into the CURRENT world (the leak only manifests
    with actors present), counts un-commanded engine ticks via world.tick()
    frame ids (integer-exact, immune to snapshot-cache lag), destroys the
    vehicle, and restores the prior world settings. Never loads a map.
    """
    backend = CarlaBackend(host, port)
    try:
        world = backend.client.get_world()
        original = world.get_settings()
        probe_settings = world.get_settings()
        probe_settings.synchronous_mode = True
        probe_settings.fixed_delta_seconds = fixed_delta_s
        world.apply_settings(probe_settings)
        vehicle = None
        try:
            def measure(count: int) -> tuple[int, float]:
                extra = 0
                previous = int(world.tick())
                start = float(world.get_snapshot().timestamp.elapsed_seconds)
                for _ in range(count):
                    current = int(world.tick())
                    extra += current - previous - 1
                    previous = current
                elapsed = float(world.get_snapshot().timestamp.elapsed_seconds) - start
                return extra, elapsed / (count * fixed_delta_s)

            empty_extra, empty_ratio = measure(60)
            library = world.get_blueprint_library()
            try:
                blueprint = library.find(KIA_CARNIVAL_BLUEPRINT_ID)
            except RuntimeError:
                candidates = sorted(library.filter("vehicle.*"), key=lambda item: item.id)
                if not candidates:
                    raise RuntimeError("current world offers no vehicle blueprint for the probe")
                blueprint = candidates[0]
            spawn_points = world.get_map().get_spawn_points()
            if not spawn_points:
                raise RuntimeError("current world offers no spawn points for the probe vehicle")
            transform = spawn_points[0]
            transform.location.z += 0.3
            vehicle = world.try_spawn_actor(blueprint, transform)
            if vehicle is None:
                raise RuntimeError("could not spawn the tick-barrier probe vehicle")
            for _ in range(30):
                world.tick()  # let the spawn drop settle out of the measurement
            populated_extra, populated_ratio = measure(ticks)
        finally:
            if vehicle is not None:
                vehicle.destroy()
            world.apply_settings(original)
        passed = empty_extra == 0 and populated_extra == 0 and abs(populated_ratio - 1.0) <= 0.1
        return {
            "schema": "uniscenarios.carla-tick-barrier-probe/v1",
            "serverVersion": str(backend.client.get_server_version()),
            "fixedDeltaS": fixed_delta_s,
            "emptyWorld": {
                "commandedTicks": 60,
                "unCommandedTicks": empty_extra,
                "simTimeRatio": round(empty_ratio, 4),
            },
            "populatedWorld": {
                "commandedTicks": ticks,
                "unCommandedTicks": populated_extra,
                "simTimeRatio": round(populated_ratio, 4),
                "probeBlueprint": str(getattr(blueprint, "id", blueprint)),
            },
            "verdict": "pass" if passed else "fail",
        }
    finally:
        backend.cleanup()


def _execute_local_lease(
    lease: Any,
    asset_paths: Mapping[str, Path],
    output_dir: Path,
    xsd: Path,
    host: str,
    port: int,
    progress: Callable[[str, Mapping[str, object]], None] | None = None,
) -> dict[str, object]:
    for label, source in asset_paths.items():
        if not source.is_file():
            raise ValueError(f"local asset for {label!r} is not a file: {source}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_by_url: dict[str, Path] = {}
    for kind, reservation in lease.artifact_uploads.items():
        safe_kind = "".join(character if character.isalnum() or character in ".-_" else "_" for character in kind)
        output_by_url[str(reservation["uploadUrl"])] = output_dir / f"{safe_kind}.artifact"

    def download_local(url: str, maximum: int) -> bytes:
        body = asset_paths[url].read_bytes()
        if len(body) > maximum:
            raise ValueError(f"local asset {url!r} exceeds its contract limit")
        return body

    def upload_local(
        url: str,
        body: bytes | Path,
        _media_type: str,
        _headers: Mapping[str, str] | None = None,
    ) -> None:
        target = output_by_url[url]
        if isinstance(body, Path):
            with body.open("rb") as source, target.open("wb") as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
        else:
            target.write_bytes(body)

    def bind_local(
        _kind: str,
        _digest: str,
        _size: int,
        media_type: str,
        reservation: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        return {**reservation, "requiredHeaders": {"content-type": media_type}}

    return execute_lease(
        lease,
        CarlaBackend(host, port),
        filesystem_validator(xsd),
        downloader=download_local,
        uploader=upload_local,
        authorize_upload=bind_local,
        progress=progress,
        runtime_asset_overrides={
            KIA_CARNIVAL_CATALOG_ID: {"blueprintId": KIA_CARNIVAL_BLUEPRINT_ID},
        },
    )




def _read_input_package(path: Path, intent: Mapping[str, Any]) -> tuple[str, dict[str, Path]]:
    package = json.loads(path.read_text("utf-8"))
    if not isinstance(package, Mapping) or set(package) != INPUT_PACKAGE_SCHEMA_FIELDS:
        raise ContractError("input package must contain exactly intentSha256 and inputs")
    expected_intent_sha = hashlib.sha256(canonical_json(intent).encode("utf-8")).hexdigest()
    if package.get("intentSha256") != expected_intent_sha:
        raise ContractError("input package intentSha256 does not match canonical render intent bytes")
    raw_inputs = package.get("inputs")
    if not isinstance(raw_inputs, list) or not raw_inputs:
        raise ContractError("input package inputs must be a non-empty array")
    base = path.parent
    paths: dict[str, Path] = {}
    for index, item in enumerate(raw_inputs):
        if not isinstance(item, Mapping) or set(item) != {"inputId", "path", "sha256", "sizeBytes"}:
            raise ContractError(f"input package inputs.{index} has invalid fields")
        input_id, raw_path, digest, size = item["inputId"], item["path"], item["sha256"], item["sizeBytes"]
        if not isinstance(input_id, str) or not input_id or input_id in paths:
            raise ContractError("input package inputId values must be non-empty and unique")
        if not isinstance(raw_path, str) or not raw_path:
            raise ContractError(f"input package inputs.{index}.path must be a non-empty string")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ContractError(f"input package inputs.{index}.sha256 must be a SHA-256")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ContractError(f"input package inputs.{index}.sizeBytes must be non-negative")
        source = Path(raw_path)
        if not source.is_absolute():
            source = base / source
        body = source.read_bytes()
        if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
            raise ContractError(f"input package input {input_id} failed size/digest verification")
        paths[input_id] = source
    return expected_intent_sha, paths


def _xosc_source_digest(xosc: bytes) -> str:
    try:
        root = ET.fromstring(xosc)
    except ET.ParseError as exc:
        raise ContractError("OpenSCENARIO XML is not well formed") from exc
    values = [
        item.get("value")
        for item in root.findall("./FileHeader/Properties/Property")
        if item.get("name") == "uniscenarios.provenance.inputHash"
    ]
    if len(values) != 1 or not isinstance(values[0], str) or len(values[0]) != 64:
        raise ContractError("OpenSCENARIO must carry exactly one source input digest")
    return values[0]


def _strip_control(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _strip_control(item) for key, item in value.items() if key not in {"url", "controlSha256"}}
    if isinstance(value, list):
        return [_strip_control(item) for item in value]
    return value

def _render_control_lineage_sha256(intent: Mapping[str, Any], intent_sha256: str) -> str:
    execution_package = intent["executionPackage"]
    return canonical_sha256({
        "schema": "uniscenario.render-control-lineage/v1",
        "intentSha256": intent_sha256,
        "executionPackageId": execution_package["id"],
        "sourceInputDigest": execution_package["sourceInputDigest"],
    })



def _render_spec_v3_to_native(value: Any) -> tuple[dict[str, Any], RenderSpec, str]:
    if not isinstance(value, Mapping) or set(value) not in (
        {"schema", "sources", "clip", "artifacts", "capabilityIntent", "authoredEnvironment"},
        {"schema", "sources", "clip", "video", "artifacts", "capabilityIntent", "authoredEnvironment"},
    ) or value.get("schema") != "uniscenario.render-spec/v3":
        raise ContractError("renderSpec must be a strict uniscenario.render-spec/v3")
    sources, clip, artifacts = value["sources"], value["clip"], value["artifacts"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SENSOR_COUNT:
        raise ContractError(f"renderSpec.sources must contain 1..{MAX_SENSOR_COUNT} sources")
    if not isinstance(clip, Mapping) or set(clip) != {"startSeconds", "endSeconds"}:
        raise ContractError("renderSpec.clip has invalid fields")
    start, end = clip["startSeconds"], clip["endSeconds"]
    if (
        not isinstance(start, (int, float)) or isinstance(start, bool)
        or not isinstance(end, (int, float)) or isinstance(end, bool)
        or float(start) < 0 or float(end) <= float(start)
    ):
        raise ContractError("renderSpec.clip must have endSeconds > startSeconds >= 0")
    allowed_artifacts = {"video", "manifest", "frames", "sensorArchive", "annotations", "trace", "diagnostics"}
    if (
        not isinstance(artifacts, list) or not artifacts or len(artifacts) > 8
        or artifacts != list(dict.fromkeys(artifacts))
        or any(item not in allowed_artifacts for item in artifacts)
        or "manifest" not in artifacts
    ):
        raise ContractError("renderSpec.artifacts must be unique supported values including manifest")
    video = value.get("video")
    if ("video" in artifacts) != (video is not None):
        raise ContractError("renderSpec.video must be present exactly when video is requested")
    if video is not None:
        if not isinstance(video, Mapping) or set(video) != {"width", "height", "fps", "container", "codec", "quality"}:
            raise ContractError("renderSpec.video has invalid fields")
        if video["container"] != "mp4" or video["codec"] != "h264":
            raise ContractError("CARLA presentation video supports only mp4+h264; raw sensor frames remain canonical")
        video_fps = float(video["fps"])
        if not 0 < video_fps <= 240:
            raise ContractError("renderSpec.video.fps must be in (0, 240]")
        if video["quality"] not in {"draft", "standard", "high", "lossless"}:
            raise ContractError("renderSpec.video.quality is unsupported")
    else:
        video_fps = 24.0
    capability_intent = value["capabilityIntent"]
    if not isinstance(capability_intent, Mapping) or set(capability_intent) != {"required", "preferred", "fidelity"}:
        raise ContractError("renderSpec.capabilityIntent has invalid fields")
    required, preferred = capability_intent["required"], capability_intent["preferred"]
    if (
        not isinstance(required, list) or not isinstance(preferred, list)
        or required != list(dict.fromkeys(required)) or preferred != list(dict.fromkeys(preferred))
        or set(required) & set(preferred)
        or capability_intent["fidelity"] not in {"review", "dataset"}
    ):
        raise ContractError("renderSpec.capabilityIntent is invalid")
    supported_required = {
        "actor.lifecycle", "actor.trajectory", "actor.native_controls", "actor.route",
        "actor.lane_change", "actor.speed", "vehicle.lights", "pedestrian.trajectory",
        "static.object", "traffic_signal.state", "traffic_signal.flashing",
        "traffic_signal.controller_logic", "weather", "collision.observe",
        "custom.map.opendrive", "occlusion.metric",
        "environment.authored", "timing.fixed_step",
        "artifact.video", "artifact.frames", "artifact.sensor_archive",
        "artifact.manifest", "artifact.trace", "artifact.annotations",
        *(f"sensor.{modality}" for modality in native_sensor_capabilities()),
    }
    unsupported_required = sorted(set(required) - supported_required)
    if unsupported_required:
        raise ContractError("CARLA cannot satisfy required capabilities: " + ", ".join(unsupported_required))
    environment = value["authoredEnvironment"]
    if not isinstance(environment, Mapping) or set(environment) - {
        "weather", "timeOfDay", "frictionScale", "sunAzimuthDeg", "sunElevationDeg",
        "surfacePatches", "extensions",
    }:
        raise ContractError("renderSpec.authoredEnvironment has invalid fields")
    if environment.get("surfacePatches", []) or environment.get("extensions"):
        raise ContractError("CARLA native rendering does not support authored surface patches or environment extensions")
    if "frictionScale" in environment:
        raise ContractError("CARLA native rendering does not yet own authored tyre friction")
    weather = environment.get("weather", "cloudy")
    weather_values = {
        "clear": (0.0, 0.0, 0.0, 0.0, 0.0),
        "cloudy": (60.0, 0.0, 0.0, 0.0, 0.0),
        "overcast": (90.0, 0.0, 0.0, 0.0, 0.0),
        "light_rain": (75.0, 25.0, 30.0, 30.0, 0.0),
        "heavy_rain": (95.0, 80.0, 80.0, 90.0, 0.0),
        "wet_road": (50.0, 0.0, 80.0, 80.0, 0.0),
        "fog_light": (60.0, 0.0, 10.0, 20.0, 20.0),
        "fog_dense": (90.0, 0.0, 30.0, 40.0, 80.0),
    }
    if weather not in weather_values:
        raise ContractError(f"CARLA weather preset {weather!r} is unsupported")
    time_of_day = environment.get("timeOfDay", "dusk")
    sun_by_time = {
        "dawn": 5.0, "morning": 25.0, "noon": 75.0, "afternoon": 35.0,
        "dusk": 3.0, "night": -45.0, "night_lit": -45.0,
    }
    if time_of_day not in sun_by_time:
        raise ContractError("renderSpec.authoredEnvironment.timeOfDay is unsupported")
    cloudiness, precipitation, deposits, wetness, fog_density = weather_values[weather]
    sun_azimuth = environment.get("sunAzimuthDeg", 0.0)
    sun_altitude = environment.get("sunElevationDeg", sun_by_time[time_of_day])
    if not isinstance(sun_azimuth, (int, float)) or not isinstance(sun_altitude, (int, float)):
        raise ContractError("render intent environment expressions must be resolved before CARLA execution")
    native_environment = {
        "cloudiness": cloudiness, "precipitation": precipitation, "deposits": deposits,
        "wind": 0.0, "sunAzimuth": float(sun_azimuth) % 360.0,
        "sunAltitude": float(sun_altitude), "fogDensity": fog_density,
        "fogDistance": 0.0, "wetness": wetness,
    }
    sensor_values: list[dict[str, Any]] = []
    identities: set[tuple[str, str, str]] = set()
    output_names: set[str] = set()
    camera_fps: set[float] = set()
    for index, source in enumerate(sources):
        label = f"renderSpec.sources.{index}"
        if not isinstance(source, Mapping) or set(source) != {
            "actorId", "sensorId", "outputName", "transform", "modality", "attributes",
        }:
            raise ContractError(f"{label} has invalid fields")
        actor_id, sensor_id, output_name = source["actorId"], source["sensorId"], source["outputName"]
        modality, attributes, transform = source["modality"], source["attributes"], source["transform"]
        if not all(isinstance(item, str) and item for item in (actor_id, sensor_id, output_name)):
            raise ContractError(f"{label} identity fields must be non-empty strings")
        identity = (actor_id, sensor_id, modality)
        if identity in identities or output_name in output_names:
            raise ContractError("renderSpec source identities and outputName values must be unique")
        identities.add(identity)
        output_names.add(output_name)
        if not isinstance(transform, Mapping) or set(transform) != {"position", "rotation"}:
            raise ContractError(f"{label}.transform has invalid fields")
        position, rotation = transform["position"], transform["rotation"]
        if not isinstance(position, Mapping) or set(position) != {"x", "y", "z"}:
            raise ContractError(f"{label}.transform.position has invalid fields")
        if not isinstance(rotation, Mapping) or set(rotation) != {"yawRad", "pitchRad", "rollRad"}:
            raise ContractError(f"{label}.transform.rotation has invalid fields")
        if modality in {"rgb", "depth", "semantic", "instance"}:
            expected_attributes = {"width", "height", "fps", "horizontalFovDeg", "nearM", "farM"}
            if not isinstance(attributes, Mapping) or set(attributes) != expected_attributes:
                raise ContractError(f"{label}.attributes has invalid camera fields")
            if float(attributes["farM"]) <= float(attributes["nearM"]):
                raise ContractError(f"{label}.attributes.farM must exceed nearM")
            camera_fps.add(float(attributes["fps"]))
            config = {
                "width": attributes["width"], "height": attributes["height"],
                "fov": attributes["horizontalFovDeg"],
            }
        elif modality == "lidar":
            expected_attributes = {
                "channels", "rangeM", "pointsPerSecond", "rotationFrequencyHz",
                "upperFovDeg", "lowerFovDeg",
            }
            if not isinstance(attributes, Mapping) or set(attributes) != expected_attributes:
                raise ContractError(f"{label}.attributes has invalid lidar fields")
            config = dict(attributes)
        elif modality == "radar":
            expected_attributes = {"horizontalFovDeg", "verticalFovDeg", "rangeM", "pointsPerSecond"}
            if not isinstance(attributes, Mapping) or set(attributes) != expected_attributes:
                raise ContractError(f"{label}.attributes has invalid radar fields")
            config = dict(attributes)
        else:
            raise ContractError(f"{label}.modality is unsupported by render-spec/v3")
        from math import degrees
        sensor_values.append({
            "role": output_name, "actorId": actor_id, "sensorId": sensor_id,
            "modality": modality,
            "transform": {
                "x": float(position["x"]), "y": float(position["z"]), "z": float(position["y"]),
                "yaw": degrees(float(rotation["yawRad"])),
                "pitch": degrees(float(rotation["pitchRad"])),
                "roll": degrees(float(rotation["rollRad"])),
            },
            "config": config,
        })
    outputs = [
        output for output in artifacts
        if output in {"video", "trace", "manifest", "annotations"}
    ]
    quality = "standard" if video is None else {
        "draft": "preview", "standard": "standard", "high": "high", "lossless": "cinematic",
    }[video["quality"]]
    native_value = {
        "schema": "uniscenario.render-spec/v1", "fps": video_fps,
        "sensors": sensor_values, "outputs": outputs, "executionMode": "native-physics",
        "quality": quality, "environment": native_environment,
        "formats": ["png", "ply", "csv", "mp4-h264", "json", "jsonl"],
    }
    return native_value, RenderSpec.parse(native_value), str(capability_intent["fidelity"])


def _validate_pronto_sensor_selection(
    sensors: list[Any],
    host_actor_id: str,
    *,
    representative: bool,
) -> None:
    camera_modalities = {"rgb", "depth", "semantic", "instance", "normals"}
    chase_sensors = [
        sensor for sensor in sensors
        if sensor.sensor_id == PRONTO_CHASE_CAMERA_SENSOR_ID
    ]
    rig_sensors = [
        sensor for sensor in sensors
        if sensor.sensor_id != PRONTO_CHASE_CAMERA_SENSOR_ID
    ]
    actual_rig = (
        len({sensor.sensor_id for sensor in rig_sensors if sensor.modality in camera_modalities}),
        len({
            sensor.sensor_id for sensor in rig_sensors
            if sensor.modality in {"lidar", "semantic-lidar"}
        }),
        len({sensor.sensor_id for sensor in rig_sensors if sensor.modality == "radar"}),
    )
    actor_ids = {sensor.actor_id for sensor in sensors}
    if representative:
        if actual_rig != (1, 1, 1) or actor_ids != {host_actor_id}:
            raise ContractError(
                "CARLA review mode requires exactly one camera, one LiDAR, and one radar on sensorHost.actorId"
            )
    elif simforge_env("SDG_EXPANSION") == "1":
        rgb_ids = {sensor.sensor_id for sensor in sensors if sensor.modality == "rgb"}
        derived = {
            name: tuple(name.split("__"))
            for name in (str(sensor.sensor_id) for sensor in rig_sensors)
            if "__" in name
        }
        unknown_bases = sorted({name.split("__")[0] for name in derived} - rgb_ids)
        bad_modality = sorted(
            name for name, (_, modality) in derived.items()
            if modality not in camera_modalities - {"rgb"}
        )
        if unknown_bases or bad_modality or len(rgb_ids) < 8 or actual_rig[1] < 6 or actual_rig[2] < 4:
            raise ContractError(
                "SDG expansion sensors must derive from real rgb rig cameras via id__modality"
            )
    elif actual_rig != (8, 6, 4) or actor_ids != {host_actor_id}:
        raise ContractError("all exact Pronto sensors must attach to render intent sensorHost.actorId")
    if len(chase_sensors) > 1 or any(sensor.modality != "rgb" for sensor in chase_sensors):
        raise ContractError("a render carries at most one RGB trailing chase camera")


def _validate_authored_sensor_host(
    sensors: Sequence[Any],
    host_actor_id: str,
    vehicle_asset: Mapping[str, Any],
    sensor_rig: Mapping[str, Any],
) -> None:
    if set(vehicle_asset) != {"catalogAssetId"} or not isinstance(
        vehicle_asset.get("catalogAssetId"), str
    ) or not vehicle_asset["catalogAssetId"]:
        raise ContractError("authored render intent sensorHost requires one catalogAssetId")
    camera_modalities = {"rgb", "depth", "semantic", "instance", "normals"}
    actual_rig = {
        "rigId": "authored",
        "cameras": len({
            sensor.sensor_id for sensor in sensors
            if sensor.modality in camera_modalities
            and sensor.sensor_id != PRONTO_CHASE_CAMERA_SENSOR_ID
        }),
        "lidars": len({
            sensor.sensor_id for sensor in sensors
            if sensor.modality in {"lidar", "semantic-lidar"}
        }),
        "radars": len({
            sensor.sensor_id for sensor in sensors
            if sensor.modality == "radar"
        }),
    }
    if dict(sensor_rig) != actual_rig or {
        sensor.actor_id for sensor in sensors
    } != {host_actor_id}:
        raise ContractError(
            "authored sensorHost counts and actor must match the immutable render sources"
        )


def _intent_lease(
    intent: Mapping[str, Any],
    intent_sha: str,
    inputs: Mapping[str, Path],
    output_dir: Path,
) -> tuple[Any, dict[str, Path]]:
    expected_fields = {"schema", "intentId", "executionPackage", "scenarioRevision", "renderSpec", "sensorHost", "assets", "seed"}
    if set(intent) != expected_fields or intent.get("schema") != INTENT_SCHEMA:
        raise ContractError(f"render intent must use strict {INTENT_SCHEMA} fields")
    intent_id = intent.get("intentId")
    revision = intent.get("scenarioRevision")
    assets = intent.get("assets")
    seed = intent.get("seed")
    if not isinstance(intent_id, str) or not intent_id or not isinstance(seed, int) or isinstance(seed, bool):
        raise ContractError("render intent identity/seed is invalid")
    if not isinstance(revision, Mapping) or set(revision) != {"revisionId", "scenarioSha256", "openScenario", "map"}:
        raise ContractError("render intent scenarioRevision has invalid fields")
    if not isinstance(assets, list):
        raise ContractError("render intent assets must be an array")
    native_render_spec, parsed_spec, fidelity = _render_spec_v3_to_native(intent.get("renderSpec"))
    sensor_host = intent.get("sensorHost")
    if not isinstance(sensor_host, Mapping) or set(sensor_host) != {
        "actorId", "vehicleAsset", "sensorRig",
    }:
        raise ContractError("render intent sensorHost has invalid fields")
    host_actor_id = sensor_host.get("actorId")
    vehicle_asset = sensor_host.get("vehicleAsset")
    sensor_rig = sensor_host.get("sensorRig")
    if not isinstance(host_actor_id, str) or not host_actor_id:
        raise ContractError("render intent sensorHost.actorId must be non-empty")
    if not isinstance(vehicle_asset, Mapping) or not isinstance(sensor_rig, Mapping):
        raise ContractError("render intent sensorHost asset or rig is invalid")
    if sensor_rig.get("rigId") == "authored":
        _validate_authored_sensor_host(
            parsed_spec.sensors,
            host_actor_id,
            vehicle_asset,
            sensor_rig,
        )
    else:
        source_image = vehicle_asset.get("sourceImage")
        if {
            key: value for key, value in vehicle_asset.items() if key != "sourceImage"
        } != {
            "catalogAssetId": KIA_CARNIVAL_CATALOG_ID,
            "carlaBlueprintId": KIA_CARNIVAL_BLUEPRINT_ID,
            "carlaClassPath": KIA_CARNIVAL_CLASS_PATH,
            "make": KIA_CARNIVAL_MAKE,
            "model": KIA_CARNIVAL_MODEL,
            "baseType": KIA_CARNIVAL_BASE_TYPE,
        }:
            raise ContractError("render intent sensorHost.vehicleAsset must be the exact Kia Carnival identity")
        if source_image != {
            "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
            "indexSha256": CARLA_IMAGE_INDEX_DIGEST.removeprefix("sha256:"),
            "linuxAmd64ManifestSha256": CARLA_IMAGE_AMD64_MANIFEST_DIGEST.removeprefix("sha256:"),
        }:
            raise ContractError("render intent sensorHost.vehicleAsset.sourceImage must identify the pinned Kia image")
        if sensor_rig != {
            "rigId": "pronto.8-camera-6-lidar-4-radar",
            "cameras": 8,
            "lidars": 6,
            "radars": 4,
        }:
            raise ContractError("render intent sensorHost.sensorRig must identify the exact Pronto 8/6/4 rig")
        _validate_pronto_sensor_selection(
            parsed_spec.sensors,
            host_actor_id,
            representative=simforge_env("RENDER_SMOKE") == "1",
        )
    xosc_path = inputs.get("scenario.xosc")
    if xosc_path is None:
        raise ContractError("input package is missing scenario.xosc")
    xosc = xosc_path.read_bytes()
    open_scenario = revision.get("openScenario")
    if not isinstance(open_scenario, Mapping) or open_scenario != {
        "sha256": hashlib.sha256(xosc).hexdigest(), "sizeBytes": len(xosc),
    }:
        raise ContractError("scenario.xosc does not match render intent OpenSCENARIO identity")
    source_digest = _xosc_source_digest(xosc)
    execution_package = intent.get("executionPackage")
    if (
        not isinstance(execution_package, Mapping)
        or set(execution_package) != {"id", "sourceInputDigest"}
        or not isinstance(execution_package.get("id"), str)
        or not execution_package["id"]
        or execution_package.get("sourceInputDigest") != source_digest
    ):
        raise ContractError("render intent executionPackage identity is invalid")
    map_identity = revision.get("map")
    if not isinstance(map_identity, Mapping) or set(map_identity) != {"mapId", "revisionId", "sha256"}:
        raise ContractError("render intent map identity is invalid")
    asset_by_kind: dict[str, Mapping[str, Any]] = {}
    asset_ids: set[str] = set()
    for index, asset in enumerate(assets):
        if not isinstance(asset, Mapping) or set(asset) != {"assetId", "kind", "sha256", "sizeBytes"}:
            raise ContractError(f"render intent assets.{index} has invalid fields")
        asset_id = asset.get("assetId")
        if (
            not isinstance(asset_id, str) or not asset_id or asset_id in asset_ids
            or asset.get("kind") not in {"map", "catalog", "texture", "mesh", "other"}
        ):
            raise ContractError(f"render intent assets.{index} identity/kind is invalid")
        asset_ids.add(asset_id)
        path = inputs.get(asset_id)
        if path is None:
            raise ContractError(f"input package is missing render intent asset {asset_id}")
        body = path.read_bytes()
        if asset.get("sha256") != hashlib.sha256(body).hexdigest() or asset.get("sizeBytes") != len(body):
            raise ContractError(f"render intent asset {asset_id} differs from the input package")
        if asset.get("kind") in {"map", "catalog"}:
            if asset["kind"] in asset_by_kind:
                raise ContractError(f"render intent has duplicate {asset['kind']} assets")
            asset_by_kind[str(asset["kind"])] = asset
    if set(inputs) != {"scenario.xosc", *asset_ids}:
        raise ContractError("input package inputs must exactly close scenario.xosc and render intent assets")
    if set(asset_by_kind) != {"map", "catalog"}:
        raise ContractError("CARLA render intent requires exactly one map and one catalog asset")
    map_asset, catalog_asset = asset_by_kind["map"], asset_by_kind["catalog"]
    if map_asset.get("sha256") != map_identity.get("sha256"):
        raise ContractError("render intent map asset differs from scenarioRevision.map")
    xodr_path = inputs.get(str(map_asset.get("assetId")))
    catalog_path = inputs.get(str(catalog_asset.get("assetId")))
    if xodr_path is None or catalog_path is None:
        raise ContractError("input package is missing the intent map or catalog asset")
    catalog_body = catalog_path.read_bytes()
    try:
        catalog_json = json.loads(catalog_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("catalog input must be UTF-8 JSON") from exc
    if not isinstance(catalog_json, Mapping) or catalog_json.get("contractVersion") != ASSET_CATALOG_SCHEMA:
        raise ContractError("catalog input is not a supported asset catalog")
    catalog_version = catalog_json.get("catalogVersionId")
    if not isinstance(catalog_version, str) or not catalog_version:
        raise ContractError("catalog input has no catalogVersionId")
    plan = compile_xosc14(xosc)
    duration = plan.frames[-1].t
    requested_clip = intent["renderSpec"]["clip"]
    if float(requested_clip["startSeconds"]) != 0.0 or abs(float(requested_clip["endSeconds"]) - duration) > 1e-9:
        raise ContractError("CARLA run-intent currently requires the full authored clip")
    capture_count = round(duration * parsed_spec.fps)
    raster = [sensor for sensor in parsed_spec.sensors if sensor.modality in {"rgb", "depth", "semantic", "instance", "normals"}]
    raster_samples = sum(int(sensor.config["width"]) * int(sensor.config["height"]) for sensor in raster)
    point_samples = sum(
        int(sensor.config["pointsPerSecond"] / parsed_spec.fps)
        for sensor in parsed_spec.sensors if "pointsPerSecond" in sensor.config
    )
    samples_per_frame = raster_samples + point_samples
    sensor_samples = samples_per_frame * capture_count
    traffic_candidates: list[tuple[Path, Mapping[str, Any]]] = []
    for asset in assets:
        if asset["kind"] != "other":
            continue
        candidate_path = inputs[asset["assetId"]]
        try:
            candidate = json.loads(candidate_path.read_text("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(candidate, Mapping) and candidate.get("schema") == "uniscenarios.materialized-traffic.v1":
            traffic_candidates.append((candidate_path, candidate))
    if len(traffic_candidates) > 1:
        raise ContractError("render intent contains multiple materialized traffic assets")
    if traffic_candidates:
        traffic_path, traffic_value = traffic_candidates[0]
        traffic = traffic_path.read_bytes()
        provider = traffic_value.get("provider")
        if not isinstance(provider, Mapping) or provider.get("id") != "native":
            raise ContractError("run-intent materialized traffic currently requires provider.id native")
        ambient_mode = "native"
        provider_version = provider.get("version")
        provider_seed = provider.get("seed")
        if not isinstance(provider_version, str) or not provider_version or not isinstance(provider_seed, str):
            raise ContractError("materialized traffic native provider identity is invalid")
        ambient_extra = {"runtimeVersion": provider_version, "seed": provider_seed}
        overlap_actor_ids = sorted(
            {
                actor.get("id")
                for actor in traffic_value.get("actors", [])
                if isinstance(actor, Mapping) and actor.get("id") in plan.actors
            }
        )
        traffic_artifact_id = next(
            asset["assetId"] for asset in assets
            if inputs[asset["assetId"]] == traffic_path
        )
    else:
        traffic = canonical_json({
            "schema": "uniscenarios.materialized-traffic.v1",
            "sourceInputDigest": source_digest,
            "map": {"assetId": map_identity["mapId"], "versionId": map_identity["revisionId"]},
            "provider": {"id": "disabled", "version": "none", "seed": ""},
            "fixedStepSeconds": 0.02,
            "durationSeconds": duration,
            "actors": [],
            "signals": [],
        }).encode("utf-8")
        output_dir.mkdir(parents=True, exist_ok=True)
        traffic_path = output_dir / ".disabled-materialized-traffic.json"
        traffic_path.write_bytes(traffic)
        ambient_mode = "disabled"
        ambient_extra = {}
        overlap_actor_ids = []
        traffic_artifact_id = "local-disabled-traffic"
    traffic_sha = hashlib.sha256(traffic).hexdigest()
    ambient = {
        "ambientMode": ambient_mode, "ambientConfig": {},
        "configSha256": EMPTY_AMBIENT_CONFIG_SHA256,
        "resultSha256": traffic_sha,
        "materializedTraffic": {"url": "local:traffic", "sha256": traffic_sha, "sizeBytes": len(traffic)},
        **ambient_extra,
    }
    manifest_traffic_identity = {
        "artifactId": traffic_artifact_id, "sha256": traffic_sha,
        "sizeBytes": len(traffic), "sourceInputDigest": source_digest,
        "mapAssetId": map_identity["mapId"], "mapVersionId": map_identity["revisionId"],
    }
    execution_manifest = {
        "contract": "uniscenario.execution-package/v1",
        "openScenarioProfile": "ASAM OpenSCENARIO XML 1.4",
        "xsdSha256": OFFICIAL_XSD_SHA256,
        "revision": {"id": revision["revisionId"], "sha256": revision["scenarioSha256"]},
        "sourceInputDigest": source_digest,
        "materializedTrafficDigest": traffic_sha,
        "map": {"assetId": map_identity["mapId"], "versionId": map_identity["revisionId"], "xodrSha256": map_identity["sha256"]},
        "assetCatalog": {"versionId": catalog_version, "manifestSha256": catalog_asset["sha256"]},
        "ambient": {
            "mode": ambient_mode, "ambientConfig": {},
            "configSha256": EMPTY_AMBIENT_CONFIG_SHA256, "resultSha256": traffic_sha,
            "materializedTraffic": manifest_traffic_identity,
            **ambient_extra,
        },
        "materializedTraffic": {
            "artifactId": traffic_artifact_id, "sha256": traffic_sha,
            "sizeBytes": len(traffic), "overlapActorIds": overlap_actor_ids,
        },
        "files": [{"kind": "xosc", "mediaType": "application/xml", "sha256": open_scenario["sha256"], "sizeBytes": open_scenario["sizeBytes"]}],
    }
    manifest_body = json.dumps(execution_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    manifest_path = output_dir / ".execution-manifest.json"
    manifest_path.write_bytes(manifest_body)
    uploads: dict[str, dict[str, Any]] = {}
    kinds = {"trace", "parity-report", *parsed_spec.outputs}
    if "video" in parsed_spec.outputs:
        primary_rgb = next(
            (sensor for sensor in parsed_spec.sensors if sensor.modality == "rgb"), None,
        )
        kinds.update(
            f"sensorVideo:{sensor.artifact_name}"
            for sensor in parsed_spec.sensors
            if sensor is not primary_rgb
        )
    kinds.update(
        f"sensorData:{sensor.artifact_name}"
        for sensor in parsed_spec.sensors
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}
    )
    for index, kind in enumerate(sorted(kinds)):
        safe_kind = "".join(
            character if character.isalnum() or character in ".-_" else "_"
            for character in kind
        )
        uploads[kind] = {
            "uploadId": f"local-{index}", "uploadUrl": f"memory:{index}",
            "artifactUrl": f"{safe_kind}.artifact", "headers": {},
        }
    runtime_requirements = {
        "schema": "uniscenario.runtime-requirements/v1", "xoscVersion": "1.4",
        "capabilityProfile": "xml-1.4-trajectory-replay", "fixedTimestepS": 0.02,
        "jobMode": "full_render", "trafficMode": ambient_mode,
        "executionMode": parsed_spec.execution_mode,
        "sensorModalities": sorted({sensor.modality for sensor in parsed_spec.sensors}),
        "outputs": sorted(parsed_spec.outputs),
        "resources": {
            "schema": "uniscenario.render-resource-request/v1", "durationS": duration,
            "sensors": len(parsed_spec.sensors), "captureFrames": capture_count,
            "actors": max(1, len(plan.actors)), "actorFrameStates": max(1, len(plan.actors) * len(plan.frames)),
            "sensorSamples": sensor_samples, "outputBytes": 8 * 1024 * 1024 * 1024,
            "maxFrameWidth": max((int(sensor.config["width"]) for sensor in raster), default=0),
            "maxFrameHeight": max((int(sensor.config["height"]) for sensor in raster), default=0),
            "samplesPerFrame": samples_per_frame,
        },
    }
    package = {
        "schema": "uniscenario.execution-package/v1", "id": execution_package["id"],
        "revisionId": revision["revisionId"], "sourceInputDigest": execution_package["sourceInputDigest"],
        "materializedTrafficDigest": traffic_sha, "mapAssetId": map_identity["mapId"],
        "mapVersionId": map_identity["revisionId"],
        "manifest": {"url": "local:manifest", "sha256": hashlib.sha256(manifest_body).hexdigest(), "sizeBytes": len(manifest_body)},
        "xosc": {"url": "local:xosc", "sha256": open_scenario["sha256"], "sizeBytes": open_scenario["sizeBytes"], "xsdSha256": OFFICIAL_XSD_SHA256},
        # A map whose XODR is cooked into the engine image must be requested by
        # its cooked runtime world name so CARLA loads the real meshes and the
        # approved signal identity remaps engage; uncooked maps keep their
        # control-plane identity and render via the generated-OpenDRIVE world.
        "xodr": {"url": "local:xodr", "sha256": map_asset["sha256"], "sizeBytes": map_asset["sizeBytes"], "mapName": cooked_map_name_for_xodr(str(map_asset["sha256"])) or map_identity["mapId"]},
        "assetCatalog": {"url": "local:catalog", "sha256": catalog_asset["sha256"], "sizeBytes": catalog_asset["sizeBytes"], "contractVersion": ASSET_CATALOG_SCHEMA, "catalogVersionId": catalog_version},
        "ambient": ambient, "runtimeRequirements": runtime_requirements,
    }
    package["controlSha256"] = canonical_sha256(_control_value(package))
    lease_value = {
        "leaseToken": "local-render-intent-" + intent_sha,
        "leaseExpiresAt": "9999-12-31T23:59:59Z",
        "job": {
            "id": intent_id, "attempt": 1, "executionPackage": package,
            "mode": "full_render", "renderSpec": native_render_spec,
            "parityThresholds": {"positionM": 0.01, "headingDeg": 0.01, "speedMps": 0.01},
            "artifactUploads": uploads,
        },
    }
    lease = parse_lease(lease_value)
    # The local package digest authenticates the derived runtime package during parsing. Artifacts
    # must carry the control-plane lineage digest that identifies the immutable claimed attempt.
    lease = replace(
        lease,
        execution_package=replace(
            lease.execution_package,
            control_sha256=_render_control_lineage_sha256(intent, intent_sha),
        ),
    )
    return lease, {
        "local:manifest": manifest_path, "local:xosc": xosc_path,
        "local:xodr": xodr_path, "local:catalog": catalog_path, "local:traffic": traffic_path,
    }


def _artifact_manifest_entries(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise RuntimeError("native executor returned invalid artifacts")
    entries: list[dict[str, Any]] = []
    identities: set[tuple[str, str | None, str | None, str | None]] = set()
    for item in items:
        if not isinstance(item, Mapping):
            raise RuntimeError("native executor returned an invalid artifact")
        kind = item.get("kind")
        metadata = item.get("metadata")
        metadata = metadata if isinstance(metadata, Mapping) else {}
        if isinstance(kind, str) and kind.startswith("sensorVideo:"):
            role = "video"
        elif isinstance(kind, str) and kind.startswith("sensorData:"):
            role = "sensorArchive"
        elif kind == "parity-report":
            role = "diagnostics"
        elif kind in {"video", "manifest", "trace", "annotations"}:
            role = kind
        else:
            raise RuntimeError(f"native executor returned unsupported artifact kind {kind!r}")
        if role in {"video", "sensorArchive"}:
            actor_id = metadata.get("actorId")
            sensor_id = metadata.get("sensorId")
            modality = metadata.get("modality")
            if not all(isinstance(value, str) and value for value in (actor_id, sensor_id, modality)):
                raise RuntimeError(f"native artifact {kind} has no sensor identity")
        else:
            actor_id = sensor_id = modality = None
        identity = (role, actor_id, sensor_id, modality)
        if identity in identities:
            raise RuntimeError(f"native artifact identity is duplicated: {identity}")
        identities.add(identity)
        entries.append({
            "identity": {
                "role": role,
                "actorId": actor_id,
                "sensorId": sensor_id,
                "modality": modality,
            },
            "relativePath": item["artifactUrl"],
            "sha256": item["sha256"],
            "sizeBytes": item["sizeBytes"],
            "mediaType": item["mediaType"],
            "frameCount": metadata.get("frameCount") if isinstance(metadata.get("frameCount"), int) else None,
        })
    return entries



class PreflightError(RuntimeError):
    """A phase-specific render preflight failure."""

    def __init__(self, layer: str, cause: Exception) -> None:
        super().__init__(f"{layer}: {cause}")
        self.layer = layer
        self.cause = cause


def _preflight_intent(args: argparse.Namespace) -> dict[str, object]:
    checks: list[dict[str, object]] = []

    def check(layer: str, operation: Callable[[], object]) -> object:
        started = monotonic()
        try:
            detail = operation()
        except Exception as exc:
            raise PreflightError(layer, exc) from exc
        checks.append({
            "layer": layer,
            "status": "pass",
            "durationMs": round((monotonic() - started) * 1000),
            **({"detail": detail} if detail is not None else {}),
        })
        return detail

    intent_path, package_path = Path(args.intent), Path(args.package)
    intent = check("intent.schema", lambda: json.loads(intent_path.read_text("utf-8")))
    if not isinstance(intent, Mapping):
        raise PreflightError("intent.schema", ContractError("render intent must be an object"))
    parsed_spec = check(
        "intent.capabilities",
        lambda: RenderSpec.parse(intent.get("renderSpec")),
    )
    assert isinstance(parsed_spec, RenderSpec)
    with tempfile.TemporaryDirectory(prefix="scenario-preflight-") as temporary:
        temporary_path = Path(temporary)

        def build_lease() -> tuple[Any, Mapping[str, Path]]:
            intent_sha, inputs = _read_input_package(package_path, intent)
            return _intent_lease(intent, intent_sha, inputs, temporary_path)

        lease, asset_paths = check("intent.lease-eligibility", build_lease)
        backend: CarlaBackend | None = None
        try:
            def connect() -> dict[str, str]:
                nonlocal backend
                backend = CarlaBackend(args.host, args.port)
                backend.set_rpc_timeout(args.rpc_timeout)
                backend.client.get_world()
                return {
                    "clientVersion": str(getattr(backend.carla, "__version__", "unknown")),
                    "serverVersion": str(backend.client.get_server_version()),
                }

            rpc = check("carla.rpc", connect)
            assert backend is not None
            package = lease.job.execution_package
            xodr = asset_paths[package.xodr.url].read_bytes()

            def load_map() -> Mapping[str, object]:
                assert backend is not None
                backend.set_map_load_timeout(args.map_timeout)
                backend.load_opendrive(package.xodr.map_name, xodr, package.runtime_requirements.fixed_timestep_s)
                return dict(backend.map_evidence)

            map_evidence = check("carla.map", load_map)

            def find_blueprint() -> Mapping[str, str]:
                assert backend is not None and backend.world is not None
                blueprint = backend.world.get_blueprint_library().find(KIA_CARNIVAL_BLUEPRINT_ID)
                if blueprint is None or str(getattr(blueprint, "id", "")) != KIA_CARNIVAL_BLUEPRINT_ID:
                    raise RuntimeError(f"required blueprint {KIA_CARNIVAL_BLUEPRINT_ID} is unavailable")
                return {"blueprintId": KIA_CARNIVAL_BLUEPRINT_ID}

            blueprint = check("carla.vehicle-blueprint", find_blueprint)
        finally:
            if backend is not None:
                backend.cleanup()

    return {
        "schema": "uniscenario.render-preflight/v1",
        "status": "pass",
        "intentId": intent["intentId"],
        "checks": checks,
        "requested": {
            "sensors": len(parsed_spec.sensors),
            "modalities": sorted({sensor.modality for sensor in parsed_spec.sensors}),
            "outputs": sorted(parsed_spec.outputs),
        },
        "runtime": {
            **rpc,
            "map": map_evidence,
            "vehicle": blueprint,
            "imageDigest": CARLA_IMAGE_AMD64_MANIFEST_DIGEST,
        },
    }


def _run_intent(args: argparse.Namespace) -> dict[str, object]:
    intent_path, package_path = Path(args.intent), Path(args.package)
    intent = json.loads(intent_path.read_text("utf-8"))
    if not isinstance(intent, Mapping):
        raise ContractError("render intent must be an object")
    intent_sha, inputs = _read_input_package(package_path, intent)
    output_dir = Path(args.output)
    lease, asset_paths = _intent_lease(intent, intent_sha, inputs, output_dir)
    progress_path = Path(args.progress)
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    sequence = 0

    def emit(event: str, payload: Mapping[str, object]) -> None:
        nonlocal sequence
        if event not in {"job.started", "progress"}:
            return
        if event == "progress":
            record = {
                "schema": "uniscenario.render-progress/v1", "jobId": intent["intentId"],
                "attempt": 1, "sequence": sequence, "timestamp": datetime.now(timezone.utc).isoformat(),
                "event": "stage.progress", "stage": "rendering",
                "completed": payload["completedFrames"], "total": payload["totalFrames"], "unit": "frames",
            }
        else:
            record = {
                "schema": "uniscenario.render-progress/v1", "jobId": intent["intentId"],
                "attempt": 1, "sequence": sequence, "timestamp": datetime.now(timezone.utc).isoformat(),
                "event": event,
            }
        with progress_path.open("a", encoding="utf-8", newline="\n") as target:
            target.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
        sequence += 1

    progress_path.write_text("", "utf-8")
    emit("job.started", {})
    started_at = datetime.now(timezone.utc).isoformat()
    result = _execute_local_lease(
        lease, asset_paths, output_dir, DEFAULT_XSD, args.host, args.port, progress=emit,
    )
    manifest_entries = _artifact_manifest_entries(result["artifacts"])
    artifact_manifest = {
        "schema": "uniscenario.render-artifact-manifest/v1",
        "intentSha256": intent_sha,
        "engine": {
            "engineId": "uniscenarios-carla",
            "engineVersion": "native-v1",
            "backend": "carla",
        },
        "startedAt": started_at,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "artifacts": manifest_entries,
        "warnings": [],
    }
    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(artifact_manifest, sort_keys=True, separators=(",", ":")) + "\n", "utf-8")
    for internal in (output_dir / ".disabled-materialized-traffic.json", output_dir / ".execution-manifest.json"):
        internal.unlink(missing_ok=True)
    return artifact_manifest


def main() -> None:
    parser = argparse.ArgumentParser(prog="simforge-carla-api")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2000)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe", help="connect without loading or mutating a CARLA world")
    ticks = commands.add_parser(
        "probe-ticks",
        help="verify the server honors the synchronous tick barrier with a populated world",
    )
    ticks.add_argument("--fixed-delta", type=float, default=0.02)
    ticks.add_argument("--ticks", type=int, default=120)
    intent = commands.add_parser("run-intent", help="execute a local uniscenario.render-intent/v1")
    intent.add_argument("--intent", required=True)
    intent.add_argument("--package", required=True)
    intent.add_argument("--output", required=True)
    intent.add_argument("--progress", required=True)
    intent.add_argument("--manifest", required=True)
    preflight = commands.add_parser(
        "preflight-intent",
        help="validate a render intent, CARLA runtime, exact map, and vehicle without rendering",
    )
    preflight.add_argument("--intent", required=True)
    preflight.add_argument("--package", required=True)
    preflight.add_argument("--rpc-timeout", type=float, default=5.0)
    preflight.add_argument("--map-timeout", type=float, default=25.0)
    local = commands.add_parser("run-local", help="render an OpenSCENARIO offline from files")
    local.add_argument("--scenario", required=True)
    local.add_argument("--xodr", required=True)
    local.add_argument("--catalog", required=True)
    local.add_argument("--output", required=True)
    local.add_argument("--map-label", default="local-map")
    local.add_argument("--map-revision", default="local")
    local.add_argument("--start-seconds", type=float, default=0.0)
    local.add_argument("--end-seconds", type=float, default=20.0)
    local.add_argument("--seed", type=int, default=None)
    local.add_argument("--sdg", dest="sdg_modalities", default=None,
                       help="extra camera modalities per Pronto camera (comma-separated: depth,semantic,instance,normals) or a profile preset: playback,training_basic,training_multimodal,raw_multisensor,tao_detection,sdg")
    local.add_argument("--annotations", action="store_true",
                       help="emit per-frame actor ground truth as an ndjson annotations artifact")
    args = parser.parse_args()
    if args.command == "run-local":
        from .run_local import run_local_command
        result = run_local_command(args)
    elif args.command == "probe":
        result = _probe(args.host, args.port)
    elif args.command == "preflight-intent":
        try:
            result = _preflight_intent(args)
        except PreflightError as exc:
            print(json.dumps({
                "schema": "uniscenario.render-preflight/v1",
                "status": "fail",
                "blockingLayer": exc.layer,
                "error": str(exc.cause),
            }, sort_keys=True))
            raise SystemExit(2) from exc
    elif args.command == "probe-ticks":
        result = _probe_tick_barrier(args.host, args.port, args.fixed_delta, args.ticks)
    else:
        result = _run_intent(args)
    print(json.dumps(result, sort_keys=True))
    if args.command == "probe-ticks" and result.get("verdict") != "pass":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
