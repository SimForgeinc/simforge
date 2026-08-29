from __future__ import annotations
from .._compat_env import simforge_env
import shutil

import hashlib
import gzip
import json
import os
import platform
import subprocess
import zipfile
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Mapping

from .transport import download, upload
from .backend import RenderBackend, runtime_asset_bindings
# historical name retained for stored-data compat
from .compiler import (
    LIFECYCLE_ABSENT,
    ExecutionPlan,
    compile_xosc14,
    substitute_actor_catalog_bindings,
)
from .contract import (
    CAMERA_MODALITIES,
    ContractError,
    Lease,
    MAX_ARTIFACT_BYTES,
    MAX_CAPTURE_FRAMES,
    MAX_CATALOG_BYTES,
    MAX_DURATION_SECONDS,
    MAX_MANIFEST_BYTES,
    MAX_OUTPUT_BYTES,
    MAX_SENSOR_PIXELS,
    MAX_TRAFFIC_BYTES,
    MAX_XODR_BYTES,
    MAX_XOSC_BYTES,
    SCHEMA,
    reject_unsafe_xml_envelope,
)
from .parity import ParityAccumulator
from .sensor_video import encode_sensor_video
from .materialized_traffic import merge_materialized_traffic, parse_materialized_traffic
from .validation import validate_xosc14

Download = Callable[[str, int], bytes]
ArtifactBody = bytes | Path
Upload = Callable[[str, ArtifactBody, str, Mapping[str, str] | None], None]
Validate = Callable[[bytes], Mapping[str, object]]
Control = Callable[[Mapping[str, object]], bool]
Deadline = float | Callable[[], float]


class CancellationRequested(RuntimeError):
    pass


class LeaseDeadlineExceeded(RuntimeError):
    pass


class _BoundedWriter:
    def __init__(self, target: Any, max_bytes: int, label: str):
        self.target = target
        self.max_bytes = max_bytes
        self.label = label
        self.written = 0

    def write(self, body: bytes) -> int:
        if self.written + len(body) > self.max_bytes:
            raise ContractError(f"{self.label} exceeds the shared temporary-disk budget")
        count = self.target.write(body)
        self.written += count
        return count

    def flush(self) -> None:
        self.target.flush()

    def tell(self) -> int:
        return self.target.tell()


class _ExecutionFence:
    """Cheap local deadline checks with bounded control-plane polling."""

    def __init__(self, deadline: Callable[[], float | None], control: Control | None, poll_interval_s: float = 5.0):
        self.deadline = deadline
        self.control = control
        self.poll_interval_s = poll_interval_s
        self.last_poll = float("-inf")
        self.last_stage: str | None = None

    def check(self, stage: str, completed_frames: int = 0, total_frames: int = 1) -> None:
        now = time.monotonic()
        deadline = self.deadline()
        if deadline is not None and now >= deadline:
            raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")
        if self.control and (stage != self.last_stage or now - self.last_poll >= self.poll_interval_s):
            self.last_stage = stage
            self.last_poll = now
            if self.control({"stage": stage, "completedFrames": completed_frames, "totalFrames": total_frames}):
                raise CancellationRequested("render cancellation requested by control plane")
        deadline = self.deadline()
        if deadline is not None and time.monotonic() >= deadline:
            raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")


def _attestation(
    validation: Mapping[str, object],
    execution_mode: str,
    runtime_evidence: Mapping[str, object],
) -> dict[str, object]:
    worker_image = os.environ.get("SIMFORGE_WORKER_IMAGE_DIGEST", "unavailable")
    worker_revision = os.environ.get("SIMFORGE_WORKER_REVISION", "unavailable")
    return {
        "schema": "simforge.worker-attestation/v1",
        "workerImageDigest": worker_image,
        "workerRevision": worker_revision,
        "carlaVersion": os.environ.get("SIMFORGE_CARLA_VERSION", "0.10.0"),
        "engineVersion": os.environ.get("SIMFORGE_ENGINE_VERSION", "UE5.5"),
        "pythonVersion": platform.python_version(),
        "hostNode": platform.node(),
        "hostPlatform": platform.platform(),
        "executionMode": execution_mode,
        "physicsAuthority": execution_mode == "native-physics",
        "acceptanceEligible": execution_mode == "native-physics",
        "workerIdentityComplete": worker_image != "unavailable" and worker_revision != "unavailable",
        "runtimeEvidence": dict(runtime_evidence),
        "xoscValidation": dict(validation),
    }


def _trace_to_path(plan: ExecutionPlan, readbacks: list[Mapping[str, Mapping[str, object]]], signal_readbacks: list[Mapping[str, str]], collision_readbacks: list[list[Mapping[str, object]]], control_sha256: str, source_input_digest: str, materialized_traffic_digest: str, destination: Path, max_bytes: int, abort: Callable[[], None]) -> Path:
    if len(readbacks) != len(plan.frames) or len(signal_readbacks) != len(plan.frames) or len(collision_readbacks) != len(plan.frames):
        raise RuntimeError("trace readbacks are not frame-closed")
    with destination.open("wb") as raw:
        bounded = _BoundedWriter(raw, max_bytes, "trace")
        with gzip.GzipFile(filename="", mode="wb", fileobj=bounded, compresslevel=6, mtime=0) as encoded:
            encoded.write(b'{"executionPackageControlSha256":')
            encoded.write(json.dumps(control_sha256).encode())
            encoded.write(b',"sourceInputDigest":')
            encoded.write(json.dumps(source_input_digest).encode())
            encoded.write(b',"materializedTrafficDigest":')
            encoded.write(json.dumps(materialized_traffic_digest).encode())
            encoded.write(b',"fixedTimestepS":')
            encoded.write(json.dumps(plan.fixed_timestep_s, separators=(",", ":")).encode())
            encoded.write(b',"frames":[')
            for index, (frame, readback, signals, collisions) in enumerate(zip(plan.frames, readbacks, signal_readbacks, collision_readbacks)):
                abort()
                if index:
                    encoded.write(b",")
                encoded.write(json.dumps({"index": frame.index, "t": frame.t, "actors": readback, "signals": signals, "collisions": collisions}, sort_keys=True, separators=(",", ":")).encode())
            encoded.write(b'],"planSha256":')
            encoded.write(json.dumps(plan.sha256).encode())
            encoded.write(b',"schema":"simforge.render-trace/v1","signalStateSource":"backend-verified"}')
            abort()
    return destination


def _archive_sensor_data(
    sensor_dir: Path,
    destination: Path,
    max_bytes: int,
    abort: Callable[[], None] | None = None,
) -> Path:
    """Consolidate one LiDAR or radar stream into a single upload artifact."""
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for frame in sorted(sensor_dir.rglob("*")):
            if not frame.is_file():
                continue
            if abort:
                abort()
            archive.write(frame, arcname=str(frame.relative_to(sensor_dir)))
    if destination.stat().st_size > max_bytes:
        raise ContractError(f"sensor data artifact {sensor_dir.name} exceeds its budget")
    return destination


