from __future__ import annotations

import copy
import ast
import hashlib
import gzip
import io
import json
import inspect
from pathlib import Path
import subprocess
from threading import Condition, Lock, Thread
import time
import textwrap
import xml.etree.ElementTree as ET

import pytest
import urllib.error

from uniscenarios_carla_bridge.runtime import transport as artifact_transport
from uniscenarios_carla_bridge.runtime import compiler as worker_compiler
from uniscenarios_carla_bridge.runtime import executor as worker_runner
from uniscenarios_carla_bridge.runtime import validation as worker_validation
from uniscenarios_carla_bridge.runtime.backend import (
    SIGNAL_LAMP_BY_INDICATION,
    VEHICLE_DOOR_MEMBERS,
    VEHICLE_LIGHT_BITS,
    CarlaBackend,
    apply_supported_blueprint_attributes,
    resolve_signal_lamp,
    runtime_asset_bindings,
)
from uniscenarios_carla_bridge.runtime.compiler import (
    SIGNAL_INDICATIONS,
    VEHICLE_COMPONENT_TYPES,
    VEHICLE_LIGHT_TYPES,
    ActorBinding,
    ActorFrame,
    ExecutionPlan,
    PlanFrame,
    compile_xosc14,
)
from uniscenarios_carla_bridge.runtime.contract import ContractError, OFFICIAL_XSD_SHA256, canonical_json, canonical_sha256, parse_lease
from uniscenarios_carla_bridge.runtime.parity import ParityAccumulator
from uniscenarios_carla_bridge.runtime.materialized_traffic import merge_materialized_traffic, parse_materialized_traffic
from uniscenarios_carla_bridge.runtime.executor import CancellationRequested, LeaseDeadlineExceeded, execute_lease
from uniscenarios_carla_bridge.runtime.validation import validate_xosc14


def artifact_bytes(body: bytes | Path) -> bytes:
    return body.read_bytes() if isinstance(body, Path) else body


def test_optional_camera_grade_attributes_never_block_a_supported_sensor() -> None:
    class Blueprint:
        def __init__(self) -> None:
            self.attributes: dict[str, str] = {}

        def has_attribute(self, name: str) -> bool:
            return name == "exposure_compensation"

        def set_attribute(self, name: str, value: str) -> None:
            self.attributes[name] = value

    blueprint = Blueprint()
    applied, unsupported = apply_supported_blueprint_attributes(
        blueprint,
        {"temp": "5250", "exposure_compensation": "-0.4"},
    )

    assert applied == {"exposure_compensation": "-0.4"}
    assert unsupported == ["temp"]
    assert blueprint.attributes == applied


def test_archive_sensor_data_preserves_relative_frame_paths(tmp_path: Path) -> None:
    sensor_dir = tmp_path / "lidar-front"
    sensor_dir.mkdir()
    (sensor_dir / "00000000.bin").write_bytes(b"first")
    (sensor_dir / "00000001.bin").write_bytes(b"second")
    destination = tmp_path / "lidar-front.zip"

    worker_runner._archive_sensor_data(sensor_dir, destination, 1024)

    import zipfile
    with zipfile.ZipFile(destination) as archive:
        assert archive.namelist() == ["00000000.bin", "00000001.bin"]
        assert archive.read("00000000.bin") == b"first"
        assert archive.read("00000001.bin") == b"second"

SOURCE_INPUT_DIGEST = "e" * 64
XOSC = f'''<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="4" date="1970-01-01T00:00:00Z" description="test" author="test"><Properties><Property name="uniscenario.executionMode" value="trajectory-replay"/><Property name="uniscenarios.provenance.inputHash" value="{SOURCE_INPUT_DIGEST}"/></Properties></FileHeader>
  <ParameterDeclarations/><CatalogLocations/><RoadNetwork><LogicFile filepath="map.xodr"/></RoadNetwork>
  <Entities><ScenarioObject name="actor_ego"><Vehicle name="uniscenarios_car" vehicleCategory="car"><Properties><Property name="uniscenario.actorId" value="ego"/><Property name="uniscenario.actorKind" value="car"/><Property name="uniscenarios.tag" value="catalog:vehicle.sedan"/></Properties></Vehicle></ScenarioObject></Entities>
  <Storyboard>
    <Init><Actions><Private entityRef="actor_ego"><PrivateAction><TeleportAction><Position><WorldPosition x="0" y="0" z="0" h="0" p="0" r="0"/></Position></TeleportAction></PrivateAction></Private></Actions></Init>
    <Story name="story"><Act name="act"><ManeuverGroup name="group" maximumExecutionCount="1"><Actors selectTriggeringEntities="false"><EntityRef entityRef="actor_ego"/></Actors><Maneuver name="maneuver"><Event name="event" priority="overwrite"><Action name="follow"><PrivateAction><RoutingAction><FollowTrajectoryAction><TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference><TrajectoryFollowingMode followingMode="position"/><TrajectoryRef><Trajectory name="trajectory_ego" closed="false"><Shape><Polyline>
      <Vertex time="0"><Position><WorldPosition x="0" y="0" z="0" h="0" p="0" r="0"/></Position><Motion speed_longitudinal="5"/></Vertex>
      <Vertex time="0.04"><Position><WorldPosition x="0.2" y="0" z="0" h="0" p="0" r="0"/></Position><Motion speed_longitudinal="5"/></Vertex>
    </Polyline></Shape></Trajectory></TrajectoryRef></FollowTrajectoryAction></RoutingAction></PrivateAction></Action><StartTrigger><ConditionGroup><Condition name="start" delay="0" conditionEdge="rising"><ByValueCondition><SimulationTimeCondition value="0" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger></Event></Maneuver></ManeuverGroup><StartTrigger/><StopTrigger/></Act></Story><StopTrigger/>
  </Storyboard>
</OpenSCENARIO>'''.encode()
XODR = b'<OpenDRIVE><header revMajor="1" revMinor="7"/></OpenDRIVE>'
CATALOG = json.dumps({
    "contractVersion": "uniscenario.asset-catalog/v1",
    "catalogVersionId": "uscatalog-1",
    "entries": [{
        "id": "vehicle.sedan",
        "class": "vehicle",
        "runtimeBindings": {
            "browser": {"mode": "procedural-generator", "generatorId": "vehicle.sedan", "fidelity": "exact"},
            "carla": {"mode": "native-blueprint", "blueprintId": "vehicle.lincoln.mkz", "fidelity": "semantic-class", "availability": "runtime-catalog-verified"},
        },
    }],
}).encode()
DISABLED_TRAFFIC = canonical_json({
    "schema": "uniscenarios.materialized-traffic.v1",
    "sourceInputDigest": SOURCE_INPUT_DIGEST,
    "map": {"assetId": "map-asset-1", "versionId": "map-version-1"},
    "provider": {"id": "disabled", "version": "none", "seed": ""},
    "fixedStepSeconds": 0.02,
    "durationSeconds": 0.04,
    "actors": [],
    "signals": [],
}).encode()


def execution_manifest(xosc: bytes = XOSC, ambient=None, source_input_digest: str = SOURCE_INPUT_DIGEST, traffic: bytes = DISABLED_TRAFFIC) -> bytes:
    d = lambda body: hashlib.sha256(body).hexdigest()
    ambient_value = ambient or {
        "mode": "disabled", "ambientConfig": {},
        "configSha256": d(b"{}"), "resultSha256": d(DISABLED_TRAFFIC),
    }
    materialized = {
        "artifactId": "materialized-traffic-1", "sha256": d(traffic), "sizeBytes": len(traffic),
        "sourceInputDigest": source_input_digest, "mapAssetId": "map-asset-1", "mapVersionId": "map-version-1",
    }
    return json.dumps({
        "contract": "uniscenario.execution-package/v1",
        "openScenarioProfile": "ASAM OpenSCENARIO XML 1.4",
        "xsdSha256": OFFICIAL_XSD_SHA256,
        "revision": {"id": "revision-1", "sha256": "f" * 64},
        "sourceInputDigest": source_input_digest,
        "materializedTrafficDigest": d(traffic),
        "map": {"id": "map-version-1", "assetId": "map-asset-1", "versionId": "map-version-1", "xodrSha256": d(XODR), "artifacts": {"map-xodr": d(XODR)}},
        "assetCatalog": {"versionId": "uscatalog-1", "manifestSha256": d(CATALOG)},
        "ambient": {**ambient_value, "materializedTraffic": materialized},
        "materializedTraffic": {
            **{key: materialized[key] for key in ("artifactId", "sha256", "sizeBytes")},
            "overlapActorIds": [],
        },
        "files": [{"kind": "xosc", "mediaType": "application/xml", "sha256": d(xosc), "sizeBytes": len(xosc)}],
    }, sort_keys=True, separators=(",", ":")).encode()


MANIFEST = execution_manifest()


def trajectory_in_init(value: bytes = XOSC) -> bytes:
    """Move the replay action to the canonical UniScenario OSC 1.4 location."""
    root = ET.fromstring(value)
    action = root.find("./Storyboard/Story//FollowTrajectoryAction")
    private = root.find("./Storyboard/Init/Actions/Private")
    event = root.find("./Storyboard/Story//Event")
    assert action is not None and private is not None and event is not None
    private_action = ET.SubElement(private, "PrivateAction")
    routing = ET.SubElement(private_action, "RoutingAction")
    routing.append(action)
    maneuver = root.find("./Storyboard/Story//Maneuver")
    assert maneuver is not None
    maneuver.remove(event)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def materialized_traffic(*, provider="native", version="carla-0.10.0", seed="native-1", duration=0.04, actors=True, signals=True):
    times = [round(index * 0.02, 9) for index in range(round(duration / 0.02) + 1)]
    value = {
        "schema": "uniscenarios.materialized-traffic.v1",
        "sourceInputDigest": SOURCE_INPUT_DIGEST,
        "map": {"assetId": "map-asset-1", "versionId": "map-version-1"},
        "provider": {"id": provider, "version": version, "seed": seed},
        "fixedStepSeconds": 0.02,
        "durationSeconds": duration,
        "actors": [{
            "id": "background-1", "kind": "vehicle",
            "states": [{
                "t": t, "present": True, "x": 10 + t, "z": 2, "headingRad": 0,
                "speedMps": 1, "accelerationMps2": 0, "signals": 3,
            } for t in times],
        }] if actors else [],
        "signals": [{"id": "traffic-light-1", "states": [{"t": t, "state": "green" if t < 0.04 else "yellow"} for t in times]}] if signals else [],
    }
    return canonical_json(value).encode()


def parse_traffic(body, **overrides):
    expected = {
        "expected_digest": digest(body),
        "source_input_digest": SOURCE_INPUT_DIGEST,
        "map_asset_id": "map-asset-1",
        "map_version_id": "map-version-1",
        "provider_id": "native",
        "provider_version": "carla-0.10.0",
        "provider_seed": "native-1",
        "fixed_step_seconds": 0.02,
        "duration_seconds": 0.04,
    }
    expected.update(overrides)
    return parse_materialized_traffic(body, **expected)


def reseal_control(package):
    package.pop("controlSha256", None)
    def strip_control(item):
        if isinstance(item, dict):
            return {key: strip_control(child) for key, child in item.items() if key not in {"url", "controlSha256"}}
        if isinstance(item, list):
            return [strip_control(child) for child in item]
        return item
    package["controlSha256"] = canonical_sha256(strip_control(package))


def seal_lease(value, manifest: bytes = MANIFEST):
    job = value["job"]
    package = job["executionPackage"]
    package["manifest"] = {"url": "memory:manifest", "sha256": digest(manifest), "sizeBytes": len(manifest)}
    package["materializedTrafficDigest"] = package["ambient"]["resultSha256"]
    sensors = job["renderSpec"]["sensors"]
    raster = [
        sensor for sensor in sensors
        if sensor["modality"] in {"rgb", "depth", "semantic", "instance", "normals"}
    ]
    samples_per_frame = sum(
        sensor["config"]["width"] * sensor["config"]["height"] for sensor in raster
    ) + sum(
        int(sensor["config"]["pointsPerSecond"] / job["renderSpec"]["fps"])
        for sensor in sensors if "pointsPerSecond" in sensor["config"]
    )
    package["runtimeRequirements"] = {
        "schema": "uniscenario.runtime-requirements/v1",
        "xoscVersion": "1.4",
        "capabilityProfile": "xml-1.4-trajectory-replay",
        "fixedTimestepS": 0.02,
        "jobMode": job["mode"],
        "trafficMode": package["ambient"]["ambientMode"],
        "executionMode": job["renderSpec"].get("executionMode", "native-physics"),
        "sensorModalities": sorted({sensor["modality"] for sensor in sensors}),
        "outputs": sorted(set(job["renderSpec"]["outputs"])),
        "resources": {
            "schema": "uniscenario.render-resource-request/v1",
            "durationS": 0.04,
            "sensors": len(sensors),
            "captureFrames": len(sensors),
            "actors": 256,
            "actorFrameStates": 512,
            "sensorSamples": samples_per_frame * len(sensors),
            "outputBytes": 2_147_483_648,
            "maxFrameWidth": max((sensor["config"]["width"] for sensor in raster), default=0),
            "maxFrameHeight": max((sensor["config"]["height"] for sensor in raster), default=0),
            "samplesPerFrame": samples_per_frame,
        },
    }
    reseal_control(package)
    return value


def _sensor_artifact_name(sensor):
    actor = sensor.get("actorId") if sensor.get("actorId") is not None else "world"
    return f"{sensor['role']}:{actor}:{sensor['sensorId']}:{sensor['modality']}"


DEFAULT_LEASE_SENSORS = [{
    "role": "primary",
    "actorId": "ego",
    "sensorId": "hero",
    "modality": "rgb",
    "transform": {"x": -7.5, "y": 0, "z": 3, "pitch": -12, "yaw": 0, "roll": 0},
    "config": {"width": 640, "height": 360, "fov": 90},
}]


def lease_value(outputs=None, uploads=None, sensors=None, formats=None):
    selected_outputs = outputs or ["trace"]
    sensor_values = copy.deepcopy(sensors if sensors is not None else DEFAULT_LEASE_SENSORS)
    if uploads is None:
        upload_kinds = list(dict.fromkeys(["trace", *selected_outputs]))
        media_types = {
            "trace": "application/gzip",
            "video": "video/mp4",
            "manifest": "application/json",
            "annotations": "application/x-ndjson",
        }
        if "video" in selected_outputs:
            primary_rgb = next(
                (sensor for sensor in sensor_values if sensor["modality"] == "rgb"), None,
            )
            for sensor in sensor_values:
                if sensor is primary_rgb:
                    continue
                kind = f"sensorVideo:{_sensor_artifact_name(sensor)}"
                upload_kinds.append(kind)
                media_types[kind] = "video/mp4"
        for sensor in sensor_values:
            if sensor["modality"] in {"lidar", "semantic-lidar", "radar"}:
                kind = f"sensorData:{_sensor_artifact_name(sensor)}"
                upload_kinds.append(kind)
                media_types[kind] = "application/zip"
        uploads = {kind: {
            "uploadId": kind,
            "uploadUrl": f"memory:upload:{kind}",
            "artifactUrl": f"/api/uniscenario/artifact-uploads/{kind}",
            "requiredHeaders": {"content-type": media_types.get(kind, "application/zip")},
        } for kind in upload_kinds}
    return seal_lease({
        "leaseToken": "lease-token-000000000000000000000",
        "leaseExpiresAt": "2026-08-04T00:00:00Z",
        "job": {
            "id": "job-1", "attempt": 1,
            "executionPackage": {
                "schema": "uniscenario.execution-package/v1", "id": "package-1", "revisionId": "revision-1",
                "sourceInputDigest": SOURCE_INPUT_DIGEST,
                "materializedTrafficDigest": digest(DISABLED_TRAFFIC),
                "mapAssetId": "map-asset-1", "mapVersionId": "map-version-1",
                "xosc": {"url": "memory:xosc", "sha256": digest(XOSC), "sizeBytes": len(XOSC), "xsdSha256": OFFICIAL_XSD_SHA256},
                "xodr": {"url": "memory:xodr", "sha256": digest(XODR), "sizeBytes": len(XODR), "mapName": "fixture"},
                "assetCatalog": {"contractVersion": "uniscenario.asset-catalog/v1", "catalogVersionId": "uscatalog-1", "url": "memory:catalog", "sha256": digest(CATALOG), "sizeBytes": len(CATALOG)},
                "ambient": {
                    "ambientMode": "disabled",
                    "ambientConfig": {},
                    "configSha256": digest(b"{}"),
                    "resultSha256": digest(DISABLED_TRAFFIC),
                    "materializedTraffic": {"url": "memory:traffic", "sha256": digest(DISABLED_TRAFFIC), "sizeBytes": len(DISABLED_TRAFFIC)},
                },
            },
            "mode": "full_render",
            "renderSpec": {
                "schema": "uniscenario.render-spec/v1",
                "fps": 25,
                "sensors": sensor_values,
                "outputs": selected_outputs,
                "executionMode": "native-physics",
                "quality": "high",
                **({"formats": formats} if formats is not None else {}),
            },
            "parityThresholds": {"positionM": 0.01, "headingDeg": 0.01, "speedMps": 0.01},
            "artifactUploads": uploads,
        },
    })


class FakeBackend:
    def __init__(self):
        self.calls = []
        self.frame = None
        self.offset = 0.0
        self.stability = None
        self.output_dir = None
        self.records = []
        self.executed_signals = {}

    def configure_execution(self, mode): self.calls.append(("mode", mode))
    def set_rpc_timeout(self, timeout_s): self.rpc_timeout_s = timeout_s
    def load_opendrive(self, map_name, xodr, fixed_timestep_s): self.calls.append(("load", map_name, fixed_timestep_s))
    def bind_signals(self, signal_ids, abort=None): (abort or (lambda: None))(); self.calls.append(("signals", signal_ids))
    def configure_environment(self, environment): self.calls.append(("environment", environment.cloudiness))
    def spawn(self, actors, first_frame, catalog, abort=None): (abort or (lambda: None))(); self.calls.append(("spawn", sorted(actors)))
    def prepare_scenario(self, first_frame, abort=None): (abort or (lambda: None))(); self.calls.append(("prepare", first_frame.index)); return self.stability
    def configure_sensors(self, spec, output_dir: Path, max_capture_disk_bytes, abort=None):
        (abort or (lambda: None))()
        output_dir.mkdir(parents=True)
        self.output_dir = output_dir
        self.sensor_specs = spec.sensors
        self.calls.append(("sensors", len(spec.sensors)))
        self.max_capture_disk_bytes = max_capture_disk_bytes
    def apply(self, frame, abort=None): (abort or (lambda: None))(); self.frame = frame; self.executed_signals = dict(frame.signals); self.calls.append(("apply", frame.index))
    def tick(self, capture=None, abort=None):
        (abort or (lambda: None))()
        self.calls.append(("tick", self.frame.index))
        if capture is not None:
            for sensor in self.sensor_specs:
                sensor_key = sensor.artifact_name
                target = self.output_dir / sensor_key
                target.mkdir(parents=True, exist_ok=True)
                output_index = int(capture["outputFrameIndex"])
                (target / f"{output_index:08d}.png").write_bytes(b"png")
                self.records.append({
                    "artifactName": sensor_key,
                    "role": sensor.role,
                    "actorId": sensor.actor_id,
                    "sensorId": sensor.sensor_id,
                    "modality": sensor.modality,
                    "outputFrameIndex": output_index,
                    "scheduledTimeS": capture["scheduledTimeS"],
                    "carlaFrame": self.frame.index + 1,
                    "actualCarlaTimeS": self.frame.t,
                    "relativePath": f"{sensor_key}/{output_index:08d}.png",
                })
        return {actor_id: {"x": state.x + self.offset, "y": state.y, "z": state.z, "headingDeg": state.heading_deg, "speedMps": state.speed_mps} for actor_id, state in self.frame.actors.items()}
    def finalize_capture(self, expected_frame_count, abort=None):
        (abort or (lambda: None))()
        self.calls.append(("finalize", expected_frame_count))
        assert len(self.records) == expected_frame_count
    def cleanup(self): self.calls.append(("cleanup",))
    def sensor_manifest(self, abort=None): (abort or (lambda: None))(); return self.records
    def signal_readback(self, abort=None): (abort or (lambda: None))(); return dict(self.executed_signals)


class _OwnedTestLight:
    type_id = "traffic.traffic_light"

    def __init__(self):
        self.id = 42
        self.signal_id = "signal-42"
        self.state, self.frozen = "green", False
        self.green_time, self.yellow_time, self.red_time = 10.0, 3.0, 7.0

    def get_opendrive_id(self): return self.signal_id
    def get_state(self): return self.state
    def is_frozen(self): return self.frozen
    def get_green_time(self): return self.green_time
    def get_yellow_time(self): return self.yellow_time
    def get_red_time(self): return self.red_time
    def set_state(self, value): self.state = value
    def freeze(self, value): self.frozen = value
    def set_green_time(self, value): self.green_time = value
    def set_yellow_time(self, value): self.yellow_time = value
    def set_red_time(self, value): self.red_time = value


class _OwnedTestActors(list):
    def filter(self, pattern):
        assert pattern == "traffic.traffic_light*"
        return self


class _OwnedTestWorld:
    def __init__(self, light):
        self.actors = _OwnedTestActors([light])
        self.ticks = 0

    def get_actors(self): return self.actors
    def tick(self): self.ticks += 1; return self.ticks


class _OwnedSignalFakeBackend(FakeBackend):
    _signal_identity = staticmethod(CarlaBackend._signal_identity)
    _restore_owned_signals = CarlaBackend._restore_owned_signals
    bind_signals = CarlaBackend.bind_signals

    def __init__(self):
        super().__init__()
        self.light = _OwnedTestLight()
        self.world = _OwnedTestWorld(self.light)
        self.signals, self.signal_snapshots = {}, {}

    def cleanup(self):
        self._restore_owned_signals()
        self.calls.append(("cleanup",))


