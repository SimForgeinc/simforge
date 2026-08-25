"""Assemble a render intent from plain files and render it without any control plane.

`run-local` is the offline front door: an OpenSCENARIO file, a map bundle (XODR plus
vehicle catalog), and a bundled sensor rig are everything the executor needs. The
intent/package documents are built here in memory, written beside the outputs for
transparency, and handed to the same `_run_intent` path the cloud worker uses — one
render core, two front doors.

Sensor sources are lowered exactly like the platform lowering: verified byte-for-byte
against intents dispatched by the control plane.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Mapping

from .runtime.compiler import ContractError, _entities

DEG_TO_RAD = 3.141592653589793 / 180.0
ASPECT_RATIO = 16 / 9
VIDEO = {"width": 1280, "height": 720, "fps": 24, "container": "mp4", "codec": "h264", "quality": "standard"}
ENVIRONMENT = {"weather": "clear", "timeOfDay": "noon", "sunAzimuthDeg": 180,
               "sunElevationDeg": 60, "surfacePatches": []}
CAPABILITY_INTENT = {
    "required": ["sensor.rgb", "sensor.lidar", "sensor.radar"],
    "preferred": [], "fidelity": "dataset",
}
VEHICLE_ASSET = {
    "catalogAssetId": "vehicle.kia.carnival",
    "carlaBlueprintId": "vehicle.kia.carnival",
    "carlaClassPath": "/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C",
    "make": "Kia", "model": "Carnival", "baseType": "van",
    "sourceImage": {
        "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
        "indexSha256": "f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5",
        "linuxAmd64ManifestSha256": "baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64",
    },
}
CHASE_CAMERA_SENSOR_ID = "chase-cam-trailing"
POD_PLATE_HEIGHT_M = 1.78
POD_FRONT_DATUM_M = 0.85
def _angle_rad(degrees: float) -> float:
    return max(-3.141592653589793 + 1e-6, min(3.141592653589793 - 1e-6, degrees * DEG_TO_RAD))


def _q(value: float) -> int | float:
    """The platform lowering quantizes to 6 decimals; integral values serialize as ints."""
    quantized = round(float(value), 6)
    return int(quantized) if quantized == int(quantized) else quantized


def _mount(x_mm: float, right_mm: float, up_mm: float, yaw_deg: float = 0.0,
           pitch_deg: float = 0.0, roll_deg: float = 0.0) -> dict[str, Any]:
    """Pronto's pod-relative sheet: x runs back from the pod front datum."""
    return {
        "position": {
            "x": _q(POD_FRONT_DATUM_M + x_mm / 1000.0),
            "y": _q(POD_PLATE_HEIGHT_M + up_mm / 1000.0),
            "z": _q(-right_mm / 1000.0),
        },
        "rotation": {"yawRad": _q(_angle_rad(yaw_deg)), "pitchRad": _q(_angle_rad(pitch_deg)),
                     "rollRad": _q(_angle_rad(roll_deg))},
    }

def _camera(sensor_id: str, hfov_deg: float, mount: dict[str, Any]) -> dict[str, Any]:
    return {"id": sensor_id, "kind": "camera", "hfovDeg": hfov_deg, "mount": mount}


def _lidar(sensor_id: str, vfov_deg: float, yaw_deg: float, mount: dict[str, Any]) -> dict[str, Any]:
    return {"id": sensor_id, "kind": "lidar", "vfovDeg": vfov_deg, "yawDeg": yaw_deg, "mount": mount}


def _radar(sensor_id: str, mount: dict[str, Any]) -> dict[str, Any]:
    return {"id": sensor_id, "kind": "radar", "mount": mount}


SDG_MODALITIES = ("depth", "semantic", "instance", "normals")

# v1 RenderOutputProfile presets, expressed as extra camera modalities per Pronto camera.
RENDER_PROFILES = {
    "playback": [],
    "training_basic": ["semantic"],
    "training_multimodal": ["depth", "semantic", "instance"],
    "raw_multisensor": list(SDG_MODALITIES),
    "tao_detection": ["semantic", "instance"],
    "sdg": list(SDG_MODALITIES),
}


def expand_sdg(sources: list[dict[str, Any]], modalities: list[str]) -> list[dict[str, Any]]:
    """v1 SDG profile expansion: one extra sensor per rgb camera per modality.

    Mirrors the v1 profile expansion: derived sensors are named `<id>__<modality>`
    and share the base camera's pose and attributes.
    """
    if len(modalities) == 1 and modalities[0] in RENDER_PROFILES:
        modalities = list(RENDER_PROFILES[modalities[0]])
    unknown = [m for m in modalities if m not in SDG_MODALITIES]
    if unknown:
        raise ContractError(f"unknown SDG modalities: {unknown}; choose from {list(SDG_MODALITIES)}")
    expanded = list(sources)
    for source in sources:
        if source["modality"] != "rgb" or source["sensorId"] == CHASE_CAMERA_SENSOR_ID:
            continue
        for modality in modalities:
            variant = dict(source)
            variant["sensorId"] = f"{source['sensorId']}__{modality}"
            variant["outputName"] = f"{source['actorId']}-{source['sensorId']}-{modality}"
            variant["modality"] = modality
            expanded.append(variant)
    return expanded