def _collect_camera_video(
    frame_dir: Path,
    camera_name: str,
    fps: float,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> Path:
    """Adopt the camera's streamed h264 file and prove it frame-closed.

    Individual camera frames are never written to disk: the backend pipes raw
    frames into one ffmpeg encoder per camera and this collector validates the
    resulting stream against the capture schedule.
    """
    stream = frame_dir / camera_name / "stream.mp4"
    if not stream.is_file() or stream.stat().st_size == 0:
        raise RuntimeError(f"camera {camera_name} produced no encoded video stream")
    if stream.stat().st_size > max_bytes:
        raise ContractError(f"camera video {camera_name} exceeds its output budget")
    probe = _run_process([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames,duration", "-of", "json", str(stream),
    ], "probe_video", check_abort, deadline_monotonic)
    if probe.returncode:
        raise RuntimeError(f"ffprobe failed: {probe.stderr.decode(errors='replace')}")
    try:
        stream_info = json.loads(probe.stdout)["streams"][0]
        frame_count = int(stream_info["nb_read_frames"])
        duration = float(stream_info["duration"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("ffprobe did not return frame-closed video metadata") from exc
    expected_duration = expected_frame_count / fps
    if frame_count != expected_frame_count or abs(duration - expected_duration) > (1 / fps):
        raise RuntimeError(
            f"camera video {camera_name} is not frame-closed: {frame_count} frames/{duration}s, "
            f"expected {expected_frame_count}/{expected_duration}s"
        )
    shutil.copyfile(stream, destination)
    return destination


def _catalog_dims(entry: Mapping[str, object]) -> Mapping[str, float] | None:
    dims = entry.get("dims")
    if not isinstance(dims, Mapping):
        return None
    narrowed: dict[str, float] = {}
    for axis in ("l", "w", "h"):
        value = dims.get(axis)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            return None
        narrowed[axis] = float(value)
    return narrowed


def _apply_actor_fallbacks(
    plan: ExecutionPlan,
    catalog: Mapping[str, Mapping[str, object]],
    abort: Callable[[], None] | None = None,
) -> tuple[ExecutionPlan, tuple[Mapping[str, object], ...]]:
    """Resolve non-native road-user bindings to deterministic same-class CARLA bodies."""
    vehicle_kinds = {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"}
    substitutions: dict[str, str] = {}
    diagnostics: list[Mapping[str, object]] = []
    for actor_id, binding in sorted(plan.actors.items()):
        is_vehicle = binding.kind in vehicle_kinds
        is_pedestrian = binding.kind == "pedestrian"
        if not is_vehicle and not is_pedestrian:
            continue
        authored_entry = catalog.get(binding.catalog_name)
        if not isinstance(authored_entry, Mapping):
            raise ContractError(f"asset catalog has no CARLA binding for road user {actor_id}")
        native_prefixes = ("vehicle.", "bike.") if is_vehicle else ("walker.",)
        authored_blueprint = authored_entry.get("blueprintId")
        if isinstance(authored_blueprint, str) and authored_blueprint.startswith(native_prefixes):
            continue
        authored_class = authored_entry.get("actorClass")
        if not isinstance(authored_class, str) or not authored_class:
            raise ContractError(
                f'road user {actor_id} catalog "{binding.catalog_name}" declares no actorClass'
            )
        authored_dims = _catalog_dims(authored_entry)
        candidates: list[tuple[float, str, Mapping[str, float] | None]] = []
        for catalog_id, entry in catalog.items():
            blueprint = entry.get("blueprintId")
            if entry.get("actorClass") != authored_class or not isinstance(blueprint, str):
                continue
            if not blueprint.startswith(native_prefixes):
                continue
            dims = _catalog_dims(entry)
            distance = (
                abs(dims["l"] - authored_dims["l"])
                + abs(dims["w"] - authored_dims["w"])
                if dims is not None and authored_dims is not None
                else float("inf")
            )
            candidates.append((distance, catalog_id, dims))
        if not candidates:
            raise ContractError(
                "road user has no same-class native CARLA fallback: "
                f'actor={actor_id} catalog="{binding.catalog_name}" class="{authored_class}"'
            )
        _, fallback_id, fallback_dims = min(candidates, key=lambda item: (item[0], item[1]))
        substitutions[actor_id] = fallback_id
        diagnostics.append({
            "actorId": actor_id,
            "authoredCatalogId": binding.catalog_name,
            "fallbackCatalogId": fallback_id,
            "vehicleClass": authored_class,
            "lengthDeltaM": (
                fallback_dims["l"] - authored_dims["l"]
                if fallback_dims is not None and authored_dims is not None else 0.0
            ),
            "widthDeltaM": (
                fallback_dims["w"] - authored_dims["w"]
                if fallback_dims is not None and authored_dims is not None else 0.0
            ),
            "heightDeltaM": (
                fallback_dims["h"] - authored_dims["h"]
                if fallback_dims is not None and authored_dims is not None else 0.0
            ),
        })
    return (
        substitute_actor_catalog_bindings(plan, substitutions, abort),
        tuple(diagnostics),
    )



def _run_process(
    command: list[str],
    stage: str,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> Any:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        while True:
            check_abort(stage, 0, 1)
            remaining = deadline_monotonic() - time.monotonic()
            if remaining <= 0:
                raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")
            try:
                stdout, stderr = process.communicate(timeout=min(1.0, remaining))
                check_abort(stage, 1, 1)
                return type("ProcessResult", (), {"returncode": process.returncode, "stdout": stdout, "stderr": stderr})()
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        process.kill()
        process.communicate()
        raise


def _capture_schedule(plan: ExecutionPlan, fps: float, abort: Callable[[], None] | None = None) -> dict[int, tuple[int, float]]:
    check = abort or (lambda: None)
    check()
    if not plan.frames or plan.frames[0].t != 0:
        raise RuntimeError("execution plan must begin at t=0")
    duration = plan.frames[-1].t
    exact_count = duration * fps
    expected_count = round(exact_count)
    if abs(exact_count - expected_count) > 1e-6:
        raise RuntimeError("scenario duration multiplied by render fps must be an integer")
    schedule: dict[int, tuple[int, float]] = {}
    for output_index in range(expected_count):
        if output_index % 50 == 0:
            check()
        scheduled_time = output_index / fps
        plan_index = round(scheduled_time / plan.fixed_timestep_s)
        if plan_index in schedule or plan_index >= len(plan.frames) - 1:
            raise RuntimeError("render fps cannot be represented by unique 50 Hz CARLA frames")
        schedule[plan_index] = (output_index, scheduled_time)
    check()
    return schedule


def _annotations_to_path(plan: ExecutionPlan, readbacks: list[Mapping[str, Mapping[str, float]]], capture_schedule: Mapping[int, tuple[int, float]], destination: Path, max_bytes: int, abort: Callable[[], None]) -> Path:
    with destination.open("wb") as target:
        bounded = _BoundedWriter(target, max_bytes, "annotations")
        for plan_index, (output_index, scheduled_time) in sorted(capture_schedule.items(), key=lambda item: item[1][0]):
            abort()
            frame, actors = plan.frames[plan_index], readbacks[plan_index]
            bounded.write(json.dumps({
            "schema": "simforge.annotation-frame/v1",
            "index": output_index,
            "scheduledTimeS": scheduled_time,
            "simulationFrameIndex": frame.index,
            "t": frame.t,
            "actors": actors,
            "signals": frame.signals,
            }, sort_keys=True, separators=(",", ":")).encode() + b"\n")
        abort()
    return destination


def _appearance_capability(plan: ExecutionPlan, abort: Callable[[], None] | None = None) -> dict[str, list[str]]:
    """Report which authored appearance state reaches pixels, and which does not.

    `cue.*` keys are OpenSCENARIO `UserDefinedAnimation` requests (`pose.*`
    articulation, `audio.horn`). The plan carries them faithfully, CARLA cannot
    render them, and this makes that visible in the run's own outputs instead of
    leaving the omission silent.
    """
    rendered: set[str] = set()
    unrendered: set[str] = set()
    despawned: set[str] = set()
    for frame in plan.frames:
        if abort:
            abort()
        for actor_id, state in frame.actors.items():
            if state.lifecycle == LIFECYCLE_ABSENT:
                despawned.add(actor_id)
            for key in state.appearance:
                (unrendered if key.startswith("cue.") else rendered).add(key)
    return {
        "rendered": sorted(rendered),
        "unrenderedCues": sorted(unrendered),
        "despawnedActors": sorted(despawned),
    }


def _preflight_execution_semantics(lease: Lease, plan: ExecutionPlan) -> dict[str, str]:
    """Reject semantics the selected execution mode cannot honestly execute.

    Returns the actors to drop before spawn (with the recorded reason):
    authored knockdown poses cannot execute under native physics without a
    post-spawn teleport repair, so the posed actor is dropped and reported in
    the manifest instead of failing the whole render.
    """
    if lease.render_spec.execution_mode != "native-physics":
        return {}
    downed_actors = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if state.downed
    })
    execution_drops = {
        actor_id: "native physics cannot execute authored knockdown poses without post-spawn teleport repair"
        for actor_id in downed_actors
    }
    appearance = _appearance_capability(plan)
    cue_actors = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if any(key.startswith("cue.") for key in state.appearance)
    })
    for actor_id in cue_actors:
        execution_drops.setdefault(
            actor_id,
            "native physics dropped actor with unsupported appearance cue",
        )
    reverse_non_vehicles = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if actor_id not in execution_drops
        and state.speed_mps < -1e-6
        and plan.actors[actor_id].kind not in {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"}
    })
    for actor_id in reverse_non_vehicles:
        execution_drops.setdefault(
            actor_id,
            "native physics dropped non-vehicle actor with signed reverse motion",
        )
    unsupported_moving = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if actor_id not in execution_drops
        and abs(state.speed_mps) > 1e-6
        and plan.actors[actor_id].kind in {"animal", "static", "static_object"}
    })
    for actor_id in unsupported_moving:
        execution_drops.setdefault(
            actor_id,
            "native physics dropped moving non-actuated actor",
        )
    dropped_mounts = sorted({
        sensor.actor_id for sensor in lease.render_spec.sensors
        if sensor.actor_id in execution_drops
    })
    if dropped_mounts:
        raise ContractError(
            "native sensors cannot attach to actors dropped from execution: "
            + ", ".join(dropped_mounts)
        )
    vehicle_kinds = {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"}
    invalid_vehicle_appearance = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if actor_id not in execution_drops
        and any(key.startswith(("light.", "door.")) for key in state.appearance)
        and plan.actors[actor_id].kind not in vehicle_kinds
    })
    if invalid_vehicle_appearance:
        raise ContractError(
            "native physics vehicle appearance actions target non-vehicle actors: "
            + ", ".join(invalid_vehicle_appearance)
        )
    despawned = set(appearance["despawnedActors"])
    invalid_mounts = sorted({
        sensor.actor_id for sensor in lease.render_spec.sensors
        if sensor.actor_id in despawned
    })
    if invalid_mounts:
        raise ContractError(
            "native sensors cannot remain frame-closed when their attached actor is deleted: "
            + ", ".join(invalid_mounts)
        )
    return execution_drops