def _xosc_with_physical_signal() -> bytes:
    action = b'<GlobalAction><InfrastructureAction><TrafficSignalAction><TrafficSignalStateAction name="signal-42" state="red"/></TrafficSignalAction></InfrastructureAction></GlobalAction>'
    return XOSC.replace(b"<Init><Actions>", b"<Init><Actions>" + action)


def _lease_with_physical_signal():
    xosc = _xosc_with_physical_signal()
    value = lease_value()
    value["job"]["executionPackage"]["xosc"].update({"sha256": digest(xosc), "sizeBytes": len(xosc)})
    manifest = execution_manifest(xosc)
    return parse_lease(seal_lease(value, manifest)), xosc, manifest


def test_carla_spawn_preserves_absolute_xosc_elevation_and_coordinate_sign():
    class Location:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class Carla: pass
    Carla.Location, Carla.Rotation, Carla.Transform = Location, Rotation, Transform
    class Library:
        def find(self, blueprint_id): return blueprint_id
    class Actor:
        id = 1
        type_id = "vehicle.lincoln.mkz"
        def destroy(self): return True
    class World:
        def __init__(self): self.transform = None
        def get_blueprint_library(self): return Library()
        def try_spawn_actor(self, _blueprint, transform): self.transform = transform; return Actor()

    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = World()
    backend.actors = {}
    frame = PlanFrame(0, 0, {
        "ego": ActorFrame("spawn", 143.269, -338.977, 61.796, -5.782, 0),
    }, {})
    backend.spawn({"ego": ActorBinding("ego", "actor_ego", "car", "vehicle.sedan")}, frame, {
        "vehicle.sedan": {"blueprintId": "vehicle.lincoln.mkz"},
    })
    spawned = backend.world.transform
    assert spawned.location.x == pytest.approx(143.269)
    assert spawned.location.y == pytest.approx(338.977)
    assert spawned.location.z == pytest.approx(62.046)
    assert spawned.rotation.yaw == pytest.approx(5.782)


def test_native_prepare_settles_before_t0_and_resets_linear_and_angular_velocity():
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Location:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class VehicleControl:
        def __init__(self, throttle=0, brake=0, steer=0):
            self.throttle, self.brake, self.steer = throttle, brake, steer
    class WalkerControl:
        def __init__(self, speed=0, jump=False): self.speed, self.jump = speed, jump
    class Carla: pass
    Carla.Vector3D, Carla.Location, Carla.Rotation, Carla.Transform = Vector3D, Location, Rotation, Transform
    Carla.VehicleControl, Carla.WalkerControl = VehicleControl, WalkerControl
    class Actor:
        def __init__(self, type_id):
            self.type_id, self.controls, self.linear, self.angular = type_id, [], None, None
            self.transform = Transform(Location(x=9, y=8, z=7), Rotation(yaw=6))
        def apply_control(self, control): self.controls.append(control)
        def get_transform(self): return self.transform
        def get_velocity(self): return Vector3D()
        def get_angular_velocity(self): return Vector3D()
        def set_transform(self, value): self.transform = value
        def set_target_velocity(self, value): self.linear = value
        def set_target_angular_velocity(self, value): self.angular = value
    class World:
        def __init__(self): self.ticks = 0
        def tick(self): self.ticks += 1

    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = World()
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.speed_integrals = {"ego": 10.0}
    backend.actors = {"ego": Actor("vehicle.lincoln.mkz"), "ped": Actor("walker.pedestrian.0001")}
    frame = PlanFrame(0, 0, {
        "ego": ActorFrame("spawn", 1, 2, 3, 4, 0),
        "ped": ActorFrame("spawn", 5, 6, 7, 8, 0),
    }, {})
    report = backend.prepare_scenario(frame)
    assert backend.world.ticks == 33
    assert backend.actors["ego"].controls[0].brake == 1.0
    assert backend.actors["ped"].controls[0].speed == 0.0
    assert backend.actors["ego"].linear.x == backend.actors["ego"].linear.y == backend.actors["ego"].linear.z == 0.0
    assert backend.actors["ego"].angular.x == backend.actors["ego"].angular.y == backend.actors["ego"].angular.z == 0.0
    assert (backend.actors["ego"].transform.location.x, backend.actors["ego"].transform.location.y) == (1, -2)
    assert backend.actors["ego"].transform.location.z == 7
    assert backend.actors["ego"].transform.rotation.yaw == -4
    assert backend.speed_integrals == {"ego": 0.0, "ped": 0.0}
    assert [phase["ticks"] for phase in report["phases"]] == [24, 9]
    assert report["phases"][1]["residuals"]["ego"]["verticalMps"] == 0.0


def test_native_prepare_fails_closed_when_motion_never_converges():
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Location(Vector3D): pass
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self): self.location, self.rotation = Location(), Rotation()
    class Actor:
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D(z=-1.0)
        def get_angular_velocity(self): return Vector3D()
    class World:
        def tick(self): pass

    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {"ego": Actor()}
    with pytest.raises(RuntimeError, match="spawn settle.*linearMps.*verticalMps"):
        backend._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=25)


def test_native_stability_accepts_late_convergence_with_five_tick_proof():
    class Vector3D:
        def __init__(self, z=0): self.x, self.y, self.z = 0, 0, z
    class Transform:
        def __init__(self):
            self.location = Vector3D()
            self.rotation = type("Rotation", (), {"yaw": 0})()
    class World:
        def __init__(self): self.ticks = 0
        def tick(self): self.ticks += 1
    class Actor:
        def __init__(self, world): self.world = world
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D(-1 if self.world.ticks < 28 else 0)
        def get_angular_velocity(self): return Vector3D()

    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {"ego": Actor(backend.world)}
    report = backend._wait_for_native_stability("post-reset", minimum_ticks=5, maximum_ticks=100)
    assert report["ticks"] == 32
    assert report["residuals"]["ego"]["verticalMps"] == 0


def test_native_stability_rejects_periodic_motion_without_five_consecutive_ticks():
    class Vector3D:
        def __init__(self, z=0): self.x, self.y, self.z = 0, 0, z
    class Transform:
        def __init__(self):
            self.location = Vector3D()
            self.rotation = type("Rotation", (), {"yaw": 0})()
    class World:
        def __init__(self): self.ticks = 0
        def tick(self): self.ticks += 1
    class Actor:
        def __init__(self, world): self.world = world
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D(0.2 if self.world.ticks % 5 == 0 else 0)
        def get_angular_velocity(self): return Vector3D()

    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {"ego": Actor(backend.world)}
    with pytest.raises(RuntimeError, match="post-reset"):
        backend._wait_for_native_stability("post-reset", minimum_ticks=5, maximum_ticks=30)


def _stability_fakes():
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Transform:
        def __init__(self):
            self.location = Vector3D()
            self.rotation = type("Rotation", (), {"yaw": 0})()
    class World:
        def __init__(self): self.ticks = 0
        def tick(self): self.ticks += 1
    return Vector3D, Transform, World


def test_native_stability_zero_drift_actors_converge_trivially():
    # rc.63 regression: campaign settle phases timed out at 100 ticks while
    # reporting literally all-zero residuals. Actors with zero drift MUST
    # converge at minimum_ticks + 4, statics frozen along the way.
    Vector3D, Transform, World = _stability_fakes()
    class Actor:
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D()
        def get_angular_velocity(self): return Vector3D()
    class StaticActor(Actor):
        def __init__(self): self.physics = None
        def set_simulate_physics(self, value): self.physics = value
        def set_target_velocity(self, value): pass
        def set_target_angular_velocity(self, value): pass
    backend = object.__new__(CarlaBackend)
    backend.carla = type("carla", (), {"Vector3D": Vector3D})
    backend.world = World()
    static = StaticActor()
    backend.actors = {"ego": Actor(), "prop": static}
    backend.static_actor_ids = {"prop"}
    backend.frozen_static_actor_ids = set()
    report = backend._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=100)
    assert report["ticks"] == 24
    assert report["blockedTicks"] == {}
    assert static.physics is False
    assert backend.frozen_static_actor_ids == {"prop"}


def test_native_stability_converts_carla_angular_readback_from_degrees():
    # carla.Actor.get_angular_velocity() reports deg/s; the angularRadps gate
    # is 0.02 rad/s (~1.146 deg/s). 1 deg/s (0.0175 rad/s) must pass and
    # 2 deg/s (0.0349 rad/s) must fail — pinning the deg->rad conversion.
    Vector3D, Transform, World = _stability_fakes()
    def build(deg_per_s):
        class Actor:
            def get_transform(self): return Transform()
            def get_velocity(self): return Vector3D()
            def get_angular_velocity(self): return Vector3D(z=deg_per_s)
        backend = object.__new__(CarlaBackend)
        backend.world = World()
        backend.actors = {"ego": Actor()}
        return backend
    report = build(1.0)._wait_for_native_stability("post-reset", minimum_ticks=5, maximum_ticks=30)
    assert report["ticks"] == 9
    assert report["residuals"]["ego"]["angularRadps"] == pytest.approx(0.0174533, rel=1e-4)
    with pytest.raises(RuntimeError, match="post-reset"):
        build(2.0)._wait_for_native_stability("post-reset", minimum_ticks=5, maximum_ticks=30)


def test_native_stability_converges_through_measured_parked_vehicle_jitter():
    # The rc.63 fleet measured parked-vehicle angular jitter of 0.0066-0.0299
    # deg/s oscillating tick to tick. Treated as rad/s it straddled the 0.02
    # gate and reset the 5-consecutive counter for 100 ticks; converted to
    # rad/s it is 40x inside the budget and must converge immediately.
    Vector3D, Transform, World = _stability_fakes()
    class ParkedVehicle:
        def __init__(self, world): self.world = world
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D()
        def get_angular_velocity(self):
            return Vector3D(z=0.0299 if self.world.ticks % 2 else 0.0066)
    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {"ego": ParkedVehicle(backend.world)}
    report = backend._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=100)
    assert report["ticks"] == 24
    assert report["blockedTicks"] == {}


def test_native_stability_failure_names_blocking_actor_and_metric():
    # The genuine rc.63 instability read 14.8 deg/s (0.258 rad/s) with 1.7mm
    # per-tick horizontal drift: it must still fail closed, and the error must
    # name the blocking actor/metric with over-threshold tick counts instead
    # of only the (possibly settled-looking) final tick residuals.
    Vector3D, Transform, World = _stability_fakes()
    class SpinningVehicle:
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D(x=0.0155)
        def get_angular_velocity(self): return Vector3D(z=14.8)
    class ParkedVehicle:
        def get_transform(self): return Transform()
        def get_velocity(self): return Vector3D()
        def get_angular_velocity(self): return Vector3D()
    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {"spinner": SpinningVehicle(), "parked": ParkedVehicle()}
    with pytest.raises(RuntimeError) as excinfo:
        backend._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=25)
    message = str(excinfo.value)
    assert "did not converge during spawn settle after 25 ticks" in message
    assert "blocking residuals" in message
    assert "'spinner'" in message and "'angularRadps'" in message
    assert "'ticksOverThreshold': 25" in message
    assert "statics never frozen: []" in message


def test_native_low_speed_controller_has_feed_forward_braking_and_anti_windup():
    backend = object.__new__(CarlaBackend)
    backend.fixed_timestep_s = 0.02
    backend.speed_integrals = {}
    throttle, brake = backend._vehicle_longitudinal_control("ego", 0.015, 0.0)
    assert 0.18 < throttle < 0.2
    assert brake == 0.0
    throttle, brake = backend._vehicle_longitudinal_control("ego", 0.015, 0.05)
    assert throttle == 0.0
    assert brake >= 0.08
    assert backend.speed_integrals["ego"] == 0.0
    throttle, brake = backend._vehicle_longitudinal_control("ego", 0.0, 0.02)
    assert throttle == 0.0
    assert brake > 0.15


class _FakeStreamEncoder:
    """Stands in for _CameraStreamEncoder: records submissions, writes nothing."""

    def __init__(self, destination):
        self.destination = destination
        self.submitted = []

    def submit(self, data):
        self.submitted.append(data)


def _capture_backend(tmp_path, callback):
    backend = object.__new__(CarlaBackend)
    backend.sensor_lock = Lock()
    backend.sensor_condition = Condition(backend.sensor_lock)
    backend.sensor_pending = {}
    backend.sensor_last_frame = {}
    backend.sensor_records = []
    backend.sensor_error = None
    backend.sensor_closed = False
    backend.capture_disk_bytes = 0
    backend.max_capture_disk_bytes = 1024 * 1024
    backend.sensor_timeout_s = 0.2
    backend.sensor_writer_workers = 2
    backend.sensor_writer_pool = None
    backend.video_fps = 25.0
    backend.fixed_timestep_s = 0.02
    backend.sensor_configs = {
        camera_id: {
            "target": tmp_path / camera_id,
            "role": "primary",
            "actorId": "ego",
            "sensorId": camera_id,
            "modality": "rgb",
            "converter": None,
            "extension": "png",
            "transform": {},
            "config": {"width": 640, "height": 360, "fov": 90},
            "encoder": _FakeStreamEncoder(tmp_path / camera_id / "stream.mp4"),
        }
        for camera_id in ("hero", "rear")
    }
    for config in backend.sensor_configs.values():
        config["target"].mkdir()
    backend.sensors = []
    backend.actors = {}
    backend.world = type("World", (), {"tick": lambda _self: callback(backend) or 42})()
    return backend


class _SensorImage:
    def __init__(self, frame, timestamp=0.0):
        self.frame, self.timestamp = frame, timestamp


def test_capture_waits_for_all_delayed_sensors_on_the_exact_world_frame(tmp_path):
    threads = []
    def callbacks(backend):
        for camera_id, delay in (("hero", 0.01), ("rear", 0.04)):
            thread = Thread(target=lambda cid=camera_id, wait=delay: (time.sleep(wait), backend._receive_sensor_frame(cid, _SensorImage(42, 1.25))))
            thread.start()
            threads.append(thread)
    backend = _capture_backend(tmp_path, callbacks)
    backend.tick({"outputFrameIndex": 7, "scheduledTimeS": 7 / 30})
    for thread in threads: thread.join()
    assert [(item["sensorId"], item["carlaFrame"], item["outputFrameIndex"], item["relativePath"]) for item in backend.sensor_manifest()] == [
        ("hero", 42, 7, "hero/stream.mp4"), ("rear", 42, 7, "rear/stream.mp4"),
    ]
    # Camera frames stream into their encoder; nothing lands on disk.
    assert [len(config["encoder"].submitted) for config in backend.sensor_configs.values()] == [1, 1]
    assert not list((tmp_path / "hero").glob("*.png"))
    assert not list((tmp_path / "rear").glob("*.png"))


def test_capture_fails_closed_when_one_sensor_times_out(tmp_path):
    backend = _capture_backend(tmp_path, lambda value: value._receive_sensor_frame("hero", _SensorImage(42)))
    backend.sensor_timeout_s = 0.01
    with pytest.raises(RuntimeError, match="sensor frame timeout.*rear"):
        backend.tick({"outputFrameIndex": 0, "scheduledTimeS": 0.0})


def test_capture_enforces_incremental_bookkeeping_disk_quota(tmp_path):
    def callbacks(backend):
        backend._receive_sensor_frame("hero", _SensorImage(42))
        backend._receive_sensor_frame("rear", _SensorImage(42))
    backend = _capture_backend(tmp_path, callbacks)
    backend.max_capture_disk_bytes = 4098
    with pytest.raises(ContractError, match="incremental temporary-disk quota"):
        backend.tick({"outputFrameIndex": 0, "scheduledTimeS": 0.0})
    assert backend.sensor_records == []


@pytest.mark.parametrize("frames, message", [([42, 42], "duplicate"), ([43, 42], "out-of-order")])
def test_capture_rejects_duplicate_and_out_of_order_callbacks(tmp_path, frames, message):
    def callbacks(backend):
        for frame in frames:
            backend._receive_sensor_frame("hero", _SensorImage(frame))
        backend._receive_sensor_frame("rear", _SensorImage(42))
    backend = _capture_backend(tmp_path, callbacks)
    with pytest.raises(RuntimeError, match=message):
        backend.tick({"outputFrameIndex": 0, "scheduledTimeS": 0.0})


def test_native_smoke_contract_never_teleports_after_t0():
    class Location:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class VehicleControl:
        def __init__(self, throttle=0, brake=0, steer=0):
            self.throttle, self.brake, self.steer = throttle, brake, steer
    class Carla: pass
    Carla.Location, Carla.Rotation, Carla.Transform, Carla.VehicleControl = Location, Rotation, Transform, VehicleControl
    Carla.TrafficLightState = type("TrafficLightState", (), {"Red": 0, "Yellow": 1, "Green": 2, "Off": 3})
    class Velocity:
        x = y = z = 0.0
    class Actor:
        type_id = "vehicle.lincoln.mkz"
        def __init__(self): self.control = None; self.teleports = 0
        def get_velocity(self): return Velocity()
        def get_transform(self): return Transform(Location(), Rotation())
        def apply_control(self, control): self.control = control
        def set_transform(self, _target): self.teleports += 1

    actor = Actor()
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.speed_integrals = {"ego": 0.0}
    backend.actors = {"ego": actor}
    backend.signals = {}
    backend.apply(PlanFrame(0, 0, {"ego": ActorFrame("ego", 0, 0, 0, 0, 0.015)}, {}))
    assert actor.teleports == 0
    assert actor.control.throttle > 0.18
    assert actor.control.brake == 0.0


def test_carla_signal_binding_owns_complete_map_and_restores_state_timings_and_freeze_once():
    class TrafficLightState:
        Red, Yellow, Green, Off = "red", "yellow", "green", "off"
    class Carla:
        pass
    Carla.TrafficLightState = TrafficLightState
    class Light:
        type_id = "traffic.traffic_light"
        def __init__(self, actor_id, signal_id, state, frozen, durations):
            self.signal_id = signal_id
            self.id, self.state, self.frozen = actor_id, state, frozen
            self.green_time, self.yellow_time, self.red_time = durations
            self.mutations = []
        def get_opendrive_id(self): return self.signal_id
        def get_state(self): return self.state
        def is_frozen(self): return self.frozen
        def get_green_time(self): return self.green_time
        def get_yellow_time(self): return self.yellow_time
        def get_red_time(self): return self.red_time
        def set_state(self, state): self.state = state; self.mutations.append(("state", state))
        def freeze(self, frozen): self.frozen = frozen; self.mutations.append(("freeze", frozen))
        def set_green_time(self, value): self.green_time = value; self.mutations.append(("green", value))
        def set_yellow_time(self, value): self.yellow_time = value; self.mutations.append(("yellow", value))
        def set_red_time(self, value): self.red_time = value; self.mutations.append(("red", value))
    class Actors(list):
        def filter(self, pattern): assert pattern == "traffic.traffic_light*"; return self
    class Settings:
        synchronous_mode, fixed_delta_seconds = True, 0.02
    class World:
        def __init__(self, lights): self.lights, self.ticks = Actors(lights), 0
        def get_actors(self): return self.lights
        def tick(self): self.ticks += 1; return self.ticks
        def get_settings(self): return Settings()
        def apply_settings(self, _settings): pass

    first = Light(101, "head-a", "green", False, (11.0, 4.0, 9.0))
    second = Light(202, "head-b", "yellow", True, (8.0, 3.0, 12.0))
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = World([first, second])
    backend.signals, backend.signal_snapshots = {}, {}
    backend.sensors, backend.actors = [], {}

    backend.bind_signals(("head-a", "head-b"))
    assert first.mutations == [("freeze", True)]
    assert second.mutations == [("freeze", True)]
    assert backend.world.ticks == 1

    backend.apply(PlanFrame(0, 0, {}, {"head-a": "red", "head-b": "green"}))
    first.green_time, first.yellow_time, first.red_time = 99.0, 98.0, 97.0
    second.green_time, second.yellow_time, second.red_time = 96.0, 95.0, 94.0
    assert first.state == "red"
    assert second.state == "green"
    assert backend.signal_readback() == {"head-a": "red", "head-b": "green"}
    backend.cleanup()
    assert (first.state, first.frozen) == ("green", False)
    assert (second.state, second.frozen) == ("yellow", True)
    assert (first.green_time, first.yellow_time, first.red_time) == (11.0, 4.0, 9.0)
    assert (second.green_time, second.yellow_time, second.red_time) == (8.0, 3.0, 12.0)
    assert backend.world.ticks == 3
    first_after_cleanup = list(first.mutations)
    second_after_cleanup = list(second.mutations)

    backend.cleanup()
    assert first.mutations == first_after_cleanup
    assert second.mutations == second_after_cleanup


@pytest.mark.parametrize(
    ("authored", "runtime_ids", "message"),
    [
        (("head-present", "head-missing"), ("head-present",), "missing: head-missing"),
        (("head-present",), ("head-present", "head-extra"), "extra: head-extra"),
    ],
)
def test_carla_signal_binding_requires_exact_complete_map_before_mutation(authored, runtime_ids, message):
    class Light:
        def __init__(self, actor_id, signal_id): self.id, self.signal_id, self.mutations = actor_id, signal_id, []
        def get_opendrive_id(self): return self.signal_id
        def get_state(self): return "green"
        def is_frozen(self): return False
        def get_green_time(self): return 10.0
        def get_yellow_time(self): return 3.0
        def get_red_time(self): return 10.0
        def set_state(self, state): self.mutations.append(("state", state))
        def freeze(self, frozen): self.mutations.append(("freeze", frozen))
    class Actors(list):
        def filter(self, _pattern): return self
    class World:
        def __init__(self, lights): self.lights, self.ticks = Actors(lights), 0
        def get_actors(self): return self.lights
        def tick(self): self.ticks += 1

    lights = [Light(index, signal_id) for index, signal_id in enumerate(runtime_ids, 1)]
    backend = object.__new__(CarlaBackend)
    backend.world = World(lights)
    backend.signals, backend.signal_snapshots = {}, {}
    with pytest.raises(RuntimeError, match=message):
        backend.bind_signals(authored)
    assert all(light.mutations == [] for light in lights)
    assert backend.world.ticks == 0
    assert backend.signals == {}
    assert backend.signal_snapshots == {}