def pronto_port_e_sources(actor_id: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """The 19 lowered sources of Pronto Port E plus its 8/6/4 measurement counts."""
    sources = [
        _camera("pronto-cam0", 120, _mount(-150.9, -795.8, 51.7, 122, 25)),
        _camera("pronto-cam1", 120, _mount(-150.8, 0, 51.7, 0, 10)),
        _camera("pronto-cam2", 120, _mount(-2460.3, -795.8, 51.7, 60, 25)),
        _camera("pronto-cam3", 30, _mount(-48.4, -595.3, 72.7)),
        _camera("pronto-cam4", 120, _mount(-2460.3, 795.8, 51.7, -60, 25)),
        _camera("pronto-cam5", 120, _mount(-2460.3, 0, 51.7, 180, 10)),
        _camera("pronto-cam6", 120, _mount(-150.8, 798.5, 51.7, -122, 25)),
        _camera("pronto-cam7", 60, _mount(-61.6, 592.7, 72.7, 0, 5)),
        _lidar("pronto-lidar-front-right", 25, 0, _mount(-115.9, 479.8, 127.8)),
        _lidar("pronto-lidar-front-left", 25, 0, _mount(-115.9, -477.2, 127.8)),
        _lidar("pronto-lidar-front-left-wide", 70, 120, _mount(-134.3, -767.1, 78.6, 120)),
        _lidar("pronto-lidar-front-right-wide", 70, -120, _mount(-134.2, 769.8, 78.6, -120)),
        _lidar("pronto-lidar-rear-left", 70, 60, _mount(-2476.9, -767.1, 78.6, 60)),
        _lidar("pronto-lidar-rear-right", 70, -60, _mount(-2476.9, 767.1, 78.6, -60)),
        _radar("pronto-rad-01", _mount(-59.3, -487.1, 74.8)),
        _radar("pronto-rad-02", _mount(-59.3, 469.9, 74.8)),
        _radar("pronto-rad-03", _mount(-2587.1, -461, 31.5, 160)),
        _radar("pronto-rad-04", _mount(-2537.4, 514.2, 31.5, -160)),
        # Trailing chase view; outside the measurement rig, sorted first for presentation.
        _camera(CHASE_CAMERA_SENSOR_ID, 70,
                {"position": {"x": -9, "y": 3.4, "z": 0},
                 "rotation": {"yawRad": 0, "pitchRad": _q(_angle_rad(15)), "rollRad": 0}}),
    ]
    lowered = [_lower_source(actor_id, template) for template in sources]
    counts = {"cameras": 8, "lidars": 6, "radars": 4}
    return lowered, counts


def _lower_source(actor_id: str, template: dict[str, Any]) -> dict[str, Any]:
    kind = template["kind"]
    modality = "rgb" if kind == "camera" else kind
    output_name = f"{actor_id}-{template['id']}-{modality}"
    source: dict[str, Any] = {
        "actorId": actor_id, "sensorId": template["id"], "outputName": output_name,
        "transform": template["mount"], "modality": modality,
    }
    if kind == "camera":
        source["attributes"] = {"width": VIDEO["width"], "height": VIDEO["height"],
                                "fps": VIDEO["fps"], "horizontalFovDeg": template["hfovDeg"],
                                "nearM": 0.05, "farM": 1000}
    elif kind == "lidar":
        half_fov = template["vfovDeg"] / 2.0
        source["attributes"] = {"channels": 32, "rangeM": 200, "pointsPerSecond": 100000,
                                "rotationFrequencyHz": 10,
                                "upperFovDeg": _q(half_fov), "lowerFovDeg": _q(-half_fov)}
    else:
        source["attributes"] = {"horizontalFovDeg": 30, "verticalFovDeg": 30,
                                "rangeM": 100, "pointsPerSecond": 1500}
    return source


VEHICLE_KINDS = {"vehicle", "car", "truck", "bus", "van", "motorcycle"}


def _host_actor(root: ET.Element) -> str:
    actors = _entities(root, lambda: None)
    vehicles = [actor_id for actor_id, binding in actors.items() if binding.kind in VEHICLE_KINDS]
    if not vehicles:
        raise ContractError("OpenSCENARIO contains no vehicle to host the sensor rig")
    # The authored ego leads: its id is the one vehicle ids sort under the same prefix.
    return min(vehicles, key=lambda actor_id: (not actor_id.startswith("vehicle"), actor_id))

def build_intent(scenario_bytes: bytes, xodr_path: Path, catalog_path: Path,
                 asset_ids: tuple[str, str], map_label: str, map_revision: str,
                 start_seconds: float = 0.0, end_seconds: float = 20.0,
                 seed: int | None = None,
                 sdg_modalities: list[str] | None = None,
                 annotations: bool = False) -> dict[str, Any]:
    xodr_bytes = xodr_path.read_bytes()
    scenario_sha = hashlib.sha256(scenario_bytes).hexdigest()
    root = ET.fromstring(scenario_bytes)
    actor_id = _host_actor(root)
    sources, rig_counts = pronto_port_e_sources(actor_id)
    if sdg_modalities:
        sources = expand_sdg(sources, sdg_modalities)
    digest = hashlib.sha256(json.dumps([scenario_sha, map_label], separators=(",", ":")).encode()).hexdigest()
    intent_id = f"usri_local_{digest[:24]}"
    source_digests = [
        item.get("value")
        for item in root.findall("./FileHeader/Properties/Property")
        if item.get("name") == "uniscenarios.provenance.inputHash"
    ]
    if len(source_digests) != 1 or not isinstance(source_digests[0], str) or len(source_digests[0]) != 64:
        raise ContractError("OpenSCENARIO must carry exactly one source input digest")
    return {
        "schema": "uniscenario.render-intent/v1",
        "intentId": intent_id,
        "executionPackage": {
            "id": intent_id,
            "sourceInputDigest": source_digests[0],
        },
        "scenarioRevision": {
            "revisionId": f"local_{digest[:24]}",
            "scenarioSha256": scenario_sha,
            "openScenario": {"sha256": scenario_sha, "sizeBytes": len(scenario_bytes)},
            "map": {"mapId": map_label, "revisionId": map_revision,
                    "sha256": hashlib.sha256(xodr_bytes).hexdigest()},
        },
        "sensorHosts": sorted(
            (
                {
                    "sourceId": source["outputName"],
                    "actorId": actor_id,
                    "vehicleAsset": {"catalogAssetId": VEHICLE_ASSET["catalogAssetId"]},
                }
                for source in sources
            ),
            key=lambda item: item["sourceId"],
        ),
        "renderSpec": {
            "schema": "uniscenario.render-spec/v3",
            "sources": sources,
            "clip": {"startSeconds": start_seconds, "endSeconds": end_seconds},
            "video": dict(VIDEO),
            "artifacts": ["manifest", "video"] + (["annotations"] if annotations else []),
            "capabilityIntent": CAPABILITY_INTENT,
            "authoredEnvironment": ENVIRONMENT,
        },
        "assets": [
            {"assetId": asset_ids[0], "kind": "map",
             "sha256": hashlib.sha256(xodr_bytes).hexdigest(),
             "sizeBytes": len(xodr_bytes)},
            {"assetId": asset_ids[1], "kind": "catalog",
             "sha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
             "sizeBytes": catalog_path.stat().st_size},
        ],
        "seed": seed if seed is not None else random.randrange(2**32),
    }


def run_local_command(args: argparse.Namespace) -> dict[str, object]:
    """Render an OpenSCENARIO offline: files in, MP4s out. No control plane involved."""
    import shutil
    from argparse import Namespace

    from .local import _canonical_render_intent_json, _run_intent

    output_dir = Path(args.output)
    inputs_dir = output_dir / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    xodr_input = inputs_dir / "map.xodr"
    catalog_input = inputs_dir / "catalog.json"
    shutil.copyfile(args.xodr, xodr_input)
    shutil.copyfile(args.catalog, catalog_input)

    raw_sdg = getattr(args, "sdg_modalities", None) or ""
    sdg_modalities = [m for m in raw_sdg.split(",") if m] if isinstance(raw_sdg, str) else list(raw_sdg)
    intent = build_intent(
        Path(args.scenario).read_bytes(), xodr_input, catalog_input,
        ("local-map", "local-catalog"),
        args.map_label or "local-map", args.map_revision or "local",
        start_seconds=args.start_seconds, end_seconds=args.end_seconds,
        seed=args.seed, sdg_modalities=sdg_modalities,
        annotations=bool(getattr(args, "annotations", False)),
    )
    intent_path = output_dir / "render-intent.json"
    intent_path.write_text(json.dumps(intent, sort_keys=True, separators=(",", ":")) + "\n", "utf-8")

    def entry(input_id: str, path: Path) -> dict[str, object]:
        body = path.read_bytes()
        return {"inputId": input_id, "path": str(path.resolve()),
                "sha256": hashlib.sha256(body).hexdigest(), "sizeBytes": len(body)}

    package = {
        "intentSha256": hashlib.sha256(_canonical_render_intent_json(intent).encode("utf-8")).hexdigest(),
        "inputs": [entry("scenario.xosc", Path(args.scenario)),
                   entry("local-map", xodr_input), entry("local-catalog", catalog_input)],
    }
    package_path = output_dir / "input-package.json"
    package_path.write_text(json.dumps(package, sort_keys=True, separators=(",", ":")) + "\n", "utf-8")
    return _run_intent(Namespace(
        intent=str(intent_path), package=str(package_path), output=str(output_dir),
        progress=str(output_dir / "carla-progress.jsonl"),
        manifest=str(output_dir / "render-artifact-manifest.json"),
        host=args.host, port=args.port,
    ))