def _optional_backend_call(backend: RenderBackend, name: str, *args: object, abort: Callable[[], None]) -> Any:
    method = getattr(backend, name, None)
    if not callable(method):
        return None
    return method(*args, abort=abort)


def _preflight_asset_semantics(
    plan: ExecutionPlan,
    catalog: Mapping[str, Mapping[str, object]],
) -> None:
    vehicle_kinds = {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"}
    for actor_id, binding in plan.actors.items():
        entry = catalog.get(binding.catalog_name)
        blueprint = entry.get("blueprintId") if entry else None
        if not blueprint:
            raise ContractError(f"asset catalog has no CARLA blueprint for {actor_id}")
        if binding.kind in vehicle_kinds and not blueprint.startswith(("vehicle.", "bike.")):
            raise ContractError(f"vehicle actor {actor_id} is bound to non-vehicle CARLA blueprint {blueprint}")
        if binding.kind == "pedestrian" and not blueprint.startswith("walker."):
            raise ContractError(f"pedestrian actor {actor_id} is bound to non-walker CARLA blueprint {blueprint}")


def _manifest_to_path(
    lease: Lease,
    plan: ExecutionPlan,
    sensor_records: list[Mapping[str, Any]],
    validation: Mapping[str, object],
    parity: Mapping[str, object],
    parity_evidence: Mapping[str, object],
    attestation: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    destination: Path,
    max_bytes: int,
    abort: Callable[[], None],
    carla_vehicle_fallbacks: tuple[Mapping[str, object], ...],
) -> Path:
    value = {
        "schema": "simforge.render-manifest/v1",
        "jobId": lease.job_id,
        "attempt": lease.attempt,
        "executionPackageId": lease.execution_package.id,
        "executionPackageControlSha256": lease.execution_package.control_sha256,
        "executionManifestSha256": lease.execution_package.manifest.sha256,
        "revisionId": lease.execution_package.revision_id,
        "sourceInputDigest": lease.execution_package.source_input_digest,
        "materializedTrafficDigest": lease.execution_package.materialized_traffic_digest,
        "planSha256": plan.sha256,
        "renderSpec": asdict(lease.render_spec),
        "jobMode": lease.job_mode,
        "ambient": {key: value for key, value in lease.execution_package.ambient.items() if key != "materializedTraffic"},
        "inputs": {
            "manifest": {"sha256": lease.execution_package.manifest.sha256, "sizeBytes": lease.execution_package.manifest.size_bytes},
            "xosc": {"sha256": lease.execution_package.xosc.sha256, "sizeBytes": lease.execution_package.xosc.size_bytes, "xsdSha256": lease.execution_package.xosc.xsd_sha256},
            "xodr": {"sha256": lease.execution_package.xodr.sha256, "sizeBytes": lease.execution_package.xodr.size_bytes, "mapName": lease.execution_package.xodr.map_name},
            "assetCatalog": {"sha256": lease.execution_package.asset_catalog.sha256, "sizeBytes": lease.execution_package.asset_catalog.size_bytes, "catalogVersionId": lease.execution_package.asset_catalog.catalog_version_id},
        },
        "runtimeRequirements": asdict(lease.execution_package.runtime_requirements),
        "xoscValidation": dict(validation),
        "workerAttestation": dict(attestation),
        "parity": dict(parity),
        "carlaVehicleFallbacks": [dict(item) for item in carla_vehicle_fallbacks],
        "parityEvidence": dict(parity_evidence),
        "artifacts": [dict(item) for item in artifacts],
        "sensorFrames": sensor_records,
        "capture": {
            "frameCount": len(sensor_records) // max(1, len(lease.render_spec.sensors)),
            "fps": lease.render_spec.fps,
            "durationS": plan.frames[-1].t,
        },
        "capabilities": {
            "execution": lease.render_spec.execution_mode,
            "sensors": sorted({sensor.modality for sensor in lease.render_spec.sensors}),
            "fixedTimestepS": plan.fixed_timestep_s,
            "appearance": _appearance_capability(plan, abort),
        },
    }
    with destination.open("wb") as target:
        bounded = _BoundedWriter(target, max_bytes, "manifest")
        for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(value):
            abort()
            bounded.write(chunk.encode())
        abort()
    return destination


def _collision_onsets(events: object, fixed_timestep_s: float, *, authored: bool) -> dict[tuple[str, str], int]:
    result: dict[tuple[str, str], int] = {}
    if not isinstance(events, (list, tuple)):
        return result
    for item in events:
        if not isinstance(item, Mapping):
            continue
        if authored:
            if item.get("kind") != "collision":
                continue
            left, right = item.get("a"), item.get("b")
            t = item.get("t")
            if not isinstance(t, (int, float)):
                continue
            frame = round(float(t) / fixed_timestep_s)
        else:
            pair = item.get("pair")
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                continue
            left, right = pair
            frame = item.get("frame")
            if not isinstance(frame, int):
                continue
        if not isinstance(left, str) or not left or not isinstance(right, str) or not right or left == right:
            continue
        pair_key = tuple(sorted((left, right)))
        result[pair_key] = min(frame, result.get(pair_key, frame))
    return result



_ENVIRONMENT_FIELDS = (
    "cloudiness",
    "precipitation",
    "precipitation_deposits",
    "wind_intensity",
    "sun_azimuth_angle",
    "sun_altitude_angle",
    "fog_density",
    "fog_distance",
    "wetness",
)


def _environment_values_match(
    actual: object,
    expected: Mapping[str, float],
) -> bool:
    if not isinstance(actual, Mapping) or set(actual) != set(_ENVIRONMENT_FIELDS):
        return False
    for field in _ENVIRONMENT_FIELDS:
        value = actual.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        difference = (
            abs((float(expected[field]) - float(value) + 180.0) % 360.0 - 180.0)
            if field == "sun_azimuth_angle"
            else abs(float(expected[field]) - float(value))
        )
        if difference > 1e-4:
            return False
    return True


def _is_baked_default_daylight(requested: Mapping[str, float]) -> bool:
    return (
        all(float(requested[field]) == 0.0 for field in (
            "cloudiness", "precipitation", "precipitation_deposits",
            "wind_intensity", "fog_density", "fog_distance", "wetness",
        ))
        and float(requested["sun_altitude_angle"]) >= 0.0
    )


def _environment_evidence_is_accepted(environment: object, requested: object) -> bool:
    if not isinstance(environment, Mapping):
        return False
    expected = {field: float(getattr(requested, field)) for field in _ENVIRONMENT_FIELDS}
    if environment.get("schema") != "simforge.environment-evidence/v1":
        return False
    if not _environment_values_match(environment.get("requested"), expected):
        return False
    if environment.get("available") is True and environment.get("exact") is True:
        return (
            set(environment) == {"schema", "available", "exact", "requested", "observed"}
            and _environment_values_match(environment.get("observed"), expected)
        )
    return (
        set(environment) == {
            "schema", "available", "exact", "requested", "observed", "mode", "reason",
        }
        and environment.get("available") is True
        and environment.get("exact") is False
        and environment.get("observed") is None
        and environment.get("mode") == "cooked-baked-default"
        and environment.get("reason") == "custom-map-baked-default-daylight"
        and _is_baked_default_daylight(expected)
    )

def _parity_evidence(
    lease: Lease,
    plan: ExecutionPlan,
    parity: object,
    runtime_evidence: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    expected_capture_count: int,
    spawn_placement: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metadata = plan.semantic_metadata
    semantic_failures: list[str] = []
    if not metadata.get("complete"):
        semantic_failures.append("semantic-metadata-incomplete")
    for field, check_id in (
        ("lifecycle_mismatches", "actor-lifecycle"),
        ("signal_mismatches", "traffic-signal-state"),
        ("discrete_mismatches", "actor-discrete-state"),
    ):
        if int(getattr(parity, field, 0)) > 0:
            semantic_failures.append(check_id)
    if lease.render_spec.execution_mode == "native-physics":
        if (
            runtime_evidence.get("available") is not True
            or runtime_evidence.get("physicsAuthority") is not True
            or runtime_evidence.get("motionApplication") != "native-controls"
        ):
            semantic_failures.append("native-physics-authority")
        map_evidence = runtime_evidence.get("map")
        runtime_xodr_sha256 = (
            map_evidence.get("runtimeXodrSha256")
            if isinstance(map_evidence, Mapping) else None
        )
        signal_identity_mode = (
            map_evidence.get("signalIdentityMode")
            if isinstance(map_evidence, Mapping) else None
        )
        signal_id_map = (
            map_evidence.get("signalIdMap")
            if isinstance(map_evidence, Mapping) else None
        )
        if (
            not isinstance(map_evidence, Mapping)
            or map_evidence.get("schema") != "simforge.carla-map-evidence/v1"
            or map_evidence.get("available") is not True
            or map_evidence.get("source") != "cooked-custom-map"
            or map_evidence.get("identityMode") != "cooked-map-name"
            or map_evidence.get("requestedMapName") != lease.execution_package.xodr.map_name
            or map_evidence.get("loadedMapName") != lease.execution_package.xodr.map_name
            or map_evidence.get("packageXodrSha256") != lease.execution_package.xodr.sha256
            or not isinstance(runtime_xodr_sha256, str)
            or len(runtime_xodr_sha256) != 64
            or any(character not in "0123456789abcdef" for character in runtime_xodr_sha256)
            or map_evidence.get("xodrByteExact") is not (
                runtime_xodr_sha256 == lease.execution_package.xodr.sha256
            )
            or signal_identity_mode not in {
                "direct-opendrive-id", "approved-cooked-map-remap",
            }
            or not isinstance(signal_id_map, Mapping)
            or any(
                not isinstance(authored_id, str)
                or not authored_id
                or not isinstance(runtime_id, str)
                or not runtime_id
                for authored_id, runtime_id in signal_id_map.items()
            )
            or len(set(signal_id_map.values())) != len(signal_id_map)
            or (signal_identity_mode == "direct-opendrive-id" and bool(signal_id_map))
            or (signal_identity_mode == "approved-cooked-map-remap" and not signal_id_map)
            or map_evidence.get("exact") is not True
        ):
            semantic_failures.append("cooked-map-identity")
        environment = runtime_evidence.get("environment")
        if not _environment_evidence_is_accepted(environment, lease.render_spec.environment):
            semantic_failures.append("environment-readback")
        sensor_evidence = runtime_evidence.get("sensors")
        expected_sensor_ids = {sensor.artifact_name for sensor in lease.render_spec.sensors}
        if not isinstance(sensor_evidence, Mapping) or set(sensor_evidence) != expected_sensor_ids:
            semantic_failures.append("sensor-identity-closure")
        else:
            for sensor_id in sorted(expected_sensor_ids):
                value = sensor_evidence[sensor_id]
                if not isinstance(value, Mapping) or value.get("capturedFrames") != expected_capture_count:
                    semantic_failures.append(f"sensor-frame-closure:{sensor_id}")
        if any(sensor.modality == "rgb" for sensor in lease.render_spec.sensors):
            visual = runtime_evidence.get("visualQuality")
            if not isinstance(visual, Mapping) or visual.get("verdict") != "pass":
                semantic_failures.append("visual-quality")

    global_failed_actor_ids = list(getattr(parity, "failed_actor_ids", ()))
    violation_counts = dict(getattr(parity, "violation_counts", {}))
    reference_violation_counts = dict(getattr(parity, "reference_violation_counts", {}))
    reference_thresholds = dict(getattr(parity, "reference_thresholds", {}))
    acceptance_thresholds = dict(getattr(parity, "acceptance_thresholds", {}))
    max_error = dict(getattr(parity, "max_error", {}))
    expected_collisions = _collision_onsets(metadata.get("events"), plan.fixed_timestep_s, authored=True)
    actual_collisions = _collision_onsets(getattr(parity, "collision_events", ()), plan.fixed_timestep_s, authored=False)
    collision_pairs = sorted(set(expected_collisions) | set(actual_collisions))
    failed_pairs = [
        list(pair)
        for pair in collision_pairs
        if expected_collisions.get(pair) != actual_collisions.get(pair)
    ]
    collisions_passed = not failed_pairs

    # Native contact response is intentionally CARLA-owned. Once every
    # authored pair and onset matches exactly, trajectory acceptance remains
    # strict through the first-contact frame and the later physics tail is
    # evidence, not a replay requirement. A missing, unexpected, or mistimed
    # contact disables this exception and keeps the full trajectory blocking.
    segments = getattr(parity, "segments", {})
    through_contact = segments.get("throughFirstContact", {}) if isinstance(segments, Mapping) else {}
    post_contact = segments.get("postContact", {}) if isinstance(segments, Mapping) else {}
    through_violations = dict(through_contact.get("violationCounts", {})) if isinstance(through_contact, Mapping) else {}
    post_violations = dict(post_contact.get("violationCounts", {})) if isinstance(post_contact, Mapping) else {}
    post_max_error = dict(post_contact.get("maxError", {})) if isinstance(post_contact, Mapping) else {}
    segment_failed = getattr(parity, "segment_failed_actor_ids", {})
    matched_authored_contact = bool(expected_collisions) and collisions_passed
    if matched_authored_contact:
        failed_actor_ids = list(segment_failed.get("throughFirstContact", ())) if isinstance(segment_failed, Mapping) else []
        blocking_violations = through_violations
        acceptance_gate = "through-first-contact"
    else:
        failed_actor_ids = global_failed_actor_ids
        blocking_violations = violation_counts
        acceptance_gate = "full-trajectory"
    post_contact_failed_actor_ids = (
        list(segment_failed.get("postContact", ())) if isinstance(segment_failed, Mapping) else []
    )
    trajectory_passed = not failed_actor_ids and not any(int(value) for value in blocking_violations.values())
    trajectory_metrics: dict[str, float] = {"samples": float(getattr(parity, "samples", 0))}
    for key, value in sorted(max_error.items()):
        trajectory_metrics[f"max.{key}"] = float(value)
    for key, value in sorted(violation_counts.items()):
        trajectory_metrics[f"violations.{key}"] = float(value)
    for key, value in sorted(reference_violation_counts.items()):
        trajectory_metrics[f"referenceViolations.{key}"] = float(value)
    for key, value in sorted(reference_thresholds.items()):
        trajectory_metrics[f"referenceThreshold.{key}"] = float(value)
    for key, value in sorted(acceptance_thresholds.items()):
        trajectory_metrics[f"acceptanceThreshold.{key}"] = float(value)
    for prefix, segment_value in (("throughFirstContact", through_contact), ("postContact", post_contact)):
        if not isinstance(segment_value, Mapping):
            continue
        trajectory_metrics[f"{prefix}.samples"] = float(segment_value.get("samples", 0))
        for key, value in sorted(dict(segment_value.get("maxError", {})).items()):
            trajectory_metrics[f"{prefix}.max.{key}"] = float(value)
        for key, value in sorted(dict(segment_value.get("violationCounts", {})).items()):
            trajectory_metrics[f"{prefix}.violations.{key}"] = float(value)

    produced_kinds = {
        str(item.get("kind")) for item in artifacts
        if isinstance(item.get("kind"), str)
    }
    expected_kinds: set[str] = set(lease.render_spec.outputs)
    if "video" in lease.render_spec.outputs:
        primary_rgb = next(
            (sensor for sensor in lease.render_spec.sensors if sensor.modality == "rgb"), None,
        )
        expected_kinds.update(
            f"sensorVideo:{sensor.artifact_name}"
            for sensor in lease.render_spec.sensors
            if sensor is not primary_rgb
        )
    expected_kinds.update(
        f"sensorData:{sensor.artifact_name}"
        for sensor in lease.render_spec.sensors
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}
    )
    if lease.render_spec.execution_mode == "native-physics":
        expected_kinds.update({"manifest", "parity-report"})
    predicted_kinds = {
        kind for kind in ("manifest", "parity-report")
        if kind in lease.artifact_uploads
    }
    verified_kinds = sorted(produced_kinds | predicted_kinds)
    missing_kinds = sorted(expected_kinds - set(verified_kinds))

    placement_actors = (
        spawn_placement.get("actors")
        if isinstance(spawn_placement, Mapping) else None
    )
    placement_actors = placement_actors if isinstance(placement_actors, Mapping) else {}
    dropped_actor_ids = sorted(
        str(item) for item in (
            spawn_placement.get("droppedActorIds", ())
            if isinstance(spawn_placement, Mapping) else ()
        )
    )
    nudged_actor_ids = sorted(
        str(item) for item in (
            spawn_placement.get("nudgedActorIds", ())
            if isinstance(spawn_placement, Mapping) else ()
        )
    )

    divergences: list[dict[str, object]] = []
    if matched_authored_contact:
        for key, value in sorted(post_max_error.items()):
            if float(value) > 0:
                divergences.append({
                    "code": f"native-physics:post-contact:{key}",
                    "classification": "expected-carla-physics",
                    "details": {
                        "segment": "postContact",
                        "maximum": float(value),
                        "violationCount": int(post_violations.get(key, 0)),
                    },
                })
    elif trajectory_passed:
        for key, value in sorted(max_error.items()):
            reference_violations = int(reference_violation_counts.get(key, 0))
            if reference_violations > 0:
                divergences.append({
                    "code": f"native-physics:{key}",
                    "classification": "expected-carla-physics",
                    "details": {
                        "maximum": float(value),
                        "referenceThreshold": float(reference_thresholds[key]),
                        "acceptanceThreshold": float(acceptance_thresholds[key]),
                        "referenceViolationCount": reference_violations,
                        "acceptanceViolationCount": int(violation_counts.get(key, 0)),
                    },
                })
    if lease.render_spec.execution_mode != "native-physics":
        divergences.append({
            "code": "diagnostic-replay-not-acceptance-eligible",
            "classification": "unclassified",
        })
    for actor_id in dropped_actor_ids:
        details = placement_actors.get(actor_id)
        details = dict(details) if isinstance(details, Mapping) else {}
        dropped_kind = (
            "dropped-execution-semantics"
            if details.get("cause") == "execution-semantics"
            else "dropped-unplaceable"
        )
        divergences.append({
            "code": f"spawn-placement:{dropped_kind}:{actor_id}",
            "classification": "spawn-placement-drop",
            "details": details,
        })
    for actor_id in nudged_actor_ids:
        details = placement_actors.get(actor_id)
        divergences.append({
            "code": f"spawn-placement:nudged:{actor_id}",
            "classification": "spawn-placement-nudge",
            "details": dict(details) if isinstance(details, Mapping) else {},
        })

    semantics_passed = not semantic_failures
    artifacts_passed = not missing_kinds
    overall = (
        lease.render_spec.execution_mode == "native-physics"
        and semantics_passed
        and trajectory_passed
        and collisions_passed
        and artifacts_passed
    )
    return {
        "schema": "simforge.parity-evidence/v1",
        "identity": {
            "revisionId": lease.execution_package.revision_id,
            "executionPackageId": lease.execution_package.id,
            "executionPackageControlSha256": lease.execution_package.control_sha256,
            "sourceInputDigest": lease.execution_package.source_input_digest,
            "planSha256": plan.sha256,
        },
        "execution": {
            "mode": lease.render_spec.execution_mode,
            "fixedTimestepS": plan.fixed_timestep_s,
        },
        "semantics": {
            "verdict": "pass" if semantics_passed else "fail",
            "evaluatedInteractionCount": len(metadata.get("interactionIds", [])),
            "unclassifiedDifferenceCount": len(semantic_failures),
            "failedCheckIds": sorted(set(semantic_failures)),
        },
        "trajectory": {
            "verdict": "pass" if trajectory_passed else "fail",
            "acceptanceGate": acceptance_gate,
            "evaluatedActorCount": len(plan.actors) - len(dropped_actor_ids),
            "droppedActorIds": dropped_actor_ids,
            "nudgedActorIds": nudged_actor_ids,
            "failedActorIds": sorted(failed_actor_ids),
            "postContactFailedActorIds": sorted(post_contact_failed_actor_ids),
            "postContactClassification": "expected-carla-physics" if matched_authored_contact else "blocking",
            "metrics": trajectory_metrics,
        },
        "collisions": {
            "verdict": "pass" if collisions_passed else "fail",
            "evaluatedPairCount": len(collision_pairs),
            "failedPairs": failed_pairs,
        },
        "artifacts": {
            "verdict": "pass" if artifacts_passed else "fail",
            "verifiedKinds": verified_kinds,
            "missingKinds": missing_kinds,
        },
        "divergences": divergences,
        "verdict": "pass" if overall else "fail",
    }


def _verify_execution_manifest(lease: Lease, body: bytes) -> Mapping[str, Any]:
    lease.execution_package.manifest.verify(body, "manifest")
    try:
        manifest = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("execution manifest must be valid UTF-8 JSON") from exc
    if not isinstance(manifest, Mapping) or manifest.get("contract") != SCHEMA:
        raise ContractError(f"execution manifest contract must equal {SCHEMA}")
    if manifest.get("openScenarioProfile") != "ASAM OpenSCENARIO XML 1.4":
        raise ContractError("execution manifest identifies an unsupported OpenSCENARIO profile")
    if manifest.get("xsdSha256") != lease.execution_package.xosc.xsd_sha256:
        raise ContractError("execution manifest XSD digest does not match the control package")
    revision = manifest.get("revision")
    if not isinstance(revision, Mapping) or revision.get("id") != lease.execution_package.revision_id:
        raise ContractError("execution manifest revision does not match the control package")
    if not isinstance(revision.get("sha256"), str) or len(revision["sha256"]) != 64:
        raise ContractError("execution manifest revision digest is missing")
    if manifest.get("sourceInputDigest") != lease.execution_package.source_input_digest:
        raise ContractError("execution manifest source input digest does not match the control package")
    if manifest.get("materializedTrafficDigest") != lease.execution_package.materialized_traffic_digest:
        raise ContractError("execution manifest materialized traffic digest does not match the control package")
    map_value = manifest.get("map")
    if not isinstance(map_value, Mapping) or (
        map_value.get("assetId") != lease.execution_package.map_asset_id
        or map_value.get("versionId") != lease.execution_package.map_version_id
        or map_value.get("xodrSha256") != lease.execution_package.xodr.sha256
    ):
        raise ContractError("execution manifest map digest does not match the control package")
    catalog = manifest.get("assetCatalog")
    if not isinstance(catalog, Mapping) or (
        catalog.get("versionId") != lease.execution_package.asset_catalog.catalog_version_id
        or catalog.get("manifestSha256") != lease.execution_package.asset_catalog.sha256
    ):
        raise ContractError("execution manifest asset catalog does not match the control package")
    ambient = manifest.get("ambient")
    control_ambient = lease.execution_package.ambient
    ambient_fields = {
        "mode": control_ambient["ambientMode"],
        "ambientConfig": control_ambient["ambientConfig"],
        "configSha256": control_ambient["configSha256"],
        "resultSha256": control_ambient["resultSha256"],
        **({"runtimeVersion": control_ambient["runtimeVersion"], "seed": control_ambient["seed"]} if control_ambient["ambientMode"] == "native" else {}),
        **({
            "sumoVersion": control_ambient["sumoVersion"],
            "networkSha256": control_ambient["networkSha256"],
            "seed": control_ambient["seed"],
        } if control_ambient["ambientMode"] == "sumo" else {}),
    }
    if not isinstance(ambient, Mapping):
        raise ContractError("execution manifest ambient provenance does not match the control package")
    manifest_ambient = dict(ambient)
    ambient_materialized = manifest_ambient.pop("materializedTraffic", None)
    if manifest_ambient != ambient_fields:
        raise ContractError("execution manifest ambient provenance does not match the control package")
    expected_materialized_identity = {
        "sha256": lease.execution_package.materialized_traffic_digest,
        "sizeBytes": lease.execution_package.ambient["materializedTraffic"].size_bytes,
        "sourceInputDigest": lease.execution_package.source_input_digest,
        "mapAssetId": lease.execution_package.map_asset_id,
        "mapVersionId": lease.execution_package.map_version_id,
    }
    if not isinstance(ambient_materialized, Mapping) or set(ambient_materialized) != {"artifactId", *expected_materialized_identity} or (
        not isinstance(ambient_materialized.get("artifactId"), str) or not ambient_materialized["artifactId"]
        or any(ambient_materialized.get(key) != expected for key, expected in expected_materialized_identity.items())
    ):
        raise ContractError("execution manifest ambient materialized traffic identity does not match the control package")
    manifest_materialized = manifest.get("materializedTraffic")
    overlap_actor_ids = manifest_materialized.get("overlapActorIds") if isinstance(manifest_materialized, Mapping) else None
    if not isinstance(overlap_actor_ids, list) or not all(
        isinstance(actor_id, str) and actor_id.startswith("ambient:") for actor_id in overlap_actor_ids
    ) or overlap_actor_ids != sorted(set(overlap_actor_ids)):
        raise ContractError("execution manifest materialized traffic overlap membership is invalid")
    if not isinstance(manifest_materialized, Mapping) or set(manifest_materialized) != {"artifactId", "sha256", "sizeBytes", "overlapActorIds"} or (
        manifest_materialized.get("artifactId") != ambient_materialized["artifactId"]
        or manifest_materialized.get("sha256") != lease.execution_package.materialized_traffic_digest
        or manifest_materialized.get("sizeBytes") != lease.execution_package.ambient["materializedTraffic"].size_bytes
    ):
        raise ContractError("execution manifest materialized traffic file does not match the control package")
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ContractError("execution manifest files must be an array")
    xosc_entries = [item for item in files if isinstance(item, Mapping) and item.get("kind") == "xosc"]
    expected_xosc = {
        "kind": "xosc", "mediaType": "application/xml",
        "sha256": lease.execution_package.xosc.sha256,
        "sizeBytes": lease.execution_package.xosc.size_bytes,
    }
    if xosc_entries != [expected_xosc]:
        raise ContractError("execution manifest XOSC file does not match the control package")
    return manifest

def _verify_xosc_source_input_digest(lease: Lease, xosc: bytes) -> None:
    reject_unsafe_xml_envelope(xosc)
    try:
        root = ET.fromstring(xosc)
    except ET.ParseError as exc:
        raise ContractError("OpenSCENARIO XML is not well formed") from exc
    values = [
        item.get("value")
        for item in root.findall("./FileHeader/Properties/Property")
        if item.get("name") in {"simforge.provenance.inputHash", "uniscenarios.provenance.inputHash"}
    ]
    if values != [lease.execution_package.source_input_digest]:
        raise ContractError("OpenSCENARIO source input digest does not match the control package")


def _enforce_render_budgets(lease: Lease, plan: ExecutionPlan, capture_count: int) -> None:
    duration = plan.frames[-1].t
    if duration < 0 or duration > MAX_DURATION_SECONDS:
        raise ContractError(f"scenario duration must be between 0 and {MAX_DURATION_SECONDS:g} seconds")
    if capture_count > MAX_CAPTURE_FRAMES:
        raise ContractError(f"render capture exceeds {MAX_CAPTURE_FRAMES} frames")
    camera_pixels = sum(
        int(sensor.config["width"]) * int(sensor.config["height"])
        for sensor in lease.render_spec.sensors
        if sensor.modality in CAMERA_MODALITIES
    ) * capture_count
    if camera_pixels > MAX_SENSOR_PIXELS:
        raise ContractError(f"render capture exceeds {MAX_SENSOR_PIXELS} sensor pixels")
    point_bytes = 0
    for sensor in lease.render_spec.sensors:
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}:
            bytes_per_point = 24 if sensor.modality == "semantic-lidar" else 16
            point_bytes += int(sensor.config["pointsPerSecond"]) * bytes_per_point * duration
    # Cameras never land raw frames on disk: each streams into its ffmpeg
    # encoder and only the encoded mp4 plus per-frame bookkeeping remains.
    frame_file_count = len(lease.render_spec.sensors) * capture_count
    projected_bytes = point_bytes + frame_file_count * 4096
    if projected_bytes > MAX_OUTPUT_BYTES:
        raise ContractError("projected raw capture exceeds the temporary-disk budget")