def test_compiles_xosc_to_deterministic_50hz_plan():
    first = compile_xosc14(XOSC)
    second = compile_xosc14(XOSC)
    assert first.fixed_timestep_s == 0.02
    assert [frame.t for frame in first.frames] == [0.0, 0.02, 0.04]
    assert first.frames[1].actors["ego"].x == pytest.approx(0.1)
    assert first.sha256 == second.sha256
    assert first.actors["ego"].catalog_name == "vehicle.sedan"


def test_twenty_second_50hz_plan_schedules_exactly_600_unique_30fps_frames():
    frames = tuple(PlanFrame(index, index * 0.02, {}, {}) for index in range(1001))
    plan = ExecutionPlan("uniscenario.execution-plan/v1", 0.02, {}, frames, "a" * 64)
    schedule = worker_runner._capture_schedule(plan, 30)
    assert len(schedule) == 600
    assert list(schedule.values())[0] == (0, 0.0)
    assert list(schedule.values())[-1][0] == 599
    assert max(schedule) < 1000
    assert len(set(schedule)) == 600


def test_signed_manifest_shape_resolves_only_nested_exact_carla_bindings():
    manifest = json.loads(CATALOG)
    assert runtime_asset_bindings(manifest, expected_catalog_version_id="uscatalog-1") == {
        "vehicle.sedan": {"blueprintId": "vehicle.lincoln.mkz"},
    }
    with pytest.raises(ContractError, match="version does not match"):
        runtime_asset_bindings(manifest, expected_catalog_version_id="uscatalog-other")
    malformed = copy.deepcopy(manifest)
    del malformed["entries"][0]["runtimeBindings"]["carla"]["blueprintId"]
    with pytest.raises(ContractError, match="no exact CARLA blueprintId"):
        runtime_asset_bindings(malformed, expected_catalog_version_id="uscatalog-1")


def test_compiles_canonical_init_follow_trajectory_action():
    plan = compile_xosc14(trajectory_in_init())
    assert [frame.t for frame in plan.frames] == [0.0, 0.02, 0.04]
    assert plan.frames[1].actors["ego"].x == pytest.approx(0.1)


def test_rejects_non_absolute_or_duplicate_replay_trajectories():
    relative = trajectory_in_init().replace(
        b'domainAbsoluteRelative="absolute"',
        b'domainAbsoluteRelative="relative"',
    )
    with pytest.raises(ContractError, match="requires absolute Timing"):
        compile_xosc14(relative)

    duplicate = ET.fromstring(trajectory_in_init())
    private = duplicate.find("./Storyboard/Init/Actions/Private")
    action = duplicate.find("./Storyboard/Init/Actions/Private/PrivateAction/RoutingAction/FollowTrajectoryAction")
    assert private is not None and action is not None
    private_action = ET.SubElement(private, "PrivateAction")
    routing = ET.SubElement(private_action, "RoutingAction")
    routing.append(copy.deepcopy(action))
    with pytest.raises(ContractError, match="multiple replay trajectories"):
        compile_xosc14(ET.tostring(duplicate))


def test_rejects_wrong_version_and_external_entities():
    with pytest.raises(ContractError, match="XML 1.4"):
        compile_xosc14(XOSC.replace(b'revMinor="4"', b'revMinor="3"'))
    with pytest.raises(ContractError, match="forbidden"):
        compile_xosc14(b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + XOSC)


def test_compiles_physical_signal_state_replay_and_rejects_unknown_actions():
    signal_action = b'<GlobalAction><InfrastructureAction><TrafficSignalAction><TrafficSignalStateAction name="signal-42" state="red"/></TrafficSignalAction></InfrastructureAction></GlobalAction>'
    with_signal = XOSC.replace(b"<Init><Actions>", b"<Init><Actions>" + signal_action)
    plan = compile_xosc14(with_signal)
    assert all(frame.signals == {"signal-42": "red"} for frame in plan.frames)
    unsupported = XOSC.replace(b"<StopTrigger/>", b"<UserDefinedAction><CustomCommandAction type='x'/></UserDefinedAction><StopTrigger/>", 1)
    with pytest.raises(ContractError, match="user-defined"):
        compile_xosc14(unsupported)


def test_compiler_enforces_actor_cap_before_sampling_and_honors_sampling_abort():
    template = '<ScenarioObject name="actor_{0}"><Vehicle name="car" vehicleCategory="car"><Properties><Property name="uniscenario.actorId" value="actor-{0}"/><Property name="uniscenario.actorKind" value="car"/><Property name="uniscenarios.tag" value="catalog:vehicle.sedan"/></Properties></Vehicle></ScenarioObject>'
    entities = ("<Entities>" + "".join(template.format(index) for index in range(257)) + "</Entities>").encode()
    over_cap = XOSC.replace(XOSC[XOSC.index(b"<Entities>"):XOSC.index(b"</Entities>") + len(b"</Entities>")], entities)
    with pytest.raises(ContractError, match="256 actors"):
        compile_xosc14(over_cap)

    long_scenario = XOSC.replace(b'time="0.04"', b'time="10.0"')
    checks = 0
    def abort():
        nonlocal checks
        checks += 1
        if checks == 6:
            raise LeaseDeadlineExceeded("expired during compiler sampling")
    with pytest.raises(LeaseDeadlineExceeded, match="compiler sampling"):
        compile_xosc14(long_scenario, abort=abort)
    assert checks == 6


def test_compiler_inner_vertex_sample_and_digest_loops_are_abortible():
    vertices = "".join(
        f'<Vertex time="{index}"><Position><WorldPosition x="{index}" y="0"/></Position><Motion speed_longitudinal="1"/></Vertex>'
        for index in range(1024)
    )
    action = ET.fromstring(
        '<FollowTrajectoryAction><TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference>'
        f'<TrajectoryRef><Trajectory><Shape><Polyline>{vertices}</Polyline></Shape></Trajectory></TrajectoryRef></FollowTrajectoryAction>'
    )
    vertex_checks = 0
    def vertex_abort():
        nonlocal vertex_checks
        vertex_checks += 1
        if vertex_checks == 4:
            raise CancellationRequested("vertex parsing cancelled")
    with pytest.raises(CancellationRequested, match="vertex parsing"):
        worker_compiler._trajectory_vertices(action, vertex_abort)

    points = [(float(index), float(index), 0.0, 0.0, 0.0, 1.0) for index in range(4096)]
    sample_checks = 0
    def sample_abort():
        nonlocal sample_checks
        sample_checks += 1
        if sample_checks == 5:
            raise CancellationRequested("binary sample cancelled")
    with pytest.raises(CancellationRequested, match="binary sample"):
        worker_compiler._sample(points, 2048.5, sample_abort)

    plan = compile_xosc14(XOSC)
    digest_checks = 0
    def digest_abort():
        nonlocal digest_checks
        digest_checks += 1
        if digest_checks == 3:
            raise CancellationRequested("digest cancelled")
    with pytest.raises(CancellationRequested, match="digest"):
        worker_compiler._canonical_plan_sha256(
            plan.actors, plan.frames, plan.semantic_metadata, digest_abort,
        )


def test_executes_hash_closed_lease_and_uploads_trace():
    uploads = {"trace": {"uploadId": "reservation-1", "uploadUrl": "memory:upload", "artifactUrl": "/api/uniscenario/artifact-uploads/reservation-1", "requiredHeaders": {"content-type": "application/gzip", "x-test": "1"}}}
    lease = parse_lease(lease_value(uploads=uploads))
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    uploaded = []
    events = []
    backend = FakeBackend()
    backend.stability = {"schema": "uniscenario.native-stability/v1", "phases": []}
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda url, body, media_type, headers: uploaded.append((url, artifact_bytes(body), media_type, headers)),
        progress=lambda kind, payload: events.append((kind, payload)),
    )
    assert result["status"] == "succeeded"
    assert result["parity"]["samples"] == 3
    assert result["artifacts"][0]["artifactUrl"].endswith("reservation-1")
    assert uploaded[0][0] == "memory:upload"
    trace = json.loads(gzip.decompress(uploaded[0][1]))
    assert trace["schema"] == "uniscenario.render-trace/v1"
    assert trace["executionPackageControlSha256"] == lease.execution_package.control_sha256
    assert trace["sourceInputDigest"] == SOURCE_INPUT_DIGEST
    assert trace["frames"][0]["signals"] == {}
    assert trace["signalStateSource"] == "backend-verified"
    assert result["attestation"]["nativeStability"] == backend.stability
    assert [event[0] for event in events] == ["assets_validated", "plan_compiled", "render_started", "artifact_uploaded"]
    assert backend.calls[-1] == ("cleanup",)
    assert backend.calls[0] == ("mode", "native-physics")
    assert backend.calls.index(("signals", ())) < backend.calls.index(("environment", 0.0))
    assert backend.calls.index(("signals", ())) < backend.calls.index(("spawn", ["ego"]))
    assert backend.calls.index(("sensors", 1)) < backend.calls.index(("prepare", 0))


def test_mode_is_explicit_and_parity_tolerance_gates_result():
    value = lease_value()
    value["job"]["renderSpec"]["executionMode"] = "diagnostic-replay"
    lease = parse_lease(seal_lease(value))
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    backend.offset = 0.011
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda *_args: None,
    )
    assert backend.calls[0] == ("mode", "diagnostic-replay")
    assert result["status"] == "failed-parity"
    assert result["parity"]["violation_counts"]["positionM"] == 3


def test_interaction_2d_is_camera_free_and_emits_trace_and_manifest():
    value = lease_value(outputs=["trace", "manifest"], uploads={
        "trace": {"uploadId": "trace", "uploadUrl": "memory:trace", "artifactUrl": "/api/uniscenario/artifact-uploads/trace", "requiredHeaders": {"content-type": "application/gzip"}},
        "manifest": {"uploadId": "manifest", "uploadUrl": "memory:manifest", "artifactUrl": "/api/uniscenario/artifact-uploads/manifest", "requiredHeaders": {"content-type": "application/json"}},
    })
    value["job"]["mode"] = "interaction_2d"
    value["job"]["renderSpec"]["schema"] = "uniscenario.interaction-spec/v1"
    value["job"]["renderSpec"]["sensors"] = []
    lease = parse_lease(seal_lease(value))
    backend = FakeBackend()
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda *_args: None,
    )
    assert not any(call[0] == "sensors" for call in backend.calls)
    assert [artifact["kind"] for artifact in result["artifacts"]] == ["trace", "manifest"]


def test_sumo_requires_hash_closed_materialized_traffic():
    value = lease_value()
    value["job"]["executionPackage"]["ambient"] = {"ambientMode": "sumo"}
    with pytest.raises(ContractError, match="invalid fields"):
        parse_lease(value)


def test_all_ambient_modes_are_explicit_and_hash_closed():
    native_traffic = materialized_traffic()
    native = lease_value()
    native["job"]["executionPackage"]["ambient"] = {
        "ambientMode": "native", "runtimeVersion": "carla-0.10.0", "seed": "native-1",
        "ambientConfig": {"vehicles": 4}, "configSha256": digest(b'{"vehicles":4}'),
        "resultSha256": digest(native_traffic),
        "materializedTraffic": {"url": "memory:traffic", "sha256": digest(native_traffic), "sizeBytes": len(native_traffic)},
    }
    assert parse_lease(seal_lease(native)).execution_package.ambient["ambientMode"] == "native"

    traffic = materialized_traffic(provider="sumo", version="1.27.1", seed="sumo-1")
    sumo = lease_value()
    sumo["job"]["executionPackage"]["ambient"] = {
        "ambientMode": "sumo", "sumoVersion": "1.27.1", "networkSha256": "d" * 64,
        "seed": "sumo-1", "ambientConfig": {}, "configSha256": digest(b"{}"),
        "resultSha256": digest(traffic),
        "materializedTraffic": {"url": "memory:traffic", "sha256": digest(traffic), "sizeBytes": len(traffic)},
    }
    assert parse_lease(seal_lease(sumo)).execution_package.ambient["ambientMode"] == "sumo"


def test_materialized_traffic_is_strictly_canonical_ordered_and_identity_bound():
    body = materialized_traffic()
    parsed = parse_traffic(body)
    assert parsed.sha256 == digest(body)
    assert parsed.actors[0].states[-1].x == 10.04
    with pytest.raises(ContractError, match="canonical JSON"):
        parse_traffic(json.dumps(json.loads(body), indent=2).encode())
    for changed, message in [
        ({"sourceInputDigest": "d" * 64}, "sourceInputDigest"),
        ({"map": {"assetId": "stale-map", "versionId": "map-version-1"}}, "map identity"),
        ({"durationSeconds": 0.06}, "durationSeconds"),
    ]:
        value = json.loads(body)
        value.update(changed)
        altered = canonical_json(value).encode()
        with pytest.raises(ContractError, match=message):
            parse_traffic(altered)


def test_materialized_traffic_rejects_tamper_bad_signal_coverage_and_actor_order():
    body = materialized_traffic()
    with pytest.raises(ContractError, match="digest mismatch"):
        parse_traffic(body[:-1] + b" ", expected_digest=digest(body))

    value = json.loads(body)
    value["signals"][0]["states"] = value["signals"][0]["states"][:-1]
    bad_signals = canonical_json(value).encode()
    with pytest.raises(ContractError, match="cover every fixed-step frame"):
        parse_traffic(bad_signals)

    value = json.loads(body)
    second = copy.deepcopy(value["actors"][0])
    second["id"] = "aaa-background"
    value["actors"].append(second)
    unordered = canonical_json(value).encode()
    with pytest.raises(ContractError, match="sorted by unique id"):
        parse_traffic(unordered)

    value = json.loads(body)
    value["actors"][0]["states"][1].update({"present": False, "x": 1})
    noncanonical_absence = canonical_json(value).encode()
    with pytest.raises(ContractError, match="canonical zero payload"):
        parse_traffic(noncanonical_absence)


def test_materialized_traffic_preserves_absence_lifecycle_and_indicator_bits():
    value = json.loads(materialized_traffic())
    value["actors"][0]["states"][1] = {
        "t": 0.02, "present": False, "x": 0, "z": 0, "headingRad": 0,
        "speedMps": 0, "accelerationMps2": 0, "signals": 0,
    }
    body = canonical_json(value).encode()
    merged = merge_materialized_traffic(compile_xosc14(XOSC), parse_traffic(body))
    assert [frame.actors["background-1"].lifecycle for frame in merged.frames] == ["spawn", "absent", "spawn"]
    assert merged.frames[0].actors["background-1"].appearance == {
        "light.indicatorRight": "on", "light.indicatorLeft": "on", "light.warningLights": "on",
    }


def test_materialized_traffic_overrides_canonical_ambient_actor_without_rebinding_it():
    base = compile_xosc14(XOSC)
    ambient_id = "ambient:native:0000"
    ambient_binding = ActorBinding(ambient_id, "canonical_ambient_0000", "vehicle", "vehicle.sedan", True)
    ambient_frames = tuple(
        PlanFrame(
            frame.index,
            frame.t,
            {
                **frame.actors,
                ambient_id: ActorFrame("spawn" if frame.index == 0 else "active", -100.0, 0.0, 0.0, 0.0, 0.0, {}),
            },
            frame.signals,
        )
        for frame in base.frames
    )
    plan = ExecutionPlan(base.schema, base.fixed_timestep_s, {**base.actors, ambient_id: ambient_binding}, ambient_frames, base.sha256)
    value = json.loads(materialized_traffic())
    value["actors"][0]["id"] = ambient_id
    traffic = parse_traffic(canonical_json(value).encode())

    merged = merge_materialized_traffic(plan, traffic, frozenset({ambient_id}))

    assert merged.actors[ambient_id] == ambient_binding
    assert [frame.actors[ambient_id].x for frame in merged.frames] == [10.0, 10.02, 10.04]


def test_materialized_traffic_still_rejects_authored_actor_overlap():
    value = json.loads(materialized_traffic())
    value["actors"][0]["id"] = "ego"
    traffic = parse_traffic(canonical_json(value).encode())
    with pytest.raises(ContractError, match="collide with authored actors: ego"):
        merge_materialized_traffic(compile_xosc14(XOSC), traffic)


def test_materialized_traffic_rejects_forged_ambient_prefix_without_compiler_provenance():
    base = compile_xosc14(XOSC)
    ambient_id = "ambient:authored-forgery"
    binding = ActorBinding(ambient_id, "authored_ambient_prefix", "vehicle", "vehicle.sedan")
    frames = tuple(PlanFrame(frame.index, frame.t, {
        **frame.actors,
        ambient_id: ActorFrame("spawn" if frame.index == 0 else "active", 0, 0, 0, 0, 0, {}),
    }, frame.signals) for frame in base.frames)
    plan = ExecutionPlan(base.schema, base.fixed_timestep_s, {**base.actors, ambient_id: binding}, frames, base.sha256)
    value = json.loads(materialized_traffic())
    value["actors"][0]["id"] = ambient_id
    with pytest.raises(ContractError, match="collide with authored actors"):
        merge_materialized_traffic(plan, parse_traffic(canonical_json(value).encode()))


def test_materialized_traffic_rejects_forged_xosc_origin_outside_signed_manifest_membership():
    ambient_id = "ambient:forged-xosc"
    forged = XOSC.replace(
        b'<Property name="uniscenario.actorId" value="ego"/>',
        f'<Property name="uniscenario.actorId" value="{ambient_id}"/><Property name="uniscenarios.actorOrigin" value="canonical-ambient"/>'.encode(),
    )
    plan = compile_xosc14(forged)
    assert plan.actors[ambient_id].materialized_traffic_eligible is True
    value = json.loads(materialized_traffic())
    value["actors"][0]["id"] = ambient_id
    with pytest.raises(ContractError, match="collide with authored actors"):
        merge_materialized_traffic(plan, parse_traffic(canonical_json(value).encode()), frozenset())


def test_materialized_traffic_requires_every_signed_overlap_member_in_the_artifact():
    traffic = parse_traffic(materialized_traffic())
    with pytest.raises(ContractError, match="overlap membership"):
        merge_materialized_traffic(
            compile_xosc14(XOSC), traffic, frozenset({"ambient:signed-but-missing"}),
        )


def test_disabled_materialized_traffic_contract_is_canonical_empty():
    body = materialized_traffic(provider="disabled", version="none", seed="", actors=False, signals=False)
    parsed = parse_traffic(
        body, provider_id="disabled", provider_version="none", provider_seed="",
    )
    assert parsed.actors == parsed.signals == ()
    populated = materialized_traffic(provider="disabled", version="none", seed="")
    with pytest.raises(ContractError, match="canonical empty"):
        parse_traffic(populated, provider_id="disabled", provider_version="none", provider_seed="")


def test_materialized_traffic_executes_exact_background_paths_and_signals():
    traffic = materialized_traffic()
    traffic_digest = digest(traffic)
    ambient_control = {
        "ambientMode": "native", "runtimeVersion": "carla-0.10.0", "seed": "native-1",
        "ambientConfig": {"vehicles": 1}, "configSha256": digest(b'{"vehicles":1}'),
        "resultSha256": traffic_digest,
        "materializedTraffic": {"url": "memory:traffic", "sha256": traffic_digest, "sizeBytes": len(traffic)},
    }
    ambient_manifest = {
        "mode": "native", "runtimeVersion": "carla-0.10.0", "seed": "native-1",
        "ambientConfig": {"vehicles": 1}, "configSha256": digest(b'{"vehicles":1}'),
        "resultSha256": traffic_digest,
    }
    manifest = execution_manifest(ambient=ambient_manifest, traffic=traffic)
    value = lease_value()
    value["job"]["executionPackage"]["ambient"] = ambient_control
    lease = parse_lease(seal_lease(value, manifest))
    backend = FakeBackend()
    uploaded = []
    assets = {
        "memory:manifest": manifest, "memory:xosc": XOSC, "memory:xodr": XODR,
        "memory:catalog": CATALOG, "memory:traffic": traffic,
    }
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda _url, body, _media_type, _headers: uploaded.append(artifact_bytes(body)),
    )
    trace = json.loads(gzip.decompress(uploaded[0]))
    assert ("spawn", ["background-1", "ego"]) in backend.calls
    assert [frame["actors"]["background-1"]["x"] for frame in trace["frames"]] == [10, 10.02, 10.04]
    assert [frame["signals"]["traffic-light-1"] for frame in trace["frames"]] == ["green", "green", "yellow"]
    assert backend.frame.actors["background-1"].appearance["light.warningLights"] == "on"
    assert trace["materializedTrafficDigest"] == result["materializedTrafficDigest"] == traffic_digest


def test_rejects_fake_or_incomplete_ambient_provenance():
    fake_disabled = lease_value()
    fake_disabled["job"]["executionPackage"]["ambient"]["sumoVersion"] = "fabricated"
    with pytest.raises(ContractError, match="invalid fields"):
        parse_lease(fake_disabled)

    bad_digest = lease_value()
    bad_digest["job"]["executionPackage"]["ambient"]["configSha256"] = "0" * 64
    with pytest.raises(ContractError, match="digest mismatch"):
        parse_lease(bad_digest)


