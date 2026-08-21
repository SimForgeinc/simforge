"""Local process entry point for the UniScenarios-owned CARLA renderer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import xml.etree.ElementTree as ET
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
    CarlaBackend,
)
from .runtime.compiler import compile_xosc14
from .runtime.contract import (
    ASSET_CATALOG_SCHEMA,
    EMPTY_AMBIENT_CONFIG_SHA256,
    MAX_SENSOR_COUNT,
    MAX_OUTPUT_BYTES,
    OFFICIAL_XSD_SHA256,
    ContractError,
    RenderSpec,
    canonical_json,
    canonical_sha256,
    parse_lease,
)
from .runtime.executor import execute_lease, filesystem_validator

DEFAULT_XSD = Path(__file__).parent / "assets" / "OpenSCENARIO.xsd"
INTENT_SCHEMA = "uniscenario.render-intent/v1"
INPUT_PACKAGE_SCHEMA_FIELDS = {"intentSha256", "inputs"}

def _runtime_map_name(map_id: str) -> str:
    raw = os.environ.get("UNISCENARIO_CARLA_COOKED_MAPS_JSON")
    if raw is None:
        return map_id
    try:
        configured = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ContractError("UNISCENARIO_CARLA_COOKED_MAPS_JSON must be valid JSON") from exc
    if (
        not isinstance(configured, Mapping)
        or any(
            not isinstance(key, str)
            or not key
            or not isinstance(value, str)
            or not value
            for key, value in configured.items()
        )
    ):
        raise ContractError("UNISCENARIO_CARLA_COOKED_MAPS_JSON must map non-empty strings")
    cooked = configured.get(map_id)
    if cooked is None:
        raise ContractError(f"no approved cooked CARLA map is configured for {map_id}")
    return cooked



def _probe(host: str, port: int) -> dict[str, object]:
    backend = CarlaBackend(host, port)
    try:
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


def _render_spec_v3_to_native(value: Any) -> tuple[dict[str, Any], RenderSpec]:
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
        output for output in artifacts if output not in {"sensorArchive", "diagnostics"}
    ]
    if "sensorArchive" in artifacts and "frames" not in outputs:
        outputs.append("frames")
    quality = "standard" if video is None else {
        "draft": "preview", "standard": "standard", "high": "high", "lossless": "cinematic",
    }[video["quality"]]
    native_value = {
        "schema": "uniscenario.render-spec/v1", "fps": video_fps,
        "sensors": sensor_values, "outputs": outputs, "executionMode": "native-physics",
        "quality": quality, "environment": native_environment,
        "formats": ["png", "ply", "csv", "mp4-h264", "json", "jsonl"],
    }
    return native_value, RenderSpec.parse(native_value)


def _intent_lease(
    intent: Mapping[str, Any],
    intent_sha: str,
    inputs: Mapping[str, Path],
    output_dir: Path,
) -> tuple[Any, dict[str, Path]]:
    expected_fields = {"schema", "intentId", "scenarioRevision", "renderSpec", "sensorHost", "assets", "seed"}
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
    native_render_spec, parsed_spec = _render_spec_v3_to_native(intent.get("renderSpec"))
    sensor_host = intent.get("sensorHost")
    if not isinstance(sensor_host, Mapping) or set(sensor_host) != {
        "actorId", "vehicleAsset", "sensorRig",
    }:
        raise ContractError("render intent sensorHost has invalid fields")
    host_actor_id = sensor_host.get("actorId")
    vehicle_asset = sensor_host.get("vehicleAsset")
    source_image = vehicle_asset.get("sourceImage") if isinstance(vehicle_asset, Mapping) else None
    sensor_rig = sensor_host.get("sensorRig")
    if not isinstance(host_actor_id, str) or not host_actor_id:
        raise ContractError("render intent sensorHost.actorId must be non-empty")
    if not isinstance(vehicle_asset, Mapping) or {
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
        raise ContractError("render intent sensorHost.sourceImage must identify the pinned Kia image")
    if sensor_rig != {
        "rigId": "pronto.8-camera-6-lidar-4-radar",
        "cameras": 8,
        "lidars": 6,
        "radars": 4,
    }:
        raise ContractError("render intent sensorHost.sensorRig must identify the exact Pronto 8/6/4 rig")
    camera_modalities = {"rgb", "depth", "semantic", "instance", "normals"}
    actual_rig = (
        sum(sensor.modality in camera_modalities for sensor in parsed_spec.sensors),
        sum(sensor.modality in {"lidar", "semantic-lidar"} for sensor in parsed_spec.sensors),
        sum(sensor.modality == "radar" for sensor in parsed_spec.sensors),
    )
    if (
        len(parsed_spec.sensors) != 18
        or actual_rig != (8, 6, 4)
        or {sensor.actor_id for sensor in parsed_spec.sensors} != {host_actor_id}
    ):
        raise ContractError("all exact Pronto sensors must attach to render intent sensorHost.actorId")
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
    kinds = {"trace", *(output for output in parsed_spec.outputs if output != "frames")}
    if "diagnostics" in intent["renderSpec"]["artifacts"]:
        kinds.add("parity-report")
    if "frames" in parsed_spec.outputs:
        kinds.update(f"framesArchive:{sensor.artifact_name}" for sensor in parsed_spec.sensors)
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
            "sensorSamples": sensor_samples, "outputBytes": MAX_OUTPUT_BYTES,
            "maxFrameWidth": max((int(sensor.config["width"]) for sensor in raster), default=0),
            "maxFrameHeight": max((int(sensor.config["height"]) for sensor in raster), default=0),
            "samplesPerFrame": samples_per_frame,
        },
    }
    package = {
        "schema": "uniscenario.execution-package/v1", "id": intent_id,
        "revisionId": revision["revisionId"], "sourceInputDigest": source_digest,
        "materializedTrafficDigest": traffic_sha, "mapAssetId": map_identity["mapId"],
        "mapVersionId": map_identity["revisionId"],
        "manifest": {"url": "local:manifest", "sha256": hashlib.sha256(manifest_body).hexdigest(), "sizeBytes": len(manifest_body)},
        "xosc": {"url": "local:xosc", "sha256": open_scenario["sha256"], "sizeBytes": open_scenario["sizeBytes"], "xsdSha256": OFFICIAL_XSD_SHA256},
        "xodr": {"url": "local:xodr", "sha256": map_asset["sha256"], "sizeBytes": map_asset["sizeBytes"], "mapName": _runtime_map_name(str(map_identity["mapId"]))},
        "assetCatalog": {"url": "local:catalog", "sha256": catalog_asset["sha256"], "sizeBytes": catalog_asset["sizeBytes"], "contractVersion": ASSET_CATALOG_SCHEMA, "catalogVersionId": catalog_version},
        "ambient": ambient, "runtimeRequirements": runtime_requirements,
    }
    package["controlSha256"] = canonical_sha256(_strip_control(package))
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
        if isinstance(kind, str) and kind.startswith("framesArchive:"):
            role = "sensorArchive"
        elif kind == "parity-report":
            role = "diagnostics"
        elif kind in {"video", "frames", "manifest", "trace", "annotations"}:
            role = kind
        else:
            raise RuntimeError(f"native executor returned unsupported artifact kind {kind!r}")
        if role in {"video", "frames", "sensorArchive"}:
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
            "role": role,
            "actorId": actor_id,
            "sensorId": sensor_id,
            "modality": modality,
            "artifactUrl": item["artifactUrl"],
            "sha256": item["sha256"],
            "sizeBytes": item["sizeBytes"],
            "mediaType": item["mediaType"],
            **({"metadata": dict(metadata)} if metadata else {}),
        })
    return entries



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
    # The outer render worker owns the public progress contract and already
    # reports job/stage/artifact events. Keep the engine file empty instead of
    # writing its legacy intent-scoped event vocabulary into that job-scoped
    # stream.
    progress_path.write_text("", "utf-8")
    result = _execute_local_lease(
        lease, asset_paths, output_dir, DEFAULT_XSD, args.host, args.port,
    )
    manifest_entries = _artifact_manifest_entries(result["artifacts"])
    runtime_evidence = result["attestation"]["runtimeEvidence"]
    artifact_manifest = {
        "schema": "uniscenario.render-artifact-manifest/v1",
        "intentId": intent["intentId"], "intentSha256": intent_sha, "engine": "carla",
        "artifacts": manifest_entries, "attestation": result["attestation"],
        "carlaEvidence": {
            "sensorHost": dict(intent["sensorHost"]),
            "sensorHostReadback": runtime_evidence["prontoSensorHost"],
            "runtimeImage": runtime_evidence["runtimeImage"],
        },
        "parityEvidence": result["parityEvidence"], "planSha256": result["planSha256"],
    }
    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(artifact_manifest, sort_keys=True, separators=(",", ":")) + "\n", "utf-8")
    for internal in (output_dir / ".disabled-materialized-traffic.json", output_dir / ".execution-manifest.json"):
        internal.unlink(missing_ok=True)
    return artifact_manifest


def main() -> None:
    parser = argparse.ArgumentParser(prog="uniscenarios-carla")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2000)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe", help="connect without loading or mutating a CARLA world")
    intent = commands.add_parser("run-intent", help="execute a local uniscenario.render-intent/v1")
    intent.add_argument("--intent", required=True)
    intent.add_argument("--package", required=True)
    intent.add_argument("--output", required=True)
    intent.add_argument("--progress", required=True)
    intent.add_argument("--manifest", required=True)
    args = parser.parse_args()
    result = _probe(args.host, args.port) if args.command == "probe" else _run_intent(args)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