def _body_size(body: ArtifactBody) -> int:
    return body.stat().st_size if isinstance(body, Path) else len(body)


def _capture_temp_bytes(output_dir: Path, abort: Callable[[], None]) -> int:
    total = 0
    if not output_dir.exists():
        return 0
    for path in output_dir.rglob("*"):
        if not path.is_file():
            continue
        abort()
        total += path.stat().st_size + 4096
        if total > MAX_OUTPUT_BYTES:
            raise ContractError("captured frames exceed the shared temporary-disk budget")
    abort()
    return total


def _body_digest(
    body: ArtifactBody,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
) -> str:
    digest = hashlib.sha256()
    if isinstance(body, Path):
        with body.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic():
                    raise LeaseDeadlineExceeded("lease deadline exceeded while hashing artifact")
                if abort:
                    abort()
                digest.update(chunk)
    else:
        digest.update(body)
    return digest.hexdigest()


def _enforce_output_budget(current_bytes: int, body: ArtifactBody, kind: str) -> None:
    size = _body_size(body)
    if size > MAX_ARTIFACT_BYTES:
        raise ContractError(f"artifact {kind} exceeds {MAX_ARTIFACT_BYTES} bytes")
    if current_bytes + size > MAX_OUTPUT_BYTES:
        raise ContractError(f"render outputs exceed {MAX_OUTPUT_BYTES} bytes")