def test_versioned_render_spec_supports_all_native_sensors_quality_environment_and_formats():
    transform = {"x": 1.4, "y": 0, "z": 1.25, "pitch": -3, "yaw": 0, "roll": 0}
    camera = {"width": 1280, "height": 720, "fov": 82}
    lidar = {
        "channels": 64, "rangeM": 120, "pointsPerSecond": 1_000_000,
        "rotationFrequencyHz": 24, "upperFovDeg": 10, "lowerFovDeg": -30,
    }
    radar = {"horizontalFovDeg": 40, "verticalFovDeg": 20, "rangeM": 100, "pointsPerSecond": 20_000}
    modalities = ["rgb", "depth", "semantic", "instance", "normals", "lidar", "semantic-lidar", "radar"]
    sensors = [
        {
            "role": f"capture-{index}", "actorId": "ego", "sensorId": f"sensor-{index}",
            "modality": modality, "transform": transform,
            "config": camera if modality in {"rgb", "depth", "semantic", "instance", "normals"} else lidar if "lidar" in modality else radar,
        }
        for index, modality in enumerate(modalities)
    ]
    value = lease_value(
        outputs=["trace", "manifest", "annotations"],
        sensors=sensors,
        formats=["json", "jsonl", "ply", "csv"],
    )
    value["job"]["renderSpec"].update({
        "quality": "cinematic",
        "environment": {"cloudiness": 70, "precipitation": 25, "wetness": 50, "sunAltitude": 12},
    })
    lease = parse_lease(seal_lease(value))
    assert [sensor.modality for sensor in lease.render_spec.sensors] == modalities
    assert lease.render_spec.sensors[0].transform["x"] == 1.4
    assert lease.render_spec.quality == "cinematic"
    assert lease.render_spec.environment.cloudiness == 70


def test_manifest_annotations_and_cancellation_are_first_class_outputs():
    value = lease_value(outputs=["trace", "manifest", "annotations"])
    lease = parse_lease(value)
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    uploaded = {}
    result = execute_lease(
        lease, FakeBackend(),
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda url, body, _media_type, _headers: uploaded.__setitem__(url, artifact_bytes(body)),
    )
    assert [item["kind"] for item in result["artifacts"]] == ["trace", "annotations", "manifest"]
    manifest = json.loads(uploaded["memory:upload:manifest"])
    trace = json.loads(gzip.decompress(uploaded["memory:upload:trace"]))
    assert manifest["schema"] == "uniscenario.render-manifest/v1"
    assert manifest["renderSpec"]["schema"] == "uniscenario.render-spec/v1"
    assert manifest["sensorFrames"][0]["sensorId"] == "hero"
    assert manifest["executionPackageControlSha256"] == trace["executionPackageControlSha256"]
    assert manifest["sourceInputDigest"] == trace["sourceInputDigest"] == SOURCE_INPUT_DIGEST
    assert manifest["materializedTrafficDigest"] == trace["materializedTrafficDigest"] == digest(DISABLED_TRAFFIC)
    annotations = uploaded["memory:upload:annotations"].decode().splitlines()
    assert len(annotations) == 1
    assert json.loads(annotations[0])["schema"] == "uniscenario.annotation-frame/v1"
    backend = FakeBackend()
    with pytest.raises(CancellationRequested):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: None,
            control=lambda progress: progress.get("stage") == "execute",
        )
    assert backend.calls[-1] == ("cleanup",)


def test_authored_signal_state_is_restored_after_execution_failure():
    class FailingBackend(_OwnedSignalFakeBackend):
        def apply(self, frame, abort=None):
            (abort or (lambda: None))()
            self.light.state = "red"
            self.light.green_time = 99.0
            raise ValueError("frame execution failed")

    lease, xosc, manifest = _lease_with_physical_signal()
    backend = FailingBackend()
    assets = {"memory:manifest": manifest, "memory:xosc": xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    with pytest.raises(ValueError, match="frame execution failed"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: None,
        )
    assert (backend.light.state, backend.light.frozen) == ("green", False)
    assert (backend.light.green_time, backend.light.yellow_time, backend.light.red_time) == (10.0, 3.0, 7.0)
    assert backend.world.ticks == 3
    assert backend.calls[-1] == ("cleanup",)


def test_authored_signal_state_is_restored_after_cancellation():
    lease, xosc, manifest = _lease_with_physical_signal()
    backend = _OwnedSignalFakeBackend()
    assets = {"memory:manifest": manifest, "memory:xosc": xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    with pytest.raises(CancellationRequested):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: None,
            control=lambda progress: progress.get("stage") == "execute",
        )
    assert (backend.light.state, backend.light.frozen) == ("green", False)
    assert backend.world.ticks == 3
    assert backend.calls[-1] == ("cleanup",)


def test_cleanup_failure_is_chained_without_masking_execution_failure():
    class DoublyFailingBackend(FakeBackend):
        def apply(self, _frame, abort=None):
            (abort or (lambda: None))()
            raise ValueError("original execution failure")
        def cleanup(self): raise RuntimeError("secondary cleanup failure")

    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    with pytest.raises(ValueError, match="original execution failure") as raised:
        execute_lease(
            lease, DoublyFailingBackend(),
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: None,
        )
    assert isinstance(raised.value.__cause__, RuntimeError)
    assert str(raised.value.__cause__) == "secondary cleanup failure"


class _StreamingSensorBackend(FakeBackend):
    """Cameras produce one streamed mp4; lidar/radar land per-frame data files."""

    def tick(self, capture=None, abort=None):
        (abort or (lambda: None))()
        self.calls.append(("tick", self.frame.index))
        if capture is not None:
            for sensor in self.sensor_specs:
                sensor_key = sensor.artifact_name
                target = self.output_dir / sensor_key
                target.mkdir(parents=True, exist_ok=True)
                output_index = int(capture["outputFrameIndex"])
                if sensor.modality in {"rgb", "depth", "semantic", "instance", "normals"}:
                    (target / "stream.mp4").write_bytes(b"mp4-stream")
                    relative = f"{sensor_key}/stream.mp4"
                elif sensor.modality == "radar":
                    (target / f"{output_index:08d}.csv").write_text("depth,azimuth,altitude,velocity\n10,0,0,1\n")
                    relative = f"{sensor_key}/{output_index:08d}.csv"
                else:
                    (target / f"{output_index:08d}.ply").write_text("ply\nend_header\n1 2 0.5 0.9\n")
                    relative = f"{sensor_key}/{output_index:08d}.ply"
                self.records.append({
                    "artifactName": sensor_key,
                    "role": sensor.role,
                    "actorId": sensor.actor_id,
                    "sensorId": sensor.sensor_id,
                    "modality": sensor.modality,
                    "outputFrameIndex": output_index,
                    "scheduledTimeS": capture["scheduledTimeS"],
                    "carlaFrame": self.frame.index + 1,
                    "actualCarlaTimeS": self.frame.t,
                    "relativePath": relative,
                })
        return {actor_id: {"x": state.x + self.offset, "y": state.y, "z": state.z, "headingDeg": state.heading_deg, "speedMps": state.speed_mps} for actor_id, state in self.frame.actors.items()}

    def finalize_capture(self, expected_frame_count, abort=None):
        (abort or (lambda: None))()
        self.calls.append(("finalize", expected_frame_count))
        per_sensor = {}
        for record in self.records:
            per_sensor[record["artifactName"]] = per_sensor.get(record["artifactName"], 0) + 1
        assert per_sensor and all(count == expected_frame_count for count in per_sensor.values())


VIDEO_TEST_SENSORS = [
    {"role": "primary", "actorId": "ego", "sensorId": "hero", "modality": "rgb",
     "transform": {"x": -7.5, "y": 0, "z": 3, "pitch": -12, "yaw": 0, "roll": 0},
     "config": {"width": 640, "height": 360, "fov": 90}},
    {"role": "chase", "actorId": "ego", "sensorId": "chase-cam", "modality": "rgb",
     "transform": {"x": -9.0, "y": 0, "z": 4, "pitch": -15, "yaw": 0, "roll": 0},
     "config": {"width": 640, "height": 360, "fov": 90}},
    {"role": "depthcap", "actorId": "ego", "sensorId": "depth-1", "modality": "depth",
     "transform": {"x": 1.5, "y": 0, "z": 1.6, "pitch": 0, "yaw": 0, "roll": 0},
     "config": {"width": 640, "height": 360, "fov": 90}},
    {"role": "roof", "actorId": "ego", "sensorId": "lidar-1", "modality": "lidar",
     "transform": {"x": 0, "y": 0, "z": 2.4, "pitch": 0, "yaw": 0, "roll": 0},
     "config": {"channels": 32, "rangeM": 120, "pointsPerSecond": 100_000,
                "rotationFrequencyHz": 25, "upperFovDeg": 10, "lowerFovDeg": -30}},
    {"role": "bumper", "actorId": "ego", "sensorId": "radar-1", "modality": "radar",
     "transform": {"x": 2.2, "y": 0, "z": 0.6, "pitch": 0, "yaw": 0, "roll": 0},
     "config": {"horizontalFovDeg": 40, "verticalFovDeg": 20, "rangeM": 100, "pointsPerSecond": 20_000}},
]


def _fake_ffprobe(command, _stage, _check_abort, _deadline):
    assert command[0] == "ffprobe", "cameras adopt streamed mp4s; ffmpeg must not re-encode them"
    return type("Result", (), {
        "returncode": 0, "stderr": b"",
        "stdout": b'{"streams":[{"nb_read_frames":"1","duration":"0.04"}]}',
    })()


def test_every_authored_camera_uploads_its_own_video_and_no_frame_archive_exists(monkeypatch):
    lease = parse_lease(lease_value(outputs=["trace", "video"], sensors=VIDEO_TEST_SENSORS))
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    uploads = []
    monkeypatch.setattr(worker_runner, "_run_process", _fake_ffprobe)
    def stream_upload(url, body, media_type, headers):
        with body.open("rb") if isinstance(body, Path) else io.BytesIO(body) as source:
            uploads.append((url, source.read(), media_type, headers))
    result = execute_lease(
        lease, _StreamingSensorBackend(),
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=stream_upload,
    )
    kinds = [item["kind"] for item in result["artifacts"]]
    # Every authored camera yields exactly one video artifact: the primary RGB
    # stream doubles as the review "video"; every other camera gets its own
    # sensorVideo. Lidar/radar keep data zips plus visualization videos.
    assert kinds == [
        "trace",
        "video",
        "sensorVideo:chase:ego:chase-cam:rgb",
        "sensorVideo:depthcap:ego:depth-1:depth",
        "sensorVideo:roof:ego:lidar-1:lidar",
        "sensorVideo:bumper:ego:radar-1:radar",
        "sensorData:roof:ego:lidar-1:lidar",
        "sensorData:bumper:ego:radar-1:radar",
    ]
    assert not any(kind.startswith("framesArchive") for kind in kinds)
    camera_artifacts = [item for item in result["artifacts"] if item["kind"] == "video" or ":rgb" in item["kind"] or ":depth" in item["kind"]]
    for item in camera_artifacts:
        assert item["mediaType"] == "video/mp4"
        metadata = item["metadata"]
        assert metadata["codec"] == "h264"
        assert metadata["container"] == "mp4"
        assert metadata["format"] == "mp4-h264"
        assert metadata["encoder"] == "software"
        assert metadata["fps"] == 25.0
        assert metadata["frameCount"] == 1
        assert (metadata["width"], metadata["height"]) == (640, 360)
    primary = next(item for item in result["artifacts"] if item["kind"] == "video")
    assert primary["metadata"]["sensorId"] == "hero"
    # Adopted camera uploads carry the streamed bytes verbatim.
    camera_uploads = [body for url, body, media_type, _headers in uploads if media_type == "video/mp4" and body == b"mp4-stream"]
    assert len(camera_uploads) == 3
    data_uploads = [body for _url, body, media_type, _headers in uploads if media_type == "application/zip"]
    assert len(data_uploads) == 2 and all(body.startswith(b"PK") for body in data_uploads)


def test_render_spec_rejects_frames_output_everywhere():
    # "frames" is no longer a render output anywhere in the CARLA lane: the
    # spec parser, the runtime requirements, and the lease reservation set all
    # fail closed on it.
    with pytest.raises(ContractError, match="renderSpec.outputs must contain unique supported values"):
        parse_lease(lease_value(outputs=["frames"]))
    value = lease_value(outputs=["trace"])
    value["job"]["executionPackage"]["runtimeRequirements"]["outputs"] = ["frames", "trace"]
    reseal_control(value["job"]["executionPackage"])
    with pytest.raises(ContractError, match="runtimeRequirements.outputs must be sorted, unique supported values"):
        parse_lease(value)


def test_video_lease_requires_a_reservation_for_every_non_primary_sensor():
    value = lease_value(outputs=["trace", "video"], sensors=VIDEO_TEST_SENSORS)
    del value["job"]["artifactUploads"]["sensorVideo:chase:ego:chase-cam:rgb"]
    with pytest.raises(ContractError, match="missing reservations: sensorVideo:chase:ego:chase-cam:rgb"):
        parse_lease(value)
    incomplete_data = lease_value(outputs=["trace", "video"], sensors=VIDEO_TEST_SENSORS)
    del incomplete_data["job"]["artifactUploads"]["sensorData:roof:ego:lidar-1:lidar"]
    with pytest.raises(ContractError, match="missing reservations: sensorData:roof:ego:lidar-1:lidar"):
        parse_lease(incomplete_data)


def test_camera_stream_encoder_fails_closed_on_zero_progress_wedge():
    from uniscenarios_carla_bridge.runtime.backend import (
        CAMERA_ENCODER_QUEUE_FRAMES,
        _CameraStreamEncoder,
    )
    encoder = object.__new__(_CameraStreamEncoder)
    encoder.sensor_key = "hero"
    encoder.error = None
    encoder.consumed = 0
    encoder.stall_deadline_s = 0.05
    encoder.queue = __import__("queue").Queue(maxsize=CAMERA_ENCODER_QUEUE_FRAMES)
    for index in range(CAMERA_ENCODER_QUEUE_FRAMES):
        encoder.submit(f"frame-{index}")
    # A full queue whose writer consumes NOTHING for the whole stall window is
    # a wedged encoder: the render still fails closed instead of hanging or
    # buffering unbounded.
    with pytest.raises(ContractError, match="backpressure budget.*no drain progress"):
        encoder.submit("frame-overflow")
    # A failed writer thread surfaces on the next capture instead of hanging.
    encoder.error = RuntimeError("ffmpeg died")
    with pytest.raises(RuntimeError, match="camera stream encoder hero failed"):
        encoder.submit("frame-after-error")


def test_camera_stream_encoder_slow_drain_extends_stall_window():
    # rc.64 field failure: a scheduler convoy stalled one writer >5s while
    # ffmpeg sat idle, so a fixed put-deadline failed a healthy render. Any
    # drain progress must restart the window: a writer slower than the stall
    # deadline per frame still lets capture proceed (throttled), because the
    # window measures zero-progress wedges, not encode speed.
    import queue as queue_module
    import threading as threading_module
    from time import sleep as time_sleep
    from uniscenarios_carla_bridge.runtime.backend import _CameraStreamEncoder
    encoder = object.__new__(_CameraStreamEncoder)
    encoder.sensor_key = "hero"
    encoder.error = None
    encoder.consumed = 0
    encoder.stall_deadline_s = 0.4
    encoder.queue = queue_module.Queue(maxsize=2)
    encoder.submit("frame-0")
    encoder.submit("frame-1")
    def slow_writer():
        # Consumes one frame every 0.3s: slower than capture, faster than the
        # 0.4s zero-progress window. Three frames guarantee > one window.
        for _ in range(3):
            time_sleep(0.3)
            encoder.queue.get()
            encoder.consumed += 1
    writer = threading_module.Thread(target=slow_writer)
    writer.start()
    try:
        encoder.submit("frame-2")  # waits ~0.3s for the first drain
        encoder.submit("frame-3")  # waits again; progress keeps resetting the window
    finally:
        writer.join()
    assert encoder.consumed == 3


def test_camera_stream_encoder_absorbs_transient_burst_within_deadline():
    # rc.63 regression: campaign renders failed instantly on a 4-frame burst
    # while ffmpeg sat at 6-10% CPU on an unsaturated host. A transient burst
    # must block the capture path briefly and succeed once the writer drains.
    import queue as queue_module
    import threading as threading_module
    from uniscenarios_carla_bridge.runtime.backend import (
        CAMERA_ENCODER_QUEUE_FRAMES,
        _CameraStreamEncoder,
    )
    encoder = object.__new__(_CameraStreamEncoder)
    encoder.sensor_key = "hero"
    encoder.error = None
    encoder.consumed = 0
    encoder.stall_deadline_s = 5.0
    encoder.queue = queue_module.Queue(maxsize=CAMERA_ENCODER_QUEUE_FRAMES)
    for index in range(CAMERA_ENCODER_QUEUE_FRAMES):
        encoder.submit(f"frame-{index}")
    drained = threading_module.Timer(0.05, encoder.queue.get)
    drained.start()
    try:
        encoder.submit("frame-burst")  # must not raise: the burst drains
    finally:
        drained.join()
    assert encoder.queue.full()


def test_camera_stream_encoder_surfaces_writer_death_instead_of_backpressure():
    # A writer that dies while capture waits on a full queue must surface the
    # writer's failure, not a misleading backpressure error.
    import queue as queue_module
    from uniscenarios_carla_bridge.runtime.backend import _CameraStreamEncoder
    encoder = object.__new__(_CameraStreamEncoder)
    encoder.sensor_key = "hero"
    encoder.error = None
    encoder.consumed = 0
    encoder.stall_deadline_s = 0.05
    encoder.queue = queue_module.Queue(maxsize=1)
    encoder.submit("frame-0")
    encoder.error = RuntimeError("ffmpeg died mid-wait")
    with pytest.raises(RuntimeError, match="camera stream encoder hero failed: ffmpeg died mid-wait"):
        encoder.submit("frame-1")


def test_presentation_video_encoder_selection(monkeypatch):
    from uniscenarios_carla_bridge.runtime.backend import _presentation_video_codec_args
    monkeypatch.delenv("UNISCENARIO_PRESENTATION_VIDEO_ENCODER", raising=False)
    default_args = _presentation_video_codec_args()
    assert "libx264" in default_args
    # x264 auto-threading spawns ~1.5x host cores of threads PER encoder;
    # multi-camera fleets ran thousands of idle threads and starved writers.
    assert default_args[default_args.index("-threads") + 1] == "2"
    monkeypatch.setenv("UNISCENARIO_PRESENTATION_VIDEO_ENCODER", "software")
    assert "libx264" in _presentation_video_codec_args()
    monkeypatch.setenv("UNISCENARIO_PRESENTATION_VIDEO_ENCODER", "nvidia")
    nvidia_args = _presentation_video_codec_args()
    assert "h264_nvenc" in nvidia_args and "-threads" not in nvidia_args
    monkeypatch.setenv("UNISCENARIO_PRESENTATION_VIDEO_ENCODER", "vhs")
    with pytest.raises(RuntimeError, match="must be software or nvidia"):
        _presentation_video_codec_args()


def test_camera_stream_encoder_round_trips_real_frames_through_ffmpeg(tmp_path, monkeypatch):
    from uniscenarios_carla_bridge.runtime.backend import _CameraStreamEncoder
    monkeypatch.delenv("UNISCENARIO_PRESENTATION_VIDEO_ENCODER", raising=False)
    destination = tmp_path / "stream.mp4"
    class Frame:
        def __init__(self, payload): self.raw_data = payload
        def convert(self, _converter): pytest.fail("converter must not run when None")
    encoder = _CameraStreamEncoder("hero", 64, 36, 25.0, None, destination)
    for _index in range(3):
        encoder.submit(Frame(bytes(64 * 36 * 4)))
    encoder.close()
    assert destination.is_file() and destination.stat().st_size > 0
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "json", str(destination)],
        capture_output=True, check=True,
    )
    assert json.loads(probe.stdout)["streams"][0]["nb_read_frames"] == "3"


def test_multi_actor_pedestrian_and_lifecycle_capability_gates():
    start = XOSC.index(b'<ManeuverGroup name="group"')
    end = XOSC.index(b'</ManeuverGroup>', start) + len(b'</ManeuverGroup>')
    second_group = XOSC[start:end].replace(b'group', b'ped_group').replace(b'actor_ego', b'actor_ped').replace(b'trajectory_ego', b'trajectory_ped')
    second_entity = b'<ScenarioObject name="actor_ped"><Pedestrian name="walker.pedestrian.0001" mass="80" pedestrianCategory="pedestrian"><Properties><Property name="uniscenario.actorId" value="ped"/><Property name="uniscenario.actorKind" value="pedestrian"/></Properties></Pedestrian></ScenarioObject>'
    multi = XOSC.replace(b'</Entities>', second_entity + b'</Entities>').replace(b'</Act>', second_group + b'</Act>')
    plan = compile_xosc14(multi)
    assert set(plan.actors) == {"ego", "ped"}
    add_entity = b'<GlobalAction><EntityAction entityRef="actor_ego"><AddEntityAction><Position><WorldPosition x="0" y="0" z="0"/></Position></AddEntityAction></EntityAction></GlobalAction>'
    unsupported = XOSC.replace(b'<Action name="follow">', b'<Action name="add">' + add_entity + b'</Action><Action name="follow">')
    with pytest.raises(ContractError, match="entity add"):
        compile_xosc14(unsupported)


def test_executes_every_ambient_expanded_actor_carried_by_the_bound_xosc():
    start = XOSC.index(b'<ManeuverGroup name="group"')
    end = XOSC.index(b'</ManeuverGroup>', start) + len(b'</ManeuverGroup>')
    second_group = XOSC[start:end].replace(b'group', b'ambient_group').replace(b'actor_ego', b'actor_ambient').replace(b'trajectory_ego', b'trajectory_ambient')
    second_entity = b'<ScenarioObject name="actor_ambient"><Vehicle name="uniscenarios_car" vehicleCategory="car"><Properties><Property name="uniscenario.actorId" value="ambient:v1:test"/><Property name="uniscenario.actorKind" value="car"/><Property name="uniscenarios.tag" value="ambient"/><Property name="uniscenarios.tag" value="catalog:vehicle.sedan"/></Properties></Vehicle></ScenarioObject>'
    expanded_xosc = XOSC.replace(b'</Entities>', second_entity + b'</Entities>').replace(b'</Act>', second_group + b'</Act>')
    expanded_manifest = execution_manifest(expanded_xosc)
    value = lease_value()
    value["job"]["executionPackage"]["xosc"].update({"sha256": digest(expanded_xosc), "sizeBytes": len(expanded_xosc)})
    lease = parse_lease(seal_lease(value, expanded_manifest))
    assets = {"memory:manifest": expanded_manifest, "memory:xosc": expanded_xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    uploaded = []
    execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda _url, body, _media_type, _headers: uploaded.append(artifact_bytes(body)),
    )
    assert ("spawn", ["ambient:v1:test", "ego"]) in backend.calls
    trace = json.loads(gzip.decompress(uploaded[0]))
    assert all(set(frame["actors"]) == {"ego", "ambient:v1:test"} for frame in trace["frames"])


def test_asset_transport_retries_transient_failures(monkeypatch):
    monkeypatch.setenv("UNISCENARIO_ASSET_DOWNLOAD_HOSTS", "example.invalid")
    monkeypatch.setenv("UNISCENARIO_ARTIFACT_UPLOAD_HOSTS", "example.invalid")
    calls = []
    class Response:
        status = 200
        read_once = False
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self, *_args):
            if self.read_once: return b""
            self.read_once = True
            return b"payload"
    def open_url(*_args, **_kwargs):
        calls.append(1)
        if len(calls) < 3:
            raise urllib.error.URLError("transient")
        return Response()
    monkeypatch.setattr(artifact_transport, "_open_artifact", open_url)
    monkeypatch.setattr(artifact_transport.time, "sleep", lambda _seconds: None)
    assert artifact_transport.download("https://example.invalid/asset", 100) == b"payload"
    assert len(calls) == 3
    calls.clear()
    artifact_transport.upload("https://example.invalid/upload", b"payload", "application/octet-stream")
    assert len(calls) == 3


def test_upload_forwards_every_required_signed_header_unchanged(monkeypatch):
    monkeypatch.setenv("UNISCENARIO_ARTIFACT_UPLOAD_HOSTS", "example.invalid")
    captured = []
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_args): return False
    def open_url(request, *_args, **_kwargs):
        captured.append(request)
        return Response()
    monkeypatch.setattr(artifact_transport, "_open_artifact", open_url)
    required = {
        "content-type": "video/mp4",
        "x-amz-checksum-sha256": "checksum-value=",
        "x-amz-sdk-checksum-algorithm": "SHA256",
    }
    artifact_transport.upload("https://example.invalid/upload", b"payload", "video/mp4", required)
    sent = {name.lower(): value for name, value in captured[0].header_items()}
    assert sent == {**required, "content-length": "7"}