def _artifact(
    kind: str,
    body: ArtifactBody,
    media_type: str,
    reservation: Mapping[str, Any] | None,
    uploader: Upload,
    metadata: Mapping[str, object] | None = None,
    authorize_upload: Callable[[str, str, int, str, Mapping[str, Any]], Mapping[str, Any]] | None = None,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
    precomputed_digest: str | None = None,
) -> dict[str, object]:
    size = _body_size(body)
    digest = precomputed_digest or _body_digest(body, deadline_monotonic, abort)
    if not reservation:
        raise RuntimeError(f"control plane did not reserve required artifact upload {kind}")
    bound = authorize_upload(kind, digest, size, media_type, reservation) if authorize_upload else reservation
    required_headers = bound.get("requiredHeaders")
    if not isinstance(required_headers, Mapping) or not required_headers:
        raise ContractError(f"artifact upload binding {kind} has no requiredHeaders contract")
    if not all(isinstance(name, str) and name and isinstance(value, str) for name, value in required_headers.items()):
        raise ContractError(f"artifact upload binding {kind} has invalid requiredHeaders")
    content_types = [value for name, value in required_headers.items() if name.lower() == "content-type"]
    if content_types != [media_type]:
        raise ContractError(f"artifact upload binding {kind} has mismatched content-type")
    if uploader is upload:
        uploader(
            bound["uploadUrl"], body, media_type, dict(required_headers),
            deadline_monotonic=deadline_monotonic, abort=abort,
        )
    else:
        if abort:
            abort()
        uploader(bound["uploadUrl"], body, media_type, dict(required_headers))
        if abort:
            abort()
    return {"kind": kind, "artifactUrl": bound["artifactUrl"], "sha256": digest, "sizeBytes": size, "mediaType": media_type, **({"metadata": dict(metadata)} if metadata else {})}