def test_upload_failure_captures_only_bounded_safe_s3_xml(monkeypatch):
    monkeypatch.setenv("UNISCENARIO_ARTIFACT_UPLOAD_HOSTS", "signed.invalid")
    body = (
        b"<Error><Code>SignatureDoesNotMatch</Code><Message>signed headers differ</Message>"
        b"<RequestId>request-123</RequestId><Key>private/secret-object-key</Key></Error>"
    )
    error = urllib.error.HTTPError("https://signed.invalid/private", 403, "forbidden", {}, io.BytesIO(body))
    monkeypatch.setattr(artifact_transport, "_open_artifact", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(artifact_transport.ArtifactUploadError) as raised:
        artifact_transport.upload("https://signed.invalid/private", b"payload", "application/octet-stream")
    assert raised.value.status == 403
    assert raised.value.error_code == "SignatureDoesNotMatch"
    assert raised.value.request_id == "request-123"
    assert raised.value.body_bytes_captured == len(body)
    assert not raised.value.body_truncated
    assert "private/secret-object-key" not in str(raised.value)
    assert "signed.invalid" not in str(raised.value)


def test_transport_retries_share_one_absolute_deadline(monkeypatch):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(artifact_transport.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(artifact_transport.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    def operation():
        calls.append(clock[0])
        raise urllib.error.URLError("retry")
    with pytest.raises(TimeoutError, match="lease deadline"):
        artifact_transport._with_retries(operation, attempts=10, deadline_monotonic=lambda: 0.29)
    assert len(calls) == 2
    assert clock[0] <= 0.29


def test_path_upload_streams_without_read_bytes_and_checks_abort(monkeypatch, tmp_path):
    body = tmp_path / "large.zip"
    body.write_bytes(b"stream-me" * 200_000)
    monkeypatch.setattr(Path, "read_bytes", lambda _self: pytest.fail("large artifacts must never use read_bytes"))
    monkeypatch.setenv("UNISCENARIO_ARTIFACT_UPLOAD_HOSTS", "uploads.example.test")
    captured = bytearray()
    aborts = []

    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_args): return None
        def geturl(self): return "https://uploads.example.test/object"

    def open_request(request, _timeout, _environment):
        while chunk := request.data.read(64 * 1024):
            captured.extend(chunk)
        return Response()

    monkeypatch.setattr(artifact_transport, "_open_artifact", open_request)
    artifact_transport.upload(
        "https://uploads.example.test/object", body, "application/zip",
        deadline_monotonic=lambda: time.monotonic() + 30,
        abort=lambda: aborts.append(True),
    )
    assert bytes(captured) == b"stream-me" * 200_000
    assert aborts


def test_artifact_digest_is_bound_before_checksum_header_upload():
    body = b"render-output"
    digest_hex = hashlib.sha256(body).hexdigest()
    digest_base64 = __import__("base64").b64encode(bytes.fromhex(digest_hex)).decode()
    bindings = []
    uploads = []

    def authorize(kind, digest_value, size_bytes, media_type, reservation):
        bindings.append((kind, digest_value, size_bytes, media_type, reservation["uploadId"]))
        return {
            "uploadUrl": "memory:checksum-bound",
            "artifactUrl": "/api/uniscenario/artifact-uploads/usup-1",
            "requiredHeaders": {
                "content-type": "video/mp4",
                "x-amz-checksum-sha256": digest_base64,
                "x-amz-sdk-checksum-algorithm": "SHA256",
            },
        }

    artifact = worker_runner._artifact(
        "video",
        body,
        "video/mp4",
        {"uploadId": "usup-1", "artifactUrl": "unused", "uploadUrl": "unused"},
        lambda *args: uploads.append(args),
        authorize_upload=authorize,
    )

    assert bindings == [("video", digest_hex, len(body), "video/mp4", "usup-1")]
    assert uploads == [("memory:checksum-bound", body, "video/mp4", {
        "content-type": "video/mp4",
        "x-amz-checksum-sha256": digest_base64,
        "x-amz-sdk-checksum-algorithm": "SHA256",
    })]
    assert artifact["sha256"] == digest_hex


def test_collect_camera_video_adopts_stream_and_proves_frame_closure(monkeypatch, tmp_path):
    camera_dir = tmp_path / "frames" / "hero"
    camera_dir.mkdir(parents=True)
    (camera_dir / "stream.mp4").write_bytes(b"mp4")
    destination = tmp_path / "render.mp4"
    captured = []
    def run(command, _stage, _check_abort, _deadline):
        captured.append(command)
        assert command[0] == "ffprobe", "adopted streams must never re-encode"
        return type("Result", (), {"returncode": 0, "stderr": b"", "stdout": b'{"streams":[{"nb_read_frames":"1","duration":"0.033333"}]}'})()
    monkeypatch.setattr(worker_runner, "_run_process", run)
    assert worker_runner._collect_camera_video(
        tmp_path / "frames", "hero", 30, destination, 1, 1024, lambda *_args: None, lambda: float("inf"),
    ) == destination
    assert len(captured) == 1 and str(camera_dir / "stream.mp4") in captured[0]
    # A stream that is not frame-closed against the capture schedule fails.
    with pytest.raises(RuntimeError, match="not frame-closed"):
        worker_runner._collect_camera_video(
            tmp_path / "frames", "hero", 30, destination, 2, 1024, lambda *_args: None, lambda: float("inf"),
        )
    # A camera that never produced a stream fails closed.
    with pytest.raises(RuntimeError, match="no encoded video stream"):
        worker_runner._collect_camera_video(
            tmp_path / "frames", "missing", 30, destination, 1, 1024, lambda *_args: None, lambda: float("inf"),
        )
    monkeypatch.setattr(Path, "read_bytes", lambda _self: pytest.fail("video artifacts must stream from disk"))
    streamed = []
    artifact = worker_runner._artifact(
        "video", destination, "video/mp4",
        {"uploadUrl": "memory:video", "artifactUrl": "/video", "requiredHeaders": {"content-type": "video/mp4"}},
        lambda _url, body, *_args: streamed.append(body.open("rb").read()),
    )
    assert streamed == [b"mp4"]
    assert artifact["sizeBytes"] == 3


def test_subprocess_stages_share_deadline_and_second_stage_cannot_overrun(monkeypatch):
    clock = [0.0]
    work = [2.0, 1.0]
    timeouts = []

    class Process:
        def __init__(self, command, **_kwargs):
            self.command = command
            self.remaining = work.pop(0)
            self.returncode = 0
        def communicate(self, timeout=None):
            if timeout is None:
                return b"", b""
            timeouts.append(timeout)
            consumed = min(self.remaining, timeout)
            self.remaining -= consumed
            clock[0] += consumed
            if self.remaining > 0:
                raise subprocess.TimeoutExpired(self.command, timeout)
            return b"", b""
        def kill(self): self.returncode = -9

    monkeypatch.setattr(worker_runner.subprocess, "Popen", Process)
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    deadline = lambda: 2.5
    def check(stage, *_args):
        if clock[0] >= deadline():
            raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")
    worker_runner._run_process(["ffmpeg"], "encode_video", check, deadline)
    with pytest.raises(LeaseDeadlineExceeded, match="probe_video"):
        worker_runner._run_process(["ffprobe"], "probe_video", check, deadline)
    assert clock[0] == 2.5
    assert timeouts[-1] == 0.5


def test_rejects_digest_mismatch_before_backend_execution():
    value = lease_value()
    value["job"]["executionPackage"]["xosc"]["sha256"] = "0" * 64
    lease = parse_lease(seal_lease(value))
    backend = FakeBackend()
    with pytest.raises(ContractError, match="manifest XOSC file does not match|digest mismatch"):
        execute_lease(lease, backend, lambda _: {}, downloader=lambda url, _: {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}[url])
    assert backend.calls == []


def test_rejects_missing_source_input_digest_at_lease_boundary():
    value = lease_value()
    del value["job"]["executionPackage"]["sourceInputDigest"]
    reseal_control(value["job"]["executionPackage"])
    with pytest.raises(ContractError, match="invalid fields"):
        parse_lease(value)


def test_rejects_stale_manifest_source_input_digest_before_backend_execution():
    stale_manifest = execution_manifest(source_input_digest="d" * 64)
    lease = parse_lease(seal_lease(lease_value(), stale_manifest))
    assets = {"memory:manifest": stale_manifest, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    with pytest.raises(ContractError, match="manifest source input digest"):
        execute_lease(lease, backend, lambda _: {}, downloader=lambda url, _: assets[url])
    assert backend.calls == []


def test_rejects_xosc_source_input_digest_tamper_before_backend_execution():
    tampered_xosc = XOSC.replace(SOURCE_INPUT_DIGEST.encode(), ("d" * 64).encode())
    tampered_manifest = execution_manifest(tampered_xosc)
    value = lease_value()
    value["job"]["executionPackage"]["xosc"].update({"sha256": digest(tampered_xosc), "sizeBytes": len(tampered_xosc)})
    lease = parse_lease(seal_lease(value, tampered_manifest))
    assets = {"memory:manifest": tampered_manifest, "memory:xosc": tampered_xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    with pytest.raises(ContractError, match="OpenSCENARIO source input digest"):
        execute_lease(lease, backend, lambda _: {}, downloader=lambda url, _: assets[url])
    assert backend.calls == []


def test_control_digest_closes_every_non_transport_package_field():
    value = lease_value()
    value["job"]["executionPackage"]["xodr"]["sizeBytes"] += 1
    with pytest.raises(ContractError, match="control digest mismatch"):
        parse_lease(value)


def test_control_digest_matches_cross_language_ecmascript_golden_vector():
    value = {
        "😀": "astral",
        "\ue000": "bmp-private",
        "nested": [-0.0, 1e-7, 0.000001, 1e20, 1e21, {"z": "é", "a": "雪"}],
    }
    assert canonical_json(value) == '{"nested":[0,1e-7,0.000001,100000000000000000000,1e+21,{"a":"雪","z":"é"}],"😀":"astral","":"bmp-private"}'
    assert canonical_sha256(value) == "e20e546bc8e08a393e67da60d1146768fd39836d0a6e625085ce8a8909ac1302"
    assert canonical_sha256(json.loads(canonical_json(value))) == canonical_sha256(value)


def test_runtime_requirements_must_match_the_leased_render():
    value = lease_value()
    package = value["job"]["executionPackage"]
    package["runtimeRequirements"]["executionMode"] = "diagnostic-replay"
    reseal_control(package)
    with pytest.raises(ContractError, match="runtimeRequirements do not match"):
        parse_lease(value)


def test_execution_manifest_mismatch_is_rejected_before_backend_execution():
    malformed = json.loads(MANIFEST)
    malformed["map"]["xodrSha256"] = "0" * 64
    body = json.dumps(malformed, sort_keys=True, separators=(",", ":")).encode()
    value = seal_lease(lease_value(), body)
    lease = parse_lease(value)
    assets = {"memory:manifest": body, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    with pytest.raises(ContractError, match="manifest map digest"):
        execute_lease(
            lease, backend, lambda _body: {},
            downloader=lambda url, _limit: assets[url], uploader=lambda *_args: None,
        )
    assert backend.calls == []


def test_deadline_aborts_before_downloading_or_starting_carla():
    lease = parse_lease(lease_value())
    backend = FakeBackend()
    with pytest.raises(LeaseDeadlineExceeded, match="download_manifest"):
        execute_lease(
            lease, backend, lambda _body: {},
            downloader=lambda *_args: pytest.fail("deadline must be checked before download"),
            uploader=lambda *_args: None,
            deadline_monotonic=0,
        )
    assert backend.calls == []


def test_execution_fence_checks_deadline_per_chunk_but_throttles_remote_heartbeats(monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    polls = []
    fence = worker_runner._ExecutionFence(lambda: 20.0, lambda payload: polls.append(payload) or False)
    for index in range(4096):
        fence.check("hash_trace", index, 4096)
    assert len(polls) == 1
    clock[0] = 15.0
    fence.check("hash_trace", 4096, 4096)
    assert len(polls) == 2
    clock[0] = 20.0
    with pytest.raises(LeaseDeadlineExceeded, match="hash_trace"):
        fence.check("hash_trace", 4096, 4096)
    assert len(polls) == 2


def test_expiry_inside_actor_spawn_cleans_up_without_binding_or_upload(monkeypatch):
    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    clock = [0.0]
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    class ExpiringSpawnBackend(FakeBackend):
        def spawn(self, actors, first_frame, catalog, abort=None):
            self.calls.append(("spawn-one", next(iter(actors))))
            clock[0] = 2.0
            (abort or (lambda: None))()
    backend = ExpiringSpawnBackend()
    with pytest.raises(LeaseDeadlineExceeded, match="spawn_actors"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: pytest.fail("expired spawn must not upload"),
            authorize_upload=lambda *_args: pytest.fail("expired spawn must not bind an upload"),
            deadline_monotonic=lambda: 1.0,
        )
    assert backend.calls[-1] == ("cleanup",)
    assert not any(call[0] in {"prepare", "sensors"} for call in backend.calls)


def test_expiry_inside_native_stability_cleans_up_without_binding_or_upload(monkeypatch):
    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    clock = [0.0]
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    class ExpiringStabilityBackend(FakeBackend):
        def prepare_scenario(self, first_frame, abort=None):
            self.calls.append(("stability-tick", 1))
            clock[0] = 2.0
            (abort or (lambda: None))()
    backend = ExpiringStabilityBackend()
    with pytest.raises(LeaseDeadlineExceeded, match="prepare_scenario"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: pytest.fail("expired stability wait must not upload"),
            authorize_upload=lambda *_args: pytest.fail("expired stability wait must not bind an upload"),
            deadline_monotonic=lambda: 1.0,
        )
    assert backend.calls[-1] == ("cleanup",)
    assert any(call[0] == "sensors" for call in backend.calls)
    assert not any(call[0] == "apply" for call in backend.calls)


def test_cancellation_during_trace_serialization_never_binds_or_uploads():
    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    backend = FakeBackend()
    with pytest.raises(CancellationRequested, match="control plane"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: pytest.fail("cancelled serialization must not upload"),
            authorize_upload=lambda *_args: pytest.fail("cancelled serialization must not bind an upload"),
            control=lambda payload: payload["stage"] == "serialize_trace",
        )
    assert backend.calls[-1] == ("cleanup",)


def test_cancellation_inside_execute_actor_loop_cleans_up_without_binding_or_upload(monkeypatch):
    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    clock = [0.0]
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    execute_polls = 0
    def control(payload):
        nonlocal execute_polls
        if payload["stage"] == "execute":
            execute_polls += 1
            return execute_polls == 2
        return False
    class SlowActorBackend(FakeBackend):
        def apply(self, frame, abort=None):
            self.calls.append(("actor-rpc", 1))
            clock[0] += 5.0
            (abort or (lambda: None))()
            pytest.fail("cancelled actor loop must stop before the next RPC")
    backend = SlowActorBackend()
    with pytest.raises(CancellationRequested, match="control plane"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: pytest.fail("cancelled actor loop must not upload"),
            authorize_upload=lambda *_args: pytest.fail("cancelled actor loop must not bind an upload"),
            control=control,
            deadline_monotonic=lambda: 100.0,
        )
    assert execute_polls == 2
    assert backend.calls[-1] == ("cleanup",)


def test_expiry_during_missing_sensor_wait_cleans_up_without_binding_or_upload(monkeypatch):
    lease = parse_lease(lease_value())
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    clock = [0.0]
    monkeypatch.setattr(worker_runner.time, "monotonic", lambda: clock[0])
    class MissingSensorBackend(FakeBackend):
        def tick(self, capture=None, abort=None):
            self.calls.append(("sensor-wait", 1))
            clock[0] += 0.25
            (abort or (lambda: None))()
            pytest.fail("expired sensor wait must stop at its bounded poll")
    backend = MissingSensorBackend()
    with pytest.raises(LeaseDeadlineExceeded, match="execute"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: pytest.fail("expired sensor wait must not upload"),
            authorize_upload=lambda *_args: pytest.fail("expired sensor wait must not bind an upload"),
            deadline_monotonic=lambda: 0.2,
        )
    assert backend.calls[-1] == ("cleanup",)


def test_carla_missing_sensor_wait_checks_abort_at_most_every_quarter_second():
    waits = []
    class FakeCondition:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def wait(self, timeout): waits.append(timeout)
    backend = object.__new__(CarlaBackend)
    backend.sensor_configs = {"hero": {}}
    backend.sensor_timeout_s = 10.0
    backend.sensor_condition = FakeCondition()
    backend.sensor_error = None
    backend.sensor_pending = {}
    checks = 0
    def abort():
        nonlocal checks
        checks += 1
        if checks == 2:
            raise LeaseDeadlineExceeded("expired in sensor wait")
    with pytest.raises(LeaseDeadlineExceeded, match="sensor wait"):
        backend._capture_world_frame(42, {"outputFrameIndex": 0, "scheduledTimeS": 0.0}, abort)
    assert waits == [0.25]


def test_slow_heartbeat_never_blocks_arriving_sensor_callback(tmp_path):
    backend = object.__new__(CarlaBackend)
    lock = Lock()
    backend.sensor_lock = lock
    backend.sensor_condition = Condition(lock)
    backend.video_fps = 25.0
    backend.fixed_timestep_s = 0.02
    backend.sensor_configs = {"hero": {
        "target": tmp_path, "role": "primary", "actorId": None, "sensorId": "hero",
        "modality": "rgb", "converter": None, "extension": "png",
        "transform": {}, "config": {"width": 640, "height": 360, "fov": 90},
        "encoder": _FakeStreamEncoder(tmp_path / "stream.mp4"),
    }}
    backend.sensor_writer_workers = 1
    backend.sensor_writer_pool = None
    backend.sensor_timeout_s = 0.5
    backend.sensor_error = None
    backend.sensor_pending = {}
    backend.sensor_last_frame = {}
    backend.sensor_closed = False
    backend.sensor_records = []
    backend.capture_disk_bytes = 0
    backend.max_capture_disk_bytes = 1_000_000
    heartbeat_started = __import__("threading").Event()
    release_heartbeat = __import__("threading").Event()
    checks = 0
    errors = []
    def abort():
        nonlocal checks
        checks += 1
        if checks == 2:
            heartbeat_started.set()
            assert release_heartbeat.wait(1.0)
    class Image:
        frame = 42
        timestamp = 1.25
        def save_to_disk(self, target): Path(target).write_bytes(b"png")
    def run_capture():
        try:
            backend._capture_world_frame(42, {"outputFrameIndex": 0, "scheduledTimeS": 1.25}, abort)
        except BaseException as exc:  # noqa: BLE001 - propagate thread failure to the test.
            errors.append(exc)
    capture = Thread(target=run_capture)
    capture.start()
    assert heartbeat_started.wait(1.0)
    callback = Thread(target=backend._receive_sensor_frame, args=("hero", Image()))
    callback.start()
    callback.join(0.2)
    assert not callback.is_alive(), "sensor callback must acquire its lock while heartbeat is blocked"
    release_heartbeat.set()
    capture.join(1.0)
    assert not capture.is_alive()
    assert errors == []
    assert backend.sensor_records[0]["carlaFrame"] == 42


def test_cancellation_after_sensor_wait_does_not_lock_out_callback():
    backend = object.__new__(CarlaBackend)
    lock = Lock()
    backend.sensor_lock = lock
    backend.sensor_condition = Condition(lock)
    backend.sensor_configs = {"hero": {}}
    backend.sensor_timeout_s = 1.0
    backend.sensor_error = None
    backend.sensor_pending = {}
    backend.sensor_last_frame = {}
    backend.sensor_closed = False
    started = __import__("threading").Event()
    release = __import__("threading").Event()
    errors = []
    checks = 0
    def abort():
        nonlocal checks
        checks += 1
        if checks == 2:
            started.set()
            assert release.wait(1.0)
            raise CancellationRequested("cancelled after sensor wait")
    def run_capture():
        try:
            backend._capture_world_frame(42, {"outputFrameIndex": 0, "scheduledTimeS": 0.0}, abort)
        except BaseException as exc:  # noqa: BLE001 - propagate thread failure to the test.
            errors.append(exc)
    capture = Thread(target=run_capture)
    capture.start()
    assert started.wait(1.0)
    image = type("Image", (), {"frame": 42})()
    callback = Thread(target=backend._receive_sensor_frame, args=("hero", image))
    callback.start()
    callback.join(0.2)
    assert not callback.is_alive()
    release.set()
    capture.join(1.0)
    assert not capture.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], CancellationRequested)


def test_non_capture_tick_fence_never_locks_out_sensor_callback():
    backend = object.__new__(CarlaBackend)
    lock = Lock()
    backend.sensor_lock = lock
    backend.sensor_condition = Condition(lock)
    backend.sensor_configs = {"hero": {}}
    backend.sensor_error = None
    backend.sensor_pending = {1: {"hero": object()}}
    backend.sensor_last_frame = {}
    backend.sensor_closed = False
    backend.actors = {}
    backend.world = type("World", (), {"tick": lambda _self: 42})()
    fence_started = __import__("threading").Event()
    release_fence = __import__("threading").Event()
    errors = []
    checks = 0
    def abort():
        nonlocal checks
        checks += 1
        if checks == 3:
            fence_started.set()
            assert release_fence.wait(1.0)
    def run_tick():
        try:
            backend.tick(abort=abort)
        except BaseException as exc:  # noqa: BLE001 - propagate thread failure to the test.
            errors.append(exc)
    tick = Thread(target=run_tick)
    tick.start()
    assert fence_started.wait(1.0)
    callback = Thread(target=backend._receive_sensor_frame, args=("hero", type("Image", (), {"frame": 43})()))
    callback.start()
    callback.join(0.2)
    assert not callback.is_alive(), "non-capture fence must run after releasing the callback lock"
    release_fence.set()
    tick.join(1.0)
    assert not tick.is_alive()
    assert errors == []
    assert 1 not in backend.sensor_pending and 43 in backend.sensor_pending


def test_backend_never_calls_fence_under_sensor_locks():
    tree = ast.parse(textwrap.dedent(inspect.getsource(CarlaBackend)))
    violations = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.With, ast.AsyncWith)):
            continue
        sensor_lock = any(
            isinstance(item.context_expr, ast.Attribute)
            and item.context_expr.attr in {"sensor_condition", "sensor_lock"}
            for item in node.items
        )
        if not sensor_lock:
            continue
        for child in ast.walk(ast.Module(body=node.body, type_ignores=[])):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id == "check":
                violations.append(child.lineno)
    assert violations == []


def test_streamed_camera_video_and_artifacts_share_one_peak_temp_budget(monkeypatch):
    lease = parse_lease(lease_value(outputs=["trace", "video"]))
    assets = {"memory:manifest": MANIFEST, "memory:xosc": XOSC, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    monkeypatch.setattr(worker_runner, "MAX_OUTPUT_BYTES", 1_100_000)
    class LargeStreamBackend(FakeBackend):
        def tick(self, capture=None, abort=None):
            (abort or (lambda: None))()
            self.calls.append(("tick", self.frame.index))
            if capture is not None:
                sensor_key = "primary:ego:hero:rgb"
                target = self.output_dir / sensor_key
                target.mkdir(parents=True, exist_ok=True)
                (target / "stream.mp4").write_bytes(b"x" * 1_200_000)
                self.records.append({
                    "artifactName": sensor_key, "role": "primary", "actorId": "ego",
                    "sensorId": "hero", "modality": "rgb", "outputFrameIndex": 0,
                    "scheduledTimeS": 0.0, "carlaFrame": 1, "actualCarlaTimeS": 0.0,
                    "relativePath": f"{sensor_key}/stream.mp4",
                })
            return {
                actor_id: {"x": state.x, "y": state.y, "z": state.z, "headingDeg": state.heading_deg, "speedMps": state.speed_mps}
                for actor_id, state in self.frame.actors.items()
            }
    backend = LargeStreamBackend()
    uploaded = []
    with pytest.raises(ContractError, match="shared temporary-disk budget"):
        execute_lease(
            lease, backend,
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda url, *_args: uploaded.append(url),
        )
    assert uploaded == []
    assert backend.calls[-1] == ("cleanup",)


def test_duration_frame_pixel_sensor_and_output_budgets(monkeypatch):
    lease = parse_lease(lease_value())
    too_long = ExecutionPlan(
        "uniscenario.execution-plan/v1", 0.02, {},
        (PlanFrame(0, 0.0, {}, {}), PlanFrame(1, 300.02, {}, {})), "a" * 64,
    )
    with pytest.raises(ContractError, match="scenario duration"):
        worker_runner._enforce_render_budgets(lease, too_long, 1)
    short = ExecutionPlan(
        "uniscenario.execution-plan/v1", 0.02, {},
        (PlanFrame(0, 0.0, {}, {}), PlanFrame(1, 1.0, {}, {})), "a" * 64,
    )
    with pytest.raises(ContractError, match="capture exceeds 18000 frames"):
        worker_runner._enforce_render_budgets(lease, short, 18_001)
    monkeypatch.setattr(worker_runner, "MAX_SENSOR_PIXELS", 640 * 360 * 18_000 - 1)
    with pytest.raises(ContractError, match="sensor pixels"):
        worker_runner._enforce_render_budgets(lease, short, 18_000)

    sensor_heavy = lease_value()
    sensor_heavy["job"]["renderSpec"]["sensors"] = [
        {
            "role": f"capture-{index}", "actorId": "ego", "sensorId": f"camera-{index}",
            "modality": "rgb",
            "transform": {"x": 0, "y": 0, "z": 2, "pitch": 0, "yaw": 0, "roll": 0},
            "config": {"width": 640, "height": 360, "fov": 90},
        }
        for index in range(65)
    ]
    sensor_heavy = seal_lease(sensor_heavy)
    with pytest.raises(ContractError, match="1..64 sensors"):
        parse_lease(sensor_heavy)

    invalid_resources = lease_value()
    invalid_resources["job"]["executionPackage"]["runtimeRequirements"]["resources"]["actors"] = 257
    reseal_control(invalid_resources["job"]["executionPackage"])
    with pytest.raises(ContractError, match="resources.actors must be between 1 and 256"):
        parse_lease(invalid_resources)

    monkeypatch.setattr(worker_runner, "MAX_ARTIFACT_BYTES", 3)
    with pytest.raises(ContractError, match="artifact trace"):
        worker_runner._enforce_output_budget(0, b"four", "trace")
    monkeypatch.setattr(worker_runner, "MAX_ARTIFACT_BYTES", 100)
    monkeypatch.setattr(worker_runner, "MAX_OUTPUT_BYTES", 3)
    with pytest.raises(ContractError, match="render outputs"):
        worker_runner._enforce_output_budget(2, b"xx", "trace")


def test_duration_and_output_budgets_fail_before_expensive_allocation(monkeypatch, tmp_path):
    too_long = XOSC.replace(b'time="0.04"', b'time="300.02"')
    monkeypatch.setattr(worker_compiler, "PlanFrame", lambda *_args: pytest.fail("frames must not allocate"))
    with pytest.raises(ContractError, match="scenario duration"):
        worker_compiler.compile_xosc14(too_long)

    # Camera streams are budget-checked before any ffprobe/copy work starts.
    camera_dir = tmp_path / "hero"
    camera_dir.mkdir()
    (camera_dir / "stream.mp4").write_bytes(b"four")
    monkeypatch.setattr(worker_runner, "_run_process", lambda *_args, **_kwargs: pytest.fail("ffprobe must not start"))
    with pytest.raises(ContractError, match="exceeds its output budget"):
        worker_runner._collect_camera_video(
            tmp_path, "hero", 30, tmp_path / "render.mp4", 1, 3, lambda *_args: None, lambda: float("inf"),
        )


def test_worker_validator_pins_official_schema_and_rejects_invalid_xml():
    xsd = Path(__file__).parents[1] / "uniscenarios_carla_bridge" / "assets" / "OpenSCENARIO.xsd"
    assert digest(xsd.read_bytes()) == OFFICIAL_XSD_SHA256
    with pytest.raises(ContractError, match="XSD validation failed"):
        validate_xosc14(b"<OpenSCENARIO/>", xsd)


def test_validator_rejects_entity_expansion_without_starting_xmllint(monkeypatch):
    xsd = Path(__file__).parents[1] / "uniscenarios_carla_bridge" / "assets" / "OpenSCENARIO.xsd"
    monkeypatch.setattr(worker_validation.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("xmllint must not start"))
    payload = b'<!DOCTYPE x [<!ENTITY boom "boom">]><OpenSCENARIO>&boom;</OpenSCENARIO>'
    with pytest.raises(ContractError, match="DTD and entity declarations"):
        validate_xosc14(payload, xsd)


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-16-be", "utf-32"])
def test_validator_rejects_non_utf8_dtd_before_any_parser(monkeypatch, encoding):
    xsd = Path(__file__).parents[1] / "uniscenarios_carla_bridge" / "assets" / "OpenSCENARIO.xsd"
    monkeypatch.setattr(worker_validation.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("xmllint must not start"))
    payload = '<!DoCtYpE x [<!EnTiTy boom "boom">]><OpenSCENARIO>&boom;</OpenSCENARIO>'.encode(encoding)
    with pytest.raises(ContractError, match="must be UTF-8"):
        validate_xosc14(payload, xsd)
    with pytest.raises(ContractError, match="must be UTF-8"):
        compile_xosc14(payload)


def test_validator_has_a_bounded_timeout(monkeypatch):
    xsd = Path(__file__).parents[1] / "uniscenarios_carla_bridge" / "assets" / "OpenSCENARIO.xsd"
    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("xmllint", 1)
    monkeypatch.setattr(worker_validation.subprocess, "run", timeout)
    monkeypatch.setenv("UNISCENARIO_XML_VALIDATION_TIMEOUT_S", "1")
    with pytest.raises(ContractError, match="exceeded 1 seconds"):
        validate_xosc14(XOSC, xsd)


def test_asset_allowlist_rejects_ssrf_and_redirect_destinations(monkeypatch):
    with pytest.raises(ValueError, match="HTTPS"):
        artifact_transport.download("http://169.254.169.254/latest/meta-data", 100)
    with pytest.raises(ValueError, match="not allowed"):
        artifact_transport.download("https://169.254.169.254/latest/meta-data", 100)
    monkeypatch.setenv("UNISCENARIO_ASSET_DOWNLOAD_HOSTS", "assets.example.test")
    handler = artifact_transport._AllowlistedRedirectHandler("UNISCENARIO_ASSET_DOWNLOAD_HOSTS")
    with pytest.raises(ValueError, match="not allowed"):
        handler.redirect_request(None, None, 302, "redirect", {}, "https://169.254.169.254/latest/meta-data")
    class Redirected:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def geturl(self): return "https://169.254.169.254/latest/meta-data"
        def read(self, *_args): return b"secret"
    monkeypatch.setattr(artifact_transport, "_open_artifact", lambda *_args, **_kwargs: Redirected())
    with pytest.raises(ValueError, match="not allowed"):
        artifact_transport.download("https://assets.example.test/object", 100)


def test_independent_worker_has_no_legacy_runtime_dependency():
    package = Path(__file__).parents[1] / "uniscenarios_carla_bridge"
    forbidden = (
        "WorkerApi",
        "/api/uniscenario/internal",
        "UNISCENARIO_API_URL",
        "services/carla-worker",
        "carla_worker",
    )
    for path in package.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        text = path.read_text(errors="ignore")
        for marker in forbidden:
            assert marker not in text, f"cloud or legacy marker {marker!r} in {path}"


# --------------------------------------------------------------------------
# Cross-language conformance corpus.
#
# These are the public writer/runtime contract fixtures shipped by the exact
# versioned `@uniscenarios/openscenario` package in this release stack.
# Compiling those bytes here catches writer/interpreter disagreement without a
# private product-repository copy.
# --------------------------------------------------------------------------

GOLDEN_DIR = Path(__file__).resolve().parents[3] / "packages/openscenario/conformance"


def golden(name: str) -> bytes:
    path = GOLDEN_DIR / f"{name}.xosc"
    assert path.is_file(), f"missing published UniScenarios conformance fixture {path}"
    return path.read_bytes()


def test_writer_goldens_compile_and_are_deterministic():
    for name in ("signal-indications", "appearance-sets", "actor-despawn"):
        raw = golden(name)
        plan = compile_xosc14(raw)
        assert plan.frames, name
        assert plan.frames[0].t == 0.0, name
        assert plan.sha256 == compile_xosc14(raw).sha256, name


def test_writer_golden_carries_every_signal_indication_the_worker_accepts():
    plan = compile_xosc14(golden("signal-indications"))
    observed = {state for frame in plan.frames for state in frame.signals.values()}
    # The writer can emit exactly `CONTROL_INDICATIONS`; the golden covers all of
    # them; the interpreter must accept the same set, no more and no less.
    assert observed == set(SIGNAL_INDICATIONS)
    # And every accepted indication must resolve to real CARLA hardware, or
    # `CarlaBackend.apply` would raise mid-render on a scenario that compiled.
    for indication in SIGNAL_INDICATIONS:
        assert resolve_signal_lamp(indication, 0.0) in {"red", "yellow", "green", "off"}
        assert set(SIGNAL_LAMP_BY_INDICATION) == set(SIGNAL_INDICATIONS)


@pytest.mark.parametrize("indication,lamp", [("flashing_red", "red"), ("flashing_yellow", "yellow")])
def test_flashing_indications_alternate_against_off(indication, lamp):
    assert resolve_signal_lamp(indication, 0.0) == lamp
    assert resolve_signal_lamp(indication, 0.4) == lamp
    assert resolve_signal_lamp(indication, 0.5) == "off"
    assert resolve_signal_lamp(indication, 0.9) == "off"
    assert resolve_signal_lamp(indication, 1.0) == lamp
    # A steady indication never blinks.
    assert {resolve_signal_lamp("red", t / 10) for t in range(20)} == {"red"}


def test_writer_golden_appearance_sets_latch_onto_actor_frames():
    plan = compile_xosc14(golden("appearance-sets"))
    ego = plan.frames[-1].actors["ego"].appearance
    assert ego == {
        # `lights.indicator` writes all three lamps, so the trailing `off` set
        # leaves no stale hazard or indicator latched.
        "light.indicatorLeft": "off",
        "light.indicatorRight": "off",
        "light.warningLights": "off",
        "light.brakeLights": "on",
        "light.reversingLights": "on",
        "light.specialPurposeLights": "flashing",
        # `lights.headlights` is the same shape of selector: the golden authors
        # off -> drl -> high -> low, and the trailing `low` must leave the high
        # beam explicitly off rather than latched on from the previous set.
        "light.daytimeRunningLights": "on",
        "light.lowBeam": "on",
        "light.highBeam": "off",
        "door.doorFrontLeft": "open",
        "door.doorFrontRight": "open",
        "cue.uniscenarios:audio.horn:true": "requested",
        "cue.uniscenarios:pose.stopArm:extended": "requested",
    }
    assert plan.frames[-1].actors["walker"].appearance == {
        "cue.uniscenarios:pose.gesture:halt": "requested",
        "cue.uniscenarios:pose.headingLookDeg:-30": "requested",
        "cue.uniscenarios:pose.paddle:stop": "requested",
    }
    # Latching is monotonic in time: nothing is set before its trigger fires.
    assert plan.frames[0].actors["ego"].appearance == {}
    # Only the CARLA-executable half is claimed as rendered.
    capability = worker_runner._appearance_capability(plan)
    assert capability["rendered"] == sorted(key for key in ego if not key.startswith("cue."))
    assert capability["unrenderedCues"] == [
        "cue.uniscenarios:audio.horn:true",
        "cue.uniscenarios:pose.gesture:halt",
        "cue.uniscenarios:pose.headingLookDeg:-30",
        "cue.uniscenarios:pose.paddle:stop",
        "cue.uniscenarios:pose.stopArm:extended",
    ]
    assert capability["despawnedActors"] == []


def test_writer_golden_despawn_retires_only_the_absent_actor():
    plan = compile_xosc14(golden("actor-despawn"))
    # The fixture also authors a never-present `ghost`. The writer must omit it,
    # because a ScenarioObject with no Init pose is still — correctly — a
    # rejected package; there is no executable way to introduce it mid-clip.
    assert set(plan.actors) == {"ego", "leaver"}
    lifecycles = {
        actor_id: [frame.actors[actor_id].lifecycle for frame in plan.frames]
        for actor_id in plan.actors
    }
    assert set(lifecycles["ego"]) == {"spawn", "active"}
    assert lifecycles["leaver"][0] == "spawn"
    absent_from = lifecycles["leaver"].index("absent")
    assert plan.frames[absent_from].t == pytest.approx(1.0)
    assert set(lifecycles["leaver"][absent_from:]) == {"absent"}
    assert worker_runner._appearance_capability(plan)["despawnedActors"] == ["leaver"]


def test_absent_actors_are_excluded_from_parity_but_not_from_readback_closure():
    plan = compile_xosc14(golden("actor-despawn"))
    accumulator = ParityAccumulator({})
    for frame in plan.frames:
        accumulator.observe(frame, {
            actor_id: {
                # A despawned actor is parked 1000 m down; parity must not see it.
                "x": state.x, "y": state.y,
                "z": state.z - 1000.0 if state.lifecycle == "absent" else state.z,
                "headingDeg": state.heading_deg, "speedMps": state.speed_mps,
            }
            for actor_id, state in frame.actors.items()
        })
    report = accumulator.report()
    assert report.accepted, report.max_error
    # One fewer sample per frame from the despawn onwards.
    assert report.samples < 2 * len(plan.frames)


class _AppearanceVehicle:
    """Enough of `carla.Vehicle` to observe light/door/despawn writes."""

    type_id = "vehicle.lincoln.mkz"

    def __init__(self):
        self.light_state = 0
        self.doors = []
        self.physics = True
        self.transform = None
        self.velocities = []
        self.controls = []
        self.destroy_calls = 0

    def get_light_state(self): return self.light_state
    def set_light_state(self, value): self.light_state = int(value)
    def open_door(self, door): self.doors.append(("open", door))
    def close_door(self, door): self.doors.append(("close", door))
    def set_simulate_physics(self, value): self.physics = value
    def set_transform(self, transform): self.transform = transform
    def set_target_velocity(self, value): self.velocities.append(value)
    def set_target_angular_velocity(self, value): self.velocities.append(value)
    def get_velocity(self): return _AppearanceVector(0, 0, 0)
    def get_transform(self): return self.transform
    def apply_control(self, control): self.controls.append(control)
    def destroy(self):
        self.destroy_calls += 1
        return True


class _AppearanceVector:
    def __init__(self, x=0.0, y=0.0, z=0.0): self.x, self.y, self.z = x, y, z


def _appearance_backend():
    # These mirror the real CARLA 0.10.0 bindings EXACTLY, verified by
    # introspecting the baked wheel. A fake that is more capable than the real
    # API, or that renumbers it, makes the suite green against a fiction: the
    # previous `LightState` used 1/2/4/8/16 for LeftBlinker/RightBlinker/Brake/
    # Reverse/Special1, so a test asserting "bit 32 is unowned" was asserting it
    # about a value that is really LeftBlinker -- an owned bit. If you add a
    # member here, confirm it exists in the wheel first.
    class LightState(int):
        NONE = 0
        Position, LowBeam, HighBeam, Brake = 1, 2, 4, 8
        RightBlinker, LeftBlinker, Reverse, Fog = 16, 32, 64, 128
        Interior, Special1, Special2 = 256, 512, 1024
        All = 4294967295
    class Door:
        # No Trunk and no Hood: the binding exports exactly these five.
        FL, FR, RL, RR, All = 0, 1, 2, 3, 6
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class Carla: pass
    Carla.VehicleLightState, Carla.VehicleDoor = LightState, Door
    Carla.Vector3D, Carla.Location, Carla.Rotation, Carla.Transform = (
        _AppearanceVector, _AppearanceVector, Rotation, Transform,
    )
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.absent_actors = set()
    backend.door_states = {}
    return backend


def test_appearance_fakes_are_not_more_capable_than_the_real_carla_bindings():
    """Pin the fakes to the real API surface, in both directions.

    A mock that is MORE capable than the runtime makes the suite green against a
    fiction. That is not hypothetical here: the door fake used to carry `Trunk`,
    which `carla.VehicleDoor` does not export, so `door.trunk` was "tested" even
    though it raised `RuntimeError` on every real render. These values were
    verified by introspecting the baked wheel
    (`uniscenario-render-worker-dev:current`, CARLA 0.10.0).
    """
    real_door_members = {"FL": 0, "FR": 1, "RL": 2, "RR": 3, "All": 6}
    real_light_members = {
        "NONE": 0, "Position": 1, "LowBeam": 2, "HighBeam": 4, "Brake": 8,
        "RightBlinker": 16, "LeftBlinker": 32, "Reverse": 64, "Fog": 128,
        "Interior": 256, "Special1": 512, "Special2": 1024, "All": 4294967295,
    }
    backend = _appearance_backend()
    door_cls, light_cls = backend.carla.VehicleDoor, backend.carla.VehicleLightState

    def declared(cls):
        return {name: getattr(cls, name) for name in vars(cls) if not name.startswith("_")}

    assert declared(door_cls) == real_door_members
    assert declared(light_cls) == real_light_members

    # Nothing this worker can ask for may be missing from the runtime. `Trunk`
    # and `Hood` are exactly what this catches: the C++ enum has them, the Python
    # binding does not, so they must never appear in the door table.
    assert set(VEHICLE_DOOR_MEMBERS.values()) <= set(real_door_members)
    assert "trunk" not in VEHICLE_DOOR_MEMBERS
    for members in VEHICLE_LIGHT_BITS.values():
        assert set(members) <= set(real_light_members)

    # The two language halves must agree on the vocabulary, or the writer emits
    # markup the interpreter rejects.
    assert set(VEHICLE_LIGHT_BITS) == set(VEHICLE_LIGHT_TYPES)
    assert set(VEHICLE_DOOR_MEMBERS) == set(VEHICLE_COMPONENT_TYPES)

    # Every beam channel owns a bit no other light type claims, which is what
    # makes `_apply_vehicle_lights` independent of its `sorted()` iteration order.
    for beam in ("daytimeRunningLights", "lowBeam", "highBeam"):
        others = {m for key, members in VEHICLE_LIGHT_BITS.items() if key != beam for m in members}
        assert not (set(VEHICLE_LIGHT_BITS[beam]) & others), beam


def test_compiler_rejects_a_trunk_component_animation():
    """The interpreter refuses `trunk` too, so a hand-written .xosc cannot slip past.

    The writer no longer emits it, but the official XSD accepts it, so an
    externally-authored `.xosc` could still carry one. It must fail at compile
    time with a contract error rather than at render time with a RuntimeError.
    """
    xosc = golden("appearance-sets").replace(
        b'vehicleComponentType="doorFrontLeft"', b'vehicleComponentType="trunk"', 1,
    )
    with pytest.raises(ContractError, match="unsupported component"):
        compile_xosc14(xosc)


def test_carla_applies_vehicle_lights_without_clobbering_unowned_bits():
    backend = _appearance_backend()
    vehicle = _AppearanceVehicle()
    # Interior (256) is genuinely unowned: no VEHICLE_LIGHT_BITS entry claims it.
    # The bit this test used to pick, 32, is LeftBlinker in the real API and is
    # very much owned -- the old fake just renumbered the enum so it looked free.
    vehicle.light_state = 256
    backend._apply_appearance("ego", vehicle, {
        "light.brakeLights": "on",
        "light.reversingLights": "off",
        "light.indicatorLeft": "flashing",
    }, 0.0)
    assert vehicle.light_state == 256 | 8 | 32  # Interior | Brake | LeftBlinker
    # Half a flash period later the indicator drops and nothing else moves.
    backend._apply_appearance("ego", vehicle, {
        "light.brakeLights": "on",
        "light.reversingLights": "off",
        "light.indicatorLeft": "flashing",
    }, 0.5)
    assert vehicle.light_state == 256 | 8
    # Hazard wins over a stale indicator setting regardless of dict order.
    backend._apply_appearance("ego", vehicle, {
        "light.indicatorLeft": "off",
        "light.indicatorRight": "off",
        "light.warningLights": "flashing",
    }, 0.0)
    assert vehicle.light_state == 256 | 8 | 32 | 16


def test_carla_headlight_beams_are_order_independent_and_authored_intent_wins():
    """The beam channels own disjoint bits, so the mask cannot depend on sort order.

    `_apply_vehicle_lights` iterates `sorted(lights)`, and `highBeam` sorts
    before `lowBeam`. If the three beam types shared overlapping bit sets, a
    `low` setting would silently depend on that alphabetical accident.
    """
    backend = _appearance_backend()
    vehicle = _AppearanceVehicle()
    low = {"light.daytimeRunningLights": "on", "light.lowBeam": "on", "light.highBeam": "off"}
    backend._apply_appearance("ego", vehicle, low, 0.0)
    assert vehicle.light_state == 1 | 2  # Position | LowBeam, HighBeam clear
    # Dropping from high back to low must not leave the high beam latched.
    backend._apply_appearance("ego", vehicle, {
        "light.daytimeRunningLights": "on", "light.lowBeam": "on", "light.highBeam": "on",
    }, 0.02)
    assert vehicle.light_state == 1 | 2 | 4
    backend._apply_appearance("ego", vehicle, low, 0.04)
    assert vehicle.light_state == 1 | 2
    # `drl` is the position lamp alone: CARLA has no daytime-running-lamp bit.
    backend._apply_appearance("ego", vehicle, {
        "light.daytimeRunningLights": "on", "light.lowBeam": "off", "light.highBeam": "off",
    }, 0.06)
    assert vehicle.light_state == 1

    # Authored intent is authoritative: this worker has no sun-altitude headlight
    # pass and no Traffic Manager, so an authored `off` keeps the vehicle dark
    # even though the scenario may be rendering at night. Nothing else writes
    # this mask, so there is no writer to contend with.
    dark = _appearance_backend()
    night = _AppearanceVehicle()
    night.light_state = 1 | 2  # as if something had lit it
    dark._apply_appearance("ego", night, {
        "light.daytimeRunningLights": "off", "light.lowBeam": "off", "light.highBeam": "off",
    }, 0.0)
    assert night.light_state == 0


def test_carla_door_writes_are_edge_triggered_and_fail_closed_without_the_api():
    backend = _appearance_backend()
    vehicle = _AppearanceVehicle()
    state = {"door.doorFrontLeft": "open", "door.doorFrontRight": "closed"}
    backend._apply_appearance("ego", vehicle, state, 0.0)
    backend._apply_appearance("ego", vehicle, state, 0.02)
    assert vehicle.doors == [("open", 0), ("close", 1)]  # FL=0, FR=1
    backend._apply_appearance("ego", vehicle, {"door.doorFrontLeft": "closed"}, 0.04)
    assert vehicle.doors[-1] == ("close", 0)

    stripped = _appearance_backend()
    del stripped.carla.VehicleDoor
    with pytest.raises(RuntimeError, match="no door control API"):
        stripped._apply_appearance("ego", _AppearanceVehicle(), {"door.doorFrontLeft": "open"}, 0.0)

    dark = _appearance_backend()
    del dark.carla.VehicleLightState
    with pytest.raises(RuntimeError, match="no VehicleLightState"):
        dark._apply_appearance("ego", _AppearanceVehicle(), {"light.brakeLights": "on"}, 0.0)


def test_carla_destroys_absent_actors_once_and_never_drives_them_again():
    backend = _appearance_backend()
    backend.signals = {}
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.speed_integrals = {}
    backend.actor_lifecycle = {"leaver": "active"}
    vehicle = _AppearanceVehicle()
    backend.actors = {"leaver": vehicle}
    absent = ActorFrame("absent", 10.0, -4.0, 0.5, 90.0, 7.0)
    backend.apply(PlanFrame(0, 0.0, {"leaver": absent}, {}))
    assert vehicle.destroy_calls == 1
    assert "leaver" not in backend.actors
    assert vehicle.controls == []
    backend.apply(PlanFrame(1, 0.02, {"leaver": absent}, {}))
    assert vehicle.destroy_calls == 1
    assert vehicle.controls == []


def test_entity_without_an_executable_position_is_still_rejected():
    """The writer omits never-present actors; the interpreter still fails closed.

    Both halves matter. If the interpreter silently tolerated a positionless
    entity, a writer regression would produce a package whose actor set no longer
    matches the authored scenario, and nothing would say so.
    """
    ghost = (
        b'<ScenarioObject name="actor_ghost"><Vehicle name="uniscenarios_car" vehicleCategory="car">'
        b'<Properties><Property name="uniscenario.actorId" value="ghost"/>'
        b'<Property name="uniscenario.actorKind" value="car"/></Properties></Vehicle></ScenarioObject>'
    )
    with pytest.raises(ContractError, match="lack an executable position or trajectory"):
        compile_xosc14(golden("actor-despawn").replace(b"</Entities>", ghost + b"</Entities>"))


def _walker_xosc(knocked_down_at: str | None) -> bytes:
    """The same trajectory-replay shape as XOSC, with one pedestrian."""
    knockdown = (
        f'<Property name="uniscenarios.trajectoryReplay.knockedDownAtS.walker" value="{knocked_down_at}"/>'
        if knocked_down_at is not None else ''
    )
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="4" date="1970-01-01T00:00:00Z" description="test" author="test"><Properties><Property name="uniscenario.executionMode" value="trajectory-replay"/>{knockdown}</Properties></FileHeader>
  <ParameterDeclarations/><CatalogLocations/><RoadNetwork><LogicFile filepath="map.xodr"/></RoadNetwork>
  <Entities><ScenarioObject name="actor_walker"><Pedestrian name="uniscenarios_pedestrian" mass="80" pedestrianCategory="pedestrian"><Properties><Property name="uniscenario.actorId" value="walker"/><Property name="uniscenario.actorKind" value="pedestrian"/></Properties></Pedestrian></ScenarioObject></Entities>
  <Storyboard>
    <Init><Actions><Private entityRef="actor_walker"><PrivateAction><TeleportAction><Position><WorldPosition x="0" y="0" z="0" h="0" p="0" r="0"/></Position></TeleportAction></PrivateAction></Private></Actions></Init>
    <Story name="story"><Act name="act"><ManeuverGroup name="group" maximumExecutionCount="1"><Actors selectTriggeringEntities="false"><EntityRef entityRef="actor_walker"/></Actors><Maneuver name="maneuver"><Event name="event" priority="overwrite"><Action name="follow"><PrivateAction><RoutingAction><FollowTrajectoryAction><TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference><TrajectoryFollowingMode followingMode="position"/><TrajectoryRef><Trajectory name="trajectory_walker" closed="false"><Shape><Polyline>
      <Vertex time="0"><Position><WorldPosition x="0" y="0" z="0" h="0" p="0" r="0"/></Position><Motion speed_longitudinal="1.4"/></Vertex>
      <Vertex time="0.04"><Position><WorldPosition x="0.06" y="0" z="0" h="0" p="0" r="0"/></Position><Motion speed_longitudinal="1.4"/></Vertex>
    </Polyline></Shape></Trajectory></TrajectoryRef></FollowTrajectoryAction></RoutingAction></PrivateAction></Action><StartTrigger><ConditionGroup><Condition name="start" delay="0" conditionEdge="rising"><ByValueCondition><SimulationTimeCondition value="0" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger></Event></Maneuver></ManeuverGroup><StartTrigger/><StopTrigger/></Act></Story><StopTrigger/>
  </Storyboard>
</OpenSCENARIO>'''.encode()


def test_knockdown_header_marks_frames_from_the_recorded_time():
    plan = compile_xosc14(_walker_xosc("0.02"))
    downed = [frame.actors["walker"].downed for frame in plan.frames]
    # Upright before the recorded time, down from it, and never back up.
    assert downed[0] is False
    assert all(downed[1:])


def test_plans_without_a_knockdown_keep_their_digest():
    # The digest line is appended only when a body is down, so every plan
    # produced before knockdowns existed hashes exactly as it did.
    without = compile_xosc14(_walker_xosc(None))
    assert all(frame.actors["walker"].downed is False for frame in without.frames)
    assert without.sha256 == compile_xosc14(_walker_xosc(None)).sha256
    assert without.sha256 != compile_xosc14(_walker_xosc("0.02")).sha256


def test_rejects_an_unparseable_knockdown_time():
    with pytest.raises(ContractError):
        compile_xosc14(_walker_xosc("not-a-time"))


def _placement_carla():
    class Location:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class WalkerControl:
        def __init__(self, direction=None, speed=0, jump=False):
            self.direction, self.speed, self.jump = direction, speed, jump
    class Carla: pass
    Carla.Location, Carla.Rotation, Carla.Transform = Location, Rotation, Transform
    Carla.Vector3D, Carla.WalkerControl = Vector3D, WalkerControl
    return Carla


class _PlacementActor:
    def __init__(self, type_id="vehicle.lincoln.mkz", actor_id=1):
        self.type_id, self.id = type_id, actor_id
    def destroy(self): return True


class _PlacementWorld:
    def __init__(self, ground_z=None, waypoint_z=None, refuse_spawn=False):
        self.ground_z, self.waypoint_z, self.refuse_spawn = ground_z, waypoint_z, refuse_spawn
        self.transforms, self.probes = [], []
        self.next_actor_id = 1
    def get_blueprint_library(self):
        class Library:
            def find(self, blueprint_id): return blueprint_id
        return Library()
    def try_spawn_actor(self, blueprint_id, transform):
        if self.refuse_spawn:
            return None
        self.transforms.append(transform)
        actor = _PlacementActor(blueprint_id, self.next_actor_id)
        self.next_actor_id += 1
        return actor


class _RaycastWorld(_PlacementWorld):
    def ground_projection(self, location, search_distance):
        self.probes.append((location.x, location.y, location.z, search_distance))
        if self.ground_z is None:
            return None
        return type("Hit", (), {"location": type("L", (), {"z": self.ground_z})()})()


class _WaypointWorld(_PlacementWorld):
    def get_map(self):
        world = self
        class Map:
            def get_waypoint(self, location, project_to_road=True):
                if world.waypoint_z is None:
                    return None
                transform = type("T", (), {"location": type("L", (), {"z": world.waypoint_z})()})()
                return type("Waypoint", (), {"transform": transform})()
        return Map()


def _placement_backend(world):
    backend = object.__new__(CarlaBackend)
    backend.carla = _placement_carla()
    backend.world = world
    backend.actors = {}
    return backend


def _vehicle_binding(actor_id):
    return ActorBinding(actor_id, f"actor_{actor_id}", "car", "vehicle.sedan")


_PLACEMENT_CATALOG = {"vehicle.sedan": {"blueprintId": "vehicle.lincoln.mkz"}}


def test_spawn_projects_each_actor_to_the_rendered_ground_surface():
    backend = _placement_backend(_RaycastWorld(ground_z=58.4))
    frame = PlanFrame(0, 0, {"ego": ActorFrame("spawn", 143.269, -338.977, 61.796, -5.782, 0)}, {})
    backend.spawn({"ego": _vehicle_binding("ego")}, frame, _PLACEMENT_CATALOG)
    spawned = backend.world.transforms[0]
    assert spawned.location.z == pytest.approx(58.4 + 0.25)
    assert spawned.location.y == pytest.approx(338.977)
    # The probe starts above the authored elevation, in the CARLA frame.
    assert backend.world.probes[0][2] == pytest.approx(61.796 + 2.0)
    report = backend.spawn_placement_report()
    assert report["actors"]["ego"]["outcome"] == "placed"
    assert report["actors"]["ego"]["groundSource"] == "ground-projection"
    assert report["droppedActorIds"] == [] and report["nudgedActorIds"] == []
    assert backend.spawn_planar_targets["ego"] == (pytest.approx(143.269), pytest.approx(-338.977))


def test_spawn_falls_back_to_waypoint_elevation_and_rejects_far_surfaces():
    backend = _placement_backend(_WaypointWorld(waypoint_z=60.1))
    frame = PlanFrame(0, 0, {"ego": ActorFrame("spawn", 10.0, 4.0, 61.0, 0.0, 0)}, {})
    backend.spawn({"ego": _vehicle_binding("ego")}, frame, _PLACEMENT_CATALOG)
    assert backend.world.transforms[0].location.z == pytest.approx(60.1 + 0.25)
    assert backend.spawn_placement_report()["actors"]["ego"]["groundSource"] == "road-waypoint"

    # A surface farther than the acceptance delta is the wrong one
    # (overpass, tunnel roof): the authored elevation stays authoritative.
    far = _placement_backend(_WaypointWorld(waypoint_z=61.0 - 40.0))
    far.spawn({"ego": _vehicle_binding("ego")}, frame, _PLACEMENT_CATALOG)
    assert far.world.transforms[0].location.z == pytest.approx(61.0 + 0.25)
    assert far.spawn_placement_report()["actors"]["ego"]["groundSource"] == "authored-z"


def test_spawn_overlap_nudges_along_the_lane_and_records_the_placement():
    backend = _placement_backend(_PlacementWorld())
    frame = PlanFrame(0, 0, {
        "a": ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 0),
        "b": ActorFrame("spawn", 4.0, 0.0, 0.0, 0.0, 0),
    }, {})
    backend.spawn({"a": _vehicle_binding("a"), "b": _vehicle_binding("b")}, frame, _PLACEMENT_CATALOG)
    report = backend.spawn_placement_report()
    assert report["actors"]["a"]["outcome"] == "placed"
    assert report["actors"]["b"]["outcome"] == "nudged"
    assert report["actors"]["b"]["nudgeAlongHeadingM"] == pytest.approx(1.5)
    assert report["nudgedActorIds"] == ["b"]
    assert backend.world.transforms[1].location.x == pytest.approx(5.5)
    assert backend.spawn_planar_targets["b"] == (pytest.approx(5.5), pytest.approx(0.0))


def test_spawn_drops_an_unplaceable_actor_instead_of_stacking():
    backend = _placement_backend(_PlacementWorld())
    frame = PlanFrame(0, 0, {
        "a": ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 0),
        "b": ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 0),
    }, {})
    backend.spawn({"a": _vehicle_binding("a"), "b": _vehicle_binding("b")}, frame, _PLACEMENT_CATALOG)
    assert set(backend.actors) == {"a"}
    assert backend.dropped_actor_ids == {"b"}
    # The overlapping body was never handed to CARLA at all: no stacking.
    assert len(backend.world.transforms) == 1
    report = backend.spawn_placement_report()
    assert report["droppedActorIds"] == ["b"]
    assert report["actors"]["b"]["outcome"] == "dropped"
    assert "no collision-free spawn" in report["actors"]["b"]["reason"]


def test_spawn_fails_closed_when_every_actor_is_unplaceable():
    backend = _placement_backend(_PlacementWorld(refuse_spawn=True))
    frame = PlanFrame(0, 0, {"ego": ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 0)}, {})
    with pytest.raises(RuntimeError, match="dropped every scenario actor"):
        backend.spawn({"ego": _vehicle_binding("ego")}, frame, _PLACEMENT_CATALOG)


def test_spawn_drops_execution_semantics_actors_with_a_recorded_reason():
    backend = _placement_backend(_PlacementWorld())
    backend.execution_drops = {"deer": "native physics cannot execute authored knockdown poses without post-spawn teleport repair"}
    frame = PlanFrame(0, 0, {
        "ego": ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 0),
        "deer": ActorFrame("spawn", 8.0, 0.0, 0.0, 0.0, 0, downed=True),
    }, {})
    backend.spawn({"ego": _vehicle_binding("ego"), "deer": _vehicle_binding("deer")}, frame, _PLACEMENT_CATALOG)
    assert set(backend.actors) == {"ego"}
    assert backend.dropped_actor_ids == {"deer"}
    # The knocked-down body was never handed to CARLA.
    assert len(backend.world.transforms) == 1
    report = backend.spawn_placement_report()
    assert report["droppedActorIds"] == ["deer"]
    assert report["actors"]["deer"] == {
        "outcome": "dropped",
        "cause": "execution-semantics",
        "reason": "native physics cannot execute authored knockdown poses without post-spawn teleport repair",
        "authored": {"x": 8.0, "y": 0.0, "z": 0.0},
    }


def test_knockdown_pose_drops_the_actor_instead_of_failing_the_render():
    lease = parse_lease(lease_value())
    plan = ExecutionPlan(
        "uniscenario.execution-plan/v1", 0.02,
        {
            "ego": ActorBinding("ego", "actor_ego", "car", "vehicle.sedan"),
            "deer": ActorBinding("deer", "actor_deer", "animal", "animal.deer"),
        },
        (
            PlanFrame(0, 0.0, {
                "ego": ActorFrame("spawn", 0, 0, 0, 0, 1.0),
                "deer": ActorFrame("spawn", 5, 0, 0, 0, 0.0),
            }, {}),
            PlanFrame(1, 0.02, {
                "ego": ActorFrame("active", 0.02, 0, 0, 0, 1.0),
                # Knocked down mid-scenario, and sliding: the drop must also
                # exempt the actor from the moving-animal gate.
                "deer": ActorFrame("active", 5.01, 0, 0, 0, 0.5, downed=True),
            }, {}),
        ), "a" * 64,
    )
    drops = worker_runner._preflight_execution_semantics(lease, plan)
    assert drops == {"deer": "native physics cannot execute authored knockdown poses without post-spawn teleport repair"}

    # A knockdown-posed actor that hosts sensors cannot be dropped silently.
    hosted = lease_value()
    hosted["job"]["renderSpec"]["sensors"][0]["actorId"] = "deer"
    hosted_lease = parse_lease(seal_lease(hosted))
    with pytest.raises(ContractError, match="cannot attach to knockdown-posed actors"):
        worker_runner._preflight_execution_semantics(hosted_lease, plan)


def test_cooked_map_registry_resolves_known_xodrs_and_env_extensions(monkeypatch):
    from uniscenarios_carla_bridge.runtime.backend import cooked_map_name_for_xodr
    monkeypatch.delenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", raising=False)
    richmond = "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643"
    belmont = "35cf2b16a1d308c6436089a0edf66f20c87a79da12e79472a03a2f568ba28f63"
    assert cooked_map_name_for_xodr(richmond) == "Richmond_Field_Station_Richmond_CA"
    assert cooked_map_name_for_xodr(belmont) == "Belmont_Office_Park_Belmont_CA"
    assert cooked_map_name_for_xodr("f" * 64) is None
    monkeypatch.setenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", json.dumps({"Munich": "e" * 64}))
    assert cooked_map_name_for_xodr("e" * 64) == "Munich"
    monkeypatch.setenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", json.dumps({"NotRichmond": richmond}))
    with pytest.raises(RuntimeError, match="conflicts with the built-in cooked world"):
        cooked_map_name_for_xodr(richmond)
    monkeypatch.setenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", "not json")
    with pytest.raises(RuntimeError, match="must be valid JSON"):
        cooked_map_name_for_xodr(richmond)


def test_cooked_xodr_never_falls_back_to_a_generated_world(monkeypatch):
    monkeypatch.setenv("UNISCENARIO_CARLA_ALLOW_GENERATED_XODR", "1")
    monkeypatch.delenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", raising=False)
    richmond_xodr = b"richmond-source-xodr"
    monkeypatch.setattr(
        "uniscenarios_carla_bridge.runtime.backend.COOKED_MAP_NAMES_BY_XODR_SHA256",
        {hashlib.sha256(richmond_xodr).hexdigest(): "Richmond_Field_Station_Richmond_CA"},
    )
    backend = object.__new__(CarlaBackend)
    backend.carla = type("Carla", (), {
        "OpendriveGenerationParameters": staticmethod(lambda **_kwargs: object()),
    })()
    backend.client = type("Client", (), {
        "get_available_maps": lambda _self: ["/Game/Carla/Maps/Town10HD_Opt"],
        "generate_opendrive_world": lambda _self, *_args: pytest.fail("cooked maps must never regenerate from XODR"),
    })()
    with pytest.raises(RuntimeError, match="refusing the generated-OpenDRIVE fallback"):
        backend.load_opendrive("Richmond_Field_Station_Richmond_CA", richmond_xodr, 0.02)
    # An uncooked XODR keeps the explicitly enabled generated-world fallback.
    class GeneratedWorld:
        def get_map(self):
            return type("M", (), {"name": "Carla/Maps/OpenDriveMap"})()
        def get_settings(self):
            return type("S", (), {"synchronous_mode": True, "fixed_delta_seconds": 0.02})()
        def apply_settings(self, _settings): pass
    backend.client.generate_opendrive_world = lambda *_args: GeneratedWorld()
    backend.load_opendrive("uncooked-map", b"<OpenDRIVE/>", 0.02)
    assert backend.map_evidence["source"] == "generated-opendrive-world"
    assert backend.map_evidence["requestedMapName"] == "uncooked-map"


def test_prepare_scenario_resets_a_nudged_actor_to_its_placed_position():
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Location:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, location, rotation): self.location, self.rotation = location, rotation
    class VehicleControl:
        def __init__(self, throttle=0, brake=0, steer=0):
            self.throttle, self.brake, self.steer = throttle, brake, steer
    class Carla: pass
    Carla.Vector3D, Carla.Location, Carla.Rotation, Carla.Transform = Vector3D, Location, Rotation, Transform
    Carla.VehicleControl = VehicleControl
    class Actor:
        type_id = "vehicle.lincoln.mkz"
        def __init__(self): self.transform = Transform(Location(z=7), Rotation())
        def apply_control(self, control): pass
        def get_transform(self): return self.transform
        def get_velocity(self): return Vector3D()
        def get_angular_velocity(self): return Vector3D()
        def set_transform(self, value): self.transform = value
        def set_target_velocity(self, value): pass
        def set_target_angular_velocity(self, value): pass
    class World:
        def tick(self): pass
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = World()
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.speed_integrals = {}
    backend.actors = {"ego": Actor()}
    backend.spawn_planar_targets = {"ego": (5.5, 0.0)}
    frame = PlanFrame(0, 0, {"ego": ActorFrame("spawn", 4.0, 0.0, 0.0, 0.0, 0)}, {})
    backend.prepare_scenario(frame)
    # The collision-free placement wins over the authored overlap position, so
    # the pre-t0 reset can never re-create the spawn overlap.
    assert backend.actors["ego"].transform.location.x == pytest.approx(5.5)
    assert backend.actors["ego"].transform.location.z == pytest.approx(7)


def test_apply_drives_walker_natively_and_never_teleports():
    Carla = _placement_carla()
    class Walker:
        type_id = "walker.pedestrian.0001"
        def __init__(self):
            self.controls, self.teleports = [], 0
            self.transform = Carla.Transform(Carla.Location(), Carla.Rotation())
        def get_transform(self): return self.transform
        def get_velocity(self): return Carla.Vector3D()
        def apply_control(self, control): self.controls.append(control)
        def set_transform(self, _value): self.teleports += 1
    walker = Walker()
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.actors = {"ped": walker}
    backend.signals = {}
    backend.apply(PlanFrame(0, 0, {"ped": ActorFrame("active", 2.0, 0.0, 0.0, 0.0, 1.4)}, {}))
    assert walker.teleports == 0
    control = walker.controls[-1]
    # Along-track catch-up: 2.0 m error * 0.45 = +0.9 m/s over the authored
    # speed, always clamped to at most +1.0 m/s.
    assert control.speed == pytest.approx(1.4 + 0.9)
    assert control.direction.x == pytest.approx(1.0)
    assert control.direction.y == pytest.approx(0.0)
    assert control.direction.z == 0.0
    assert control.jump is False

    # A stationary walker within tolerance holds still natively.
    backend.apply(PlanFrame(1, 0.02, {"ped": ActorFrame("active", 0.0, 0.0, 0.0, 0.0, 0.0)}, {}))
    assert walker.controls[-1].speed == 0.0
    assert walker.teleports == 0


def test_apply_skips_actors_dropped_at_spawn():
    Carla = _placement_carla()
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.execution_mode = "native-physics"
    backend.fixed_timestep_s = 0.02
    backend.actors = {}
    backend.signals = {}
    backend.dropped_actor_ids = {"ghost"}
    # An active plan state for a dropped actor is not "missing from CARLA".
    backend.apply(PlanFrame(0, 0, {"ghost": ActorFrame("active", 1.0, 2.0, 0.0, 0.0, 3.0)}, {}))


def test_parity_excludes_dropped_actors_and_measures_nudged_static_placement():
    frame = PlanFrame(0, 0, {
        "gone": ActorFrame("active", 0.0, 0.0, 0.0, 0.0, 0.0),
        "parked": ActorFrame("active", 4.0, 0.0, 0.0, 0.0, 0.0),
    }, {})
    readback = {"parked": {"x": 5.5, "y": 0.0, "z": 0.0, "headingDeg": 0.0, "speedMps": 0.0}}

    strict = ParityAccumulator({})
    with pytest.raises(RuntimeError, match="closure differs"):
        strict.observe(frame, readback)

    accumulator = ParityAccumulator({})
    accumulator.configure_spawn_placement({"gone"}, {"parked": (1.5, 0.0)})
    accumulator.observe(frame, readback)
    report = accumulator.report()
    assert report.samples == 1
    assert report.max_error["positionM"] == pytest.approx(0.0)
    assert report.failed_actor_ids == ()


def _two_vehicle_xosc() -> bytes:
    start = XOSC.index(b'<ManeuverGroup name="group"')
    end = XOSC.index(b'</ManeuverGroup>', start) + len(b'</ManeuverGroup>')
    buddy_group = XOSC[start:end].replace(b'group', b'buddy_group').replace(b'actor_ego', b'actor_buddy').replace(b'trajectory_ego', b'trajectory_buddy')
    buddy_entity = (
        b'<ScenarioObject name="actor_buddy"><Vehicle name="uniscenarios_car" vehicleCategory="car">'
        b'<Properties><Property name="uniscenario.actorId" value="buddy"/>'
        b'<Property name="uniscenario.actorKind" value="car"/>'
        b'<Property name="uniscenarios.tag" value="catalog:vehicle.sedan"/></Properties></Vehicle></ScenarioObject>'
    )
    return XOSC.replace(b'</Entities>', buddy_entity + b'</Entities>').replace(b'</Act>', buddy_group + b'</Act>')


class _PlacementFakeBackend(FakeBackend):
    def __init__(self, report):
        super().__init__()
        self.placement = report
        self.dropped = set(report.get("droppedActorIds", ()))
    def spawn_placement_report(self, abort=None):
        (abort or (lambda: None))()
        return self.placement
    def tick(self, capture=None, abort=None):
        result = super().tick(capture, abort)
        return {actor_id: value for actor_id, value in result.items() if actor_id not in self.dropped}


def _two_vehicle_lease():
    xosc = _two_vehicle_xosc()
    manifest = execution_manifest(xosc)
    value = lease_value(outputs=["trace", "manifest"])
    value["job"]["executionPackage"]["xosc"].update({"sha256": digest(xosc), "sizeBytes": len(xosc)})
    return parse_lease(seal_lease(value, manifest)), xosc, manifest


def test_executor_records_spawn_drop_diagnostics_and_stays_frame_closed():
    lease, xosc, manifest = _two_vehicle_lease()
    assets = {"memory:manifest": manifest, "memory:xosc": xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    report = {
        "schema": "uniscenario.spawn-placement/v1",
        "actors": {
            "ego": {"outcome": "placed"},
            "buddy": {
                "outcome": "dropped",
                "reason": "no collision-free spawn within the bounded lane nudge window",
                "authored": {"x": 0.0, "y": 0.0, "z": 0.0},
            },
        },
        "droppedActorIds": ["buddy"],
        "nudgedActorIds": [],
    }
    backend = _PlacementFakeBackend(report)
    uploaded = {}
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda url, body, media_type, headers: uploaded.update({url: artifact_bytes(body)}),
    )
    assert result["status"] == "succeeded"
    assert result["attestation"]["spawnPlacement"] == report
    trajectory = result["parityEvidence"]["trajectory"]
    assert trajectory["droppedActorIds"] == ["buddy"]
    assert trajectory["evaluatedActorCount"] == 1
    codes = [item["code"] for item in result["parityEvidence"]["divergences"]]
    assert "spawn-placement:dropped-unplaceable:buddy" in codes
    manifest_body = json.loads(uploaded["memory:upload:manifest"])
    assert manifest_body["workerAttestation"]["spawnPlacement"]["droppedActorIds"] == ["buddy"]


def test_executor_rejects_a_dropped_sensor_host_actor():
    lease, xosc, manifest = _two_vehicle_lease()
    assets = {"memory:manifest": manifest, "memory:xosc": xosc, "memory:xodr": XODR, "memory:catalog": CATALOG, "memory:traffic": DISABLED_TRAFFIC}
    report = {
        "schema": "uniscenario.spawn-placement/v1",
        "actors": {"ego": {"outcome": "dropped"}, "buddy": {"outcome": "placed"}},
        "droppedActorIds": ["ego"],
        "nudgedActorIds": [],
    }
    with pytest.raises(ContractError, match="dropped sensor host actors: ego"):
        execute_lease(
            lease, _PlacementFakeBackend(report),
            lambda body: {"valid": True, "xmlSha256": digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url],
            uploader=lambda *_args: None,
        )


def test_static_actor_is_frozen_only_after_its_own_settle_never_mid_fall():
    class Vector3D:
        def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    class Location(Vector3D): pass
    class Rotation:
        def __init__(self, yaw=0): self.yaw = yaw
    class Transform:
        def __init__(self, z=0): self.location, self.rotation = Location(z=z), Rotation()
    class Carla: pass
    Carla.Vector3D = Vector3D
    class World:
        def __init__(self): self.ticks = 0
        def tick(self): self.ticks += 1
    class FallingParkedCar:
        """Falls for 30 ticks (past the old blind freeze at tick 20), then rests."""
        def __init__(self, world):
            self.world, self.physics, self.frozen_at_tick = world, True, None
            self.z = 3.0
        def _falling(self): return self.physics and self.world.ticks <= 30
        def get_transform(self):
            if self._falling():
                self.z -= 0.1
            return Transform(z=self.z)
        def get_velocity(self): return Vector3D(z=-5.0 if self._falling() else 0.0)
        def get_angular_velocity(self): return Vector3D()
        def set_simulate_physics(self, value):
            self.physics = value
            if value is False:
                self.frozen_at_tick = self.world.ticks
        def set_target_velocity(self, value): pass
        def set_target_angular_velocity(self, value): pass
    world = World()
    parked = FallingParkedCar(world)
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = world
    backend.actors = {"parked": parked}
    backend.static_actor_ids = {"parked"}
    backend.frozen_static_actor_ids = set()
    report = backend._wait_for_native_stability("spawn settle", minimum_ticks=20, maximum_ticks=100)
    # The body kept falling through the old blind freeze point and was only
    # held kinematically once its own motion residuals settled.
    assert parked.frozen_at_tick is not None and parked.frozen_at_tick > 30
    assert parked.physics is False
    assert report["ticks"] >= parked.frozen_at_tick
    assert report["residuals"]["parked"]["verticalMps"] == 0.0


def _stepping_backend(accepts_delta):
    class Settings:
        synchronous_mode = False
        fixed_delta_seconds = None
        no_rendering_mode = True
    class Map:
        name = "fixture"
        def to_opendrive(self): return "<OpenDRIVE/>"
    class World:
        def __init__(self):
            self.settings = Settings()
        def get_map(self): return Map()
        def get_settings(self): return self.settings
        def apply_settings(self, settings):
            if not accepts_delta:
                # A runtime that silently refuses the deterministic step.
                settings.fixed_delta_seconds = None
            self.settings = settings
    class Client:
        def __init__(self): self.world = World()
        def set_timeout(self, value): pass
        def get_available_maps(self): return ["/Game/Carla/Maps/fixture"]
        def load_world(self, name): return self.world
    backend = object.__new__(CarlaBackend)
    backend.carla = type("Carla", (), {})
    backend.client = Client()
    backend.world = None
    return backend


def test_load_opendrive_verifies_the_stepping_contract_readback():
    honored = _stepping_backend(accepts_delta=True)
    honored.load_opendrive("fixture", b"<OpenDRIVE/>", 0.02)
    assert honored.streaming_evidence["appliedFixedDeltaS"] == pytest.approx(0.02)

    refused = _stepping_backend(accepts_delta=False)
    with pytest.raises(RuntimeError, match="did not accept synchronous 0.02s stepping"):
        refused.load_opendrive("fixture", b"<OpenDRIVE/>", 0.02)


def test_tick_fails_closed_when_the_engine_ticks_itself():
    class World:
        def __init__(self): self.frames = iter((100, 101, 105))
        def tick(self): return next(self.frames)
    backend = object.__new__(CarlaBackend)
    backend.world = World()
    backend.actors = {}
    backend.sensor_condition = Condition(Lock())
    backend.sensor_error = None
    backend.sensor_pending = {}
    backend.last_carla_frame = None
    backend.current_plan_frame = None
    backend.carla_to_plan_frame = {}
    backend.streaming_primary_actor_id = None
    assert backend.tick() == {}
    assert backend.tick() == {}
    with pytest.raises(RuntimeError, match="3 un-commanded engine tick"):
        backend.tick()


def test_sensor_sample_cap_covers_pronto_20s_and_stays_fail_closed(monkeypatch):
    from uniscenarios_carla_bridge.runtime import contract

    base = {
        "schema": "uniscenario.render-resource-request/v1",
        "durationS": 20.0,
        "sensors": 9,
        "captureFrames": 480,
        "actors": 4,
        "actorFrameStates": 4_000,
        "outputBytes": 2_147_483_648,
        "maxFrameWidth": 1280,
        "maxFrameHeight": 720,
        "samplesPerFrame": 8_294_400,
    }
    # The default 6e9 cap admits exactly the boundary and the 20 s Pronto shape.
    assert contract.MAX_SENSOR_PIXELS == 6_000_000_000
    at_bound = contract.RenderResourceRequest.parse({**base, "sensorSamples": 6_000_000_000})
    assert at_bound.sensor_samples == 6_000_000_000
    pronto = contract.RenderResourceRequest.parse({**base, "sensorSamples": 3_981_312_000})
    assert pronto.sensor_samples == 3_981_312_000
    with pytest.raises(contract.ContractError):
        contract.RenderResourceRequest.parse({**base, "sensorSamples": 6_000_000_001})
    # Env override is validated and fail-closed.
    monkeypatch.setenv("UNISCENARIO_MAX_SENSOR_PIXELS", "123")
    assert contract._configured_max_sensor_pixels() == 123
    monkeypatch.setenv("UNISCENARIO_MAX_SENSOR_PIXELS", "-1")
    with pytest.raises(contract.ContractError):
        contract._configured_max_sensor_pixels()
    monkeypatch.setenv("UNISCENARIO_MAX_SENSOR_PIXELS", "not-a-number")
    with pytest.raises(contract.ContractError):
        contract._configured_max_sensor_pixels()


def test_cooked_map_remap_freezes_unauthored_extra_heads_red_and_records_evidence():
    """kia-image Richmond ships 3 pedestrian heads (444-446) beside the 8 remapped
    vehicular heads; under the approved cooked identity they are forced Red and
    frozen instead of failing the ownership gate, and land in map evidence."""
    class TrafficLightState:
        Red, Yellow, Green, Off = "red", "yellow", "green", "off"
    class Carla:
        pass
    Carla.TrafficLightState = TrafficLightState
    class Light:
        type_id = "traffic.traffic_light"
        def __init__(self, actor_id, signal_id, state):
            self.id, self.signal_id, self.state, self.frozen = actor_id, signal_id, state, False
            self.green_time = self.yellow_time = self.red_time = 5.0
            self.mutations = []
        def get_opendrive_id(self): return self.signal_id
        def get_state(self): return self.state
        def is_frozen(self): return self.frozen
        def get_green_time(self): return self.green_time
        def get_yellow_time(self): return self.yellow_time
        def get_red_time(self): return self.red_time
        def set_state(self, state): self.state = state; self.mutations.append(("state", state))
        def freeze(self, frozen): self.frozen = frozen; self.mutations.append(("freeze", frozen))
        def set_green_time(self, value): self.green_time = value
        def set_yellow_time(self, value): self.yellow_time = value
        def set_red_time(self, value): self.red_time = value
    class Actors(list):
        def filter(self, pattern): assert pattern == "traffic.traffic_light*"; return self
    class Settings:
        synchronous_mode, fixed_delta_seconds = True, 0.02
    class World:
        def __init__(self, lights): self.lights, self.ticks = Actors(lights), 0
        def get_actors(self): return self.lights
        def tick(self): self.ticks += 1; return self.ticks
        def get_settings(self): return Settings()
        def apply_settings(self, _settings): pass

    owned = Light(103, "421", "green")
    pedestrian = Light(101, "444", "green")
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = World([owned, pedestrian])
    backend.signals, backend.signal_snapshots = {}, {}
    backend.sensors, backend.actors = [], {}
    backend.signal_id_map = {"367": "421"}
    backend.map_evidence = {"schema": "uniscenario.carla-map-evidence/v1"}

    backend.bind_signals(("367",))
    assert backend.signals == {"367": owned}
    assert owned.mutations == [("freeze", True)]
    assert pedestrian.mutations == [("state", "red"), ("freeze", True)]
    assert backend.map_evidence["unownedFrozenSignalIds"] == ["444"]

    backend.cleanup()
    assert (pedestrian.state, pedestrian.frozen) == ("green", False)

    # Without a cooked identity the extra head still fails closed.
    strict = object.__new__(CarlaBackend)
    strict.carla = Carla
    strict.world = World([Light(103, "421", "green"), Light(101, "444", "green")])
    strict.signals, strict.signal_snapshots = {}, {}
    with pytest.raises(RuntimeError, match="extra: 444"):
        strict.bind_signals(("421",))


def _write_ascii_ply(path: Path, points: list[tuple[float, float, float, float]]) -> None:
    lines = [
        "ply", "format ascii 1.0", f"element vertex {len(points)}",
        "property float32 x", "property float32 y", "property float32 z",
        "property float32 I", "end_header",
    ]
    lines.extend(f"{x} {y} {z} {i}" for x, y, z, i in points)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_lidar_video_frames_accumulate_one_full_revolution(tmp_path):
    """A per-tick .ply holds only the sector swept that tick; frame N must draw
    the revolution ENDING at tick N (rolling window), never a lone bucket and
    never buckets older than one revolution."""
    from uniscenarios_carla_bridge.runtime import sensor_video

    fps, rotation_hz = 24.0, 10.0
    assert sensor_video._sweep_window_ticks(fps, rotation_hz) == 3
    assert sensor_video._sweep_window_ticks(24.0, 24.0) == 1
    assert sensor_video._sweep_window_ticks(24.0, 0.0) == 1

    span = 60.0  # rangeM 200 is capped at the 60 m view
    scale = min(sensor_video.VIDEO_WIDTH / (span * 2.2), sensor_video.VIDEO_HEIGHT / (span * 2.2))
    origin_x, origin_y = sensor_video.VIDEO_WIDTH // 2, sensor_video.VIDEO_HEIGHT // 2

    # One uniquely-placed point per tick bucket, all forward of the sensor.
    # Distances avoid the 20 m grid-ring multiples so probes never hit ring pixels.
    forward = [10.0, 15.0, 30.0, 45.0, 55.0]
    frames = []
    for index, x in enumerate(forward):
        path = tmp_path / f"{index:08d}.ply"
        _write_ascii_ply(path, [(x, 0.0, 0.0, 1.0)])
        frames.append(path)

    def lit(frame: bytes, x_m: float) -> bool:
        px = origin_x
        py = origin_y - int(x_m * scale)
        offset = (py * sensor_video.VIDEO_WIDTH + px) * 3
        return frame[offset:offset + 3] != bytes(sensor_video._BACKGROUND)

    rendered = list(sensor_video._lidar_frames(frames, 200.0, fps, rotation_hz))
    assert len(rendered) == len(forward)
    # Frame 0: only bucket 0.
    assert lit(rendered[0], forward[0]) and not lit(rendered[0], forward[1])
    # Frame 2: buckets 0..2 — a full revolution of ticks.
    assert all(lit(rendered[2], forward[i]) for i in range(3))
    # Frame 4: buckets 2..4 only; buckets older than one revolution are gone.
    assert all(lit(rendered[4], forward[i]) for i in (2, 3, 4))
    assert not lit(rendered[4], forward[0]) and not lit(rendered[4], forward[1])