def execute_lease(
    lease: Lease,
    backend: RenderBackend,
    validator: Validate,
    downloader: Download = download,
    uploader: Upload = upload,
    progress: Callable[[str, Mapping[str, object]], None] | None = None,
    control: Control | None = None,
    authorize_upload: Callable[[str, str, int, str, Mapping[str, Any]], Mapping[str, Any]] | None = None,
    deadline_monotonic: Deadline | None = None,
    runtime_asset_overrides: Mapping[str, Mapping[str, str]] | None = None,
) -> dict[str, object]:
    emit = progress or (lambda _event, _payload: None)
    def deadline_value() -> float | None:
        if deadline_monotonic is None:
            return None
        return deadline_monotonic() if callable(deadline_monotonic) else deadline_monotonic

    def absolute_deadline() -> float:
        value = deadline_value()
        return value if value is not None else float("inf")

    def rpc_timeout(stage: str) -> float:
        deadline = deadline_value()
        return 60.0 if deadline is None else max(0.001, min(60.0, deadline - time.monotonic()))

    fence = _ExecutionFence(deadline_value, control)
    check_abort = fence.check

    def backend_fence(stage: str, completed_frames: int = 0, total_frames: int = 1) -> None:
        check_abort(stage, completed_frames, total_frames)
        backend.set_rpc_timeout(rpc_timeout(stage))

    def fetch(stage: str, url: str, maximum: int) -> bytes:
        check_abort(stage)
        if downloader is download:
            body = downloader(
                url, maximum,
                deadline_monotonic=absolute_deadline,
                abort=lambda: check_abort(stage),
            )
        else:
            body = downloader(url, maximum)
        check_abort(stage)
        return body

    package = lease.execution_package
    manifest_bytes = fetch("download_manifest", package.manifest.url, MAX_MANIFEST_BYTES)
    execution_manifest = _verify_execution_manifest(lease, manifest_bytes)
    xosc = fetch("download_xosc", package.xosc.url, MAX_XOSC_BYTES)
    xodr = fetch("download_xodr", package.xodr.url, MAX_XODR_BYTES)
    catalog_bytes = fetch("download_asset_catalog", package.asset_catalog.url, MAX_CATALOG_BYTES)
    materialized_traffic = package.ambient.get("materializedTraffic")
    traffic_bytes: bytes | None = None
    if materialized_traffic:
        traffic_bytes = fetch("download_materialized_traffic", materialized_traffic.url, MAX_TRAFFIC_BYTES)
        materialized_traffic.verify(traffic_bytes, "materializedTraffic")
    elif package.ambient["ambientMode"] != "disabled":
        raise ContractError("non-disabled ambient traffic requires materializedTraffic")
    package.xosc.verify(xosc, "xosc")
    _verify_xosc_source_input_digest(lease, xosc)
    package.xodr.verify(xodr, "xodr")
    package.asset_catalog.verify(catalog_bytes, "assetCatalog")
    check_abort("validate_xosc")
    validation = validator(xosc)
    if validation.get("valid") is not True or validation.get("xmlSha256") != package.xosc.sha256 or validation.get("xsdSha256") != package.xosc.xsd_sha256:
        raise RuntimeError("worker XSD validation receipt is not hash-closed to the execution package")
    emit("assets_validated", {"xoscSha256": package.xosc.sha256, "xodrSha256": package.xodr.sha256})
    check_abort("compile_xosc")
    plan = compile_xosc14(xosc, abort=lambda: check_abort("compile_xosc"))
    if traffic_bytes is not None:
        mode = package.ambient["ambientMode"]
        provider_version = (
            "none" if mode == "disabled" else
            package.ambient["runtimeVersion"] if mode == "native" else
            package.ambient["sumoVersion"]
        )
        provider_seed = "" if mode == "disabled" else package.ambient["seed"]
        materialized = parse_materialized_traffic(
            traffic_bytes,
            expected_digest=package.ambient["resultSha256"],
            source_input_digest=package.source_input_digest,
            map_asset_id=package.map_asset_id,
            map_version_id=package.map_version_id,
            provider_id=mode,
            provider_version=provider_version,
            provider_seed=provider_seed,
            fixed_step_seconds=plan.fixed_timestep_s,
            duration_seconds=plan.frames[-1].t,
        )
        plan = merge_materialized_traffic(
            plan,
            materialized,
            frozenset(execution_manifest["materializedTraffic"]["overlapActorIds"]),
        )
    check_abort("compile_xosc")
    execution_drops = _preflight_execution_semantics(lease, plan)
    actor_ids = set(plan.actors)
    unknown_mounts = sorted({
        sensor.actor_id for sensor in lease.render_spec.sensors
        if sensor.actor_id and sensor.actor_id not in actor_ids
    })
    if unknown_mounts:
        raise RuntimeError(f"sensor mounts reference unknown actors: {', '.join(unknown_mounts)}")
    try:
        catalog_manifest = json.loads(catalog_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("asset catalog manifest must be valid UTF-8 JSON") from exc
    check_abort("index_asset_catalog")
    catalog = runtime_asset_bindings(
        catalog_manifest,
        expected_catalog_version_id=package.asset_catalog.catalog_version_id,
        abort=lambda: check_abort("index_asset_catalog"),
    )
    for catalog_id, binding in (runtime_asset_overrides or {}).items():
        existing = catalog.get(catalog_id)
        if existing is not None and existing != binding:
            raise ContractError(f"runtime asset override conflicts with catalog entry {catalog_id}")
        catalog[catalog_id] = dict(binding)
    check_abort("index_asset_catalog")
    plan, runtime_vehicle_fallbacks = _apply_actor_fallbacks(
        plan,
        catalog,
        lambda: check_abort("index_asset_catalog"),
    )
    compiled_vehicle_fallbacks = execution_manifest.get("carlaVehicleFallbacks", [])
    if not isinstance(compiled_vehicle_fallbacks, list) or any(
        not isinstance(item, Mapping) for item in compiled_vehicle_fallbacks
    ):
        raise ContractError("execution manifest carlaVehicleFallbacks must be an array of objects")
    carla_vehicle_fallbacks = (
        *(dict(item) for item in compiled_vehicle_fallbacks),
        *runtime_vehicle_fallbacks,
    )
    if runtime_vehicle_fallbacks:
        emit("actor_fallbacks_applied", {
            "carlaVehicleFallbacks": [dict(item) for item in runtime_vehicle_fallbacks],
        })
    _preflight_asset_semantics(plan, catalog)
    emit("plan_compiled", {
        "planSha256": plan.sha256,
        "frames": len(plan.frames),
        "fixedTimestepS": plan.fixed_timestep_s,
    })
    accumulator = ParityAccumulator(lease.parity_thresholds)
    readbacks: list[Mapping[str, Mapping[str, object]]] = []
    signal_readbacks: list[Mapping[str, str]] = []
    collision_readbacks: list[list[Mapping[str, object]]] = []
    capture_schedule = _capture_schedule(plan, lease.render_spec.fps, lambda: check_abort("schedule_capture")) if lease.job_mode == "full_render" else {}
    expected_capture_count = len(capture_schedule)
    _enforce_render_budgets(lease, plan, expected_capture_count)
    if lease.job_mode == "full_render":
        annotation_schedule = capture_schedule
    else:
        annotation_schedule = {}
        for frame in plan.frames:
            if frame.index % 50 == 0:
                check_abort("schedule_annotations", frame.index, len(plan.frames))
            annotation_schedule[frame.index] = (frame.index, frame.t)
    with tempfile.TemporaryDirectory(prefix="scenario-render-") as directory:
        output_dir = Path(directory) / "frames"
        runtime_evidence: Mapping[str, object] = {
            "schema": "simforge.carla-runtime-evidence/v1",
            "available": False,
            "executionMode": lease.render_spec.execution_mode,
            "physicsAuthority": lease.render_spec.execution_mode == "native-physics",
            "acceptanceEligible": lease.render_spec.execution_mode == "native-physics",
        }
        try:
            check_abort("configure_execution")
            backend.configure_execution(lease.render_spec.execution_mode)
            backend_fence("load_opendrive")
            backend.load_opendrive(package.xodr.map_name, xodr, plan.fixed_timestep_s)
            backend.video_fps = float(lease.render_spec.fps)
            check_abort("load_opendrive")
            signal_ids: set[str] = set()
            for frame in plan.frames:
                if frame.index % 50 == 0:
                    check_abort("collect_signals", frame.index, len(plan.frames))
                signal_ids.update(frame.signals)
            backend.bind_signals(tuple(sorted(signal_ids)), abort=lambda: backend_fence("bind_signals"))
            backend_fence("configure_environment")
            backend.configure_environment(lease.render_spec.environment)
            check_abort("configure_environment")
            if execution_drops:
                # Knockdown-posed actors are dropped from execution before any
                # CARLA body exists; spawn records them in the placement report
                # so the manifest carries an explicit per-actor diagnostic.
                backend.execution_drops = dict(execution_drops)  # type: ignore[attr-defined]
                emit("execution_actors_dropped", {"actorIds": sorted(execution_drops)})
            backend.spawn(plan.actors, plan.frames[0], catalog, abort=lambda: backend_fence("spawn_actors"))
            check_abort("spawn_actors")
            spawn_placement = _optional_backend_call(
                backend,
                "spawn_placement_report",
                abort=lambda: check_abort("spawn_actors"),
            )
            if isinstance(spawn_placement, Mapping):
                dropped_actor_ids = {
                    str(item) for item in spawn_placement.get("droppedActorIds", ())
                }
                dropped_mounts = sorted({
                    sensor.actor_id for sensor in lease.render_spec.sensors
                    if sensor.actor_id in dropped_actor_ids
                })
                if dropped_mounts:
                    raise ContractError(
                        "spawn placement dropped sensor host actors: "
                        + ", ".join(dropped_mounts)
                    )
                static_planar_offsets: dict[str, tuple[float, float]] = {}
                placement_actors = spawn_placement.get("actors")
                if isinstance(placement_actors, Mapping):
                    for actor_id, item in placement_actors.items():
                        binding = plan.actors.get(actor_id)
                        if (
                            binding is None
                            or not binding.static
                            or not isinstance(item, Mapping)
                            or item.get("outcome") != "nudged"
                        ):
                            continue
                        authored = item.get("authored")
                        placed = item.get("placed")
                        if isinstance(authored, Mapping) and isinstance(placed, Mapping):
                            static_planar_offsets[str(actor_id)] = (
                                float(placed["x"]) - float(authored["x"]),
                                float(placed["y"]) - float(authored["y"]),
                            )
                accumulator.configure_spawn_placement(dropped_actor_ids, static_planar_offsets)
            else:
                spawn_placement = None
            if lease.job_mode == "full_render":
                backend.configure_sensors(lease.render_spec, output_dir, MAX_OUTPUT_BYTES, abort=lambda: backend_fence("configure_sensors"))
                check_abort("configure_sensors")
            stability = backend.prepare_scenario(plan.frames[0], abort=lambda: backend_fence("prepare_scenario"))
            check_abort("prepare_scenario")
            emit("interaction_started" if lease.job_mode == "interaction_2d" else "render_started", {"frames": len(plan.frames), "executionMode": lease.render_spec.execution_mode})
            for frame in plan.frames:
                check_abort("execute", frame.index, len(plan.frames))
                backend_fence("execute", frame.index, len(plan.frames))
                backend.apply(frame, abort=lambda: backend_fence("execute", frame.index, len(plan.frames)))
                capture = capture_schedule.get(frame.index)
                actual = backend.tick(None if capture is None else {
                    "outputFrameIndex": capture[0], "scheduledTimeS": capture[1],
                }, abort=lambda: backend_fence("execute", frame.index, len(plan.frames)))
                signals = backend.signal_readback(abort=lambda: backend_fence("execute", frame.index, len(plan.frames)))
                collisions = _optional_backend_call(
                    backend,
                    "collision_readback",
                    frame.index,
                    frame.t,
                    abort=lambda: backend_fence("execute", frame.index, len(plan.frames)),
                ) or []
                accumulator.observe(frame, actual, actual_signals=signals, collision_events=collisions)
                readbacks.append(actual)
                signal_readbacks.append(signals)
                collision_readbacks.append(collisions)
                if frame.index and frame.index % 250 == 0:
                    emit("progress", {"completedFrames": frame.index + 1, "totalFrames": len(plan.frames)})
            if lease.job_mode == "full_render":
                backend.finalize_capture(expected_capture_count, abort=lambda: backend_fence("finalize_capture", expected_capture_count, expected_capture_count))
            evidence = _optional_backend_call(
                backend,
                "runtime_evidence",
                abort=lambda: backend_fence("collect_runtime_evidence", len(plan.frames), len(plan.frames)),
            )
            if evidence is not None:
                runtime_evidence = evidence
        except BaseException as original_error:
            try:
                backend.cleanup()
            except BaseException as cleanup_error:
                raise original_error.with_traceback(original_error.__traceback__) from cleanup_error
            raise
        else:
            backend.cleanup()
        check_abort("collect_sensor_manifest")
        sensor_records = backend.sensor_manifest(abort=lambda: check_abort("collect_sensor_manifest"))
        check_abort("collect_sensor_manifest")
        capture_temp_bytes = _capture_temp_bytes(output_dir, lambda: check_abort("measure_capture_storage"))
        artifact_temp_limit = MAX_OUTPUT_BYTES - capture_temp_bytes
        if artifact_temp_limit <= 0:
            raise ContractError("captured frames leave no shared temporary-disk budget for artifacts")
        artifacts: list[dict[str, object]] = []
        output_bytes = 0
        def add_artifact(item: dict[str, object]) -> None:
            nonlocal output_bytes
            output_bytes += int(item["sizeBytes"])
            artifacts.append(item)
            emit("artifact_uploaded", {"kind": item["kind"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
        def make_artifact(
            kind: str,
            body: ArtifactBody,
            media_type: str,
            reservation: Mapping[str, Any] | None,
            metadata: Mapping[str, object] | None = None,
            precomputed_digest: str | None = None,
        ) -> dict[str, object]:
            try:
                if _body_size(body) > artifact_temp_limit:
                    raise ContractError(f"artifact {kind} exceeds the shared temporary-disk budget")
                _enforce_output_budget(output_bytes, body, kind)
                check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames))
                return _artifact(
                    kind, body, media_type, reservation, uploader, metadata, authorize_upload,
                    deadline_monotonic=absolute_deadline,
                    abort=lambda: check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames)),
                    precomputed_digest=precomputed_digest,
                )
            finally:
                if isinstance(body, Path):
                    body.unlink(missing_ok=True)
        if "trace" in lease.render_spec.outputs or "trace" in lease.artifact_uploads:
            trace_body = _trace_to_path(plan, readbacks, signal_readbacks, collision_readbacks, package.control_sha256, package.source_input_digest, package.materialized_traffic_digest, Path(directory) / "trace.json.gz", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes), lambda: check_abort("serialize_trace"))
            add_artifact(make_artifact("trace", trace_body, "application/gzip", lease.artifact_uploads.get("trace"), {"format": "json", "contentEncoding": "gzip"}))
        if "video" in lease.render_spec.outputs:
            check_abort("collect_camera_videos", len(plan.frames), len(plan.frames))
            video_encoder = simforge_env("PRESENTATION_VIDEO_ENCODER", "software")
            camera_sensors = [
                sensor for sensor in lease.render_spec.sensors
                if sensor.modality in CAMERA_MODALITIES
            ]
            primary_rgb_sensor = next(
                sensor for sensor in camera_sensors if sensor.modality == "rgb"
            )
            for index, sensor in enumerate(camera_sensors):
                remaining_bytes = min(MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes, artifact_temp_limit)
                body = _collect_camera_video(
                    output_dir,
                    sensor.artifact_name,
                    lease.render_spec.fps,
                    Path(directory) / f"camera-video-{index:02d}.mp4",
                    expected_capture_count,
                    remaining_bytes,
                    check_abort,
                    absolute_deadline,
                )
                check_abort("collect_camera_videos", len(plan.frames), len(plan.frames))
                # The primary RGB camera's stream doubles as the review MP4
                # ("video"); every other camera uploads its own stream.
                upload_kind = (
                    "video" if sensor is primary_rgb_sensor
                    else f"sensorVideo:{sensor.artifact_name}"
                )
                add_artifact(make_artifact(
                    upload_kind,
                    body,
                    "video/mp4",
                    lease.artifact_uploads.get(upload_kind),
                    {
                        "actorId": sensor.actor_id,
                        "sensorId": sensor.sensor_id,
                        "modality": sensor.modality,
                        "outputName": sensor.role,
                        "codec": "h264",
                        "container": "mp4",
                        "format": "mp4-h264",
                        "encoder": video_encoder,
                        "width": int(sensor.config["width"]),
                        "height": int(sensor.config["height"]),
                        "frameCount": expected_capture_count,
                        "fps": lease.render_spec.fps,
                        "durationS": plan.frames[-1].t,
                    },
                ))
            visualization_sensors = [
                sensor for sensor in lease.render_spec.sensors
                if sensor.modality in {"lidar", "semantic-lidar", "radar"}
            ]
            for index, sensor in enumerate(visualization_sensors):
                check_abort("encode_sensor_visualization", index, len(visualization_sensors))
                remaining_bytes = min(MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes, artifact_temp_limit)
                viz_body = encode_sensor_video(
                    sensor,
                    output_dir,
                    Path(directory) / f"sensor-viz-{index:02d}.mp4",
                    lease.render_spec.fps,
                    expected_capture_count,
                    remaining_bytes,
                    lambda: check_abort("encode_sensor_visualization", index, len(visualization_sensors)),
                )
                upload_kind = f"sensorVideo:{sensor.artifact_name}"
                add_artifact(make_artifact(
                    upload_kind,
                    viz_body,
                    "video/mp4",
                    lease.artifact_uploads.get(upload_kind),
                    {
                        "actorId": sensor.actor_id,
                        "sensorId": sensor.sensor_id,
                        "modality": sensor.modality,
                        "outputName": sensor.role,
                        "codec": "h264",
                        "container": "mp4",
                        "format": "mp4-h264",
                        "representation": "visualization",
                        "frameCount": expected_capture_count,
                        "fps": lease.render_spec.fps,
                        "durationS": plan.frames[-1].t,
                    },
                ))
        data_sensors = [
            sensor for sensor in lease.render_spec.sensors
            if sensor.modality in {"lidar", "semantic-lidar", "radar"}
        ]
        for sensor in data_sensors:
            check_abort("package_sensor_data", 0, len(data_sensors))
            sensor_dir = output_dir / sensor.artifact_name
            if not sensor_dir.is_dir():
                continue
            data_body = _archive_sensor_data(
                sensor_dir,
                Path(directory) / f"sensor-data-{sensor.artifact_name}.zip",
                MAX_ARTIFACT_BYTES,
                lambda: check_abort("package_sensor_data", 0, len(data_sensors)),
            )
            upload_kind = f"sensorData:{sensor.artifact_name}"
            add_artifact(make_artifact(
                upload_kind,
                data_body,
                "application/zip",
                lease.artifact_uploads.get(upload_kind),
                {
                    "actorId": sensor.actor_id,
                    "sensorId": sensor.sensor_id,
                    "modality": sensor.modality,
                    "outputName": sensor.role,
                    "fps": lease.render_spec.fps,
                },
            ))
        if "annotations" in lease.render_spec.outputs:
            annotations_body = _annotations_to_path(plan, readbacks, annotation_schedule, Path(directory) / "annotations.ndjson", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes), lambda: check_abort("serialize_annotations"))
            add_artifact(make_artifact("annotations", annotations_body, "application/x-ndjson", lease.artifact_uploads.get("annotations"), {"frameCount": len(annotation_schedule), "fps": lease.render_spec.fps, "durationS": plan.frames[-1].t}))
        parity = accumulator.report()
        acceptance_eligible = lease.render_spec.execution_mode == "native-physics"
        attestation = _attestation(validation, lease.render_spec.execution_mode, runtime_evidence)
        if stability:
            attestation["nativeStability"] = stability
        if spawn_placement:
            attestation["spawnPlacement"] = dict(spawn_placement)
        parity_evidence = _parity_evidence(
            lease,
            plan,
            parity,
            runtime_evidence,
            artifacts,
            expected_capture_count,
            spawn_placement,
        )
        accepted = acceptance_eligible and parity_evidence["verdict"] == "pass"
        parity_value = {
            **asdict(parity),
            "rawStrictAccepted": parity.reference_accepted,
            "accepted": accepted,
            "acceptanceEligible": acceptance_eligible,
            "verdict": (
                "accepted-native-physics" if accepted else
                "failed-native-physics" if acceptance_eligible else
                "diagnostic-only"
            ),
        }
        if "parity-report" in lease.artifact_uploads:
            parity_body = json.dumps(
                parity_evidence,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            add_artifact(make_artifact(
                "parity-report",
                parity_body,
                "application/json",
                lease.artifact_uploads.get("parity-report"),
                {"schema": "simforge.parity-evidence/v1"},
            ))
        if "manifest" in lease.render_spec.outputs:
            manifest_body = _manifest_to_path(
                lease,
                plan,
                sensor_records,
                validation,
                parity_value,
                parity_evidence,
                attestation,
                artifacts,
                Path(directory) / "manifest.json",
                min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes),
                lambda: check_abort("serialize_manifest"),
                carla_vehicle_fallbacks,
            )
            add_artifact(make_artifact("manifest", manifest_body, "application/json", lease.artifact_uploads.get("manifest")))
    return {
        "status": "succeeded" if parity.accepted else "failed-parity",
        "planSha256": plan.sha256,
        "sourceInputDigest": package.source_input_digest,
        "materializedTrafficDigest": package.materialized_traffic_digest,
        "attestation": attestation,
        "parity": parity_value,
        "parityEvidence": parity_evidence,
        "carlaVehicleFallbacks": [dict(item) for item in carla_vehicle_fallbacks],
        "artifacts": artifacts,
    }


def filesystem_validator(xsd_path: Path) -> Validate:
    return lambda xml: validate_xosc14(xml, xsd_path)
