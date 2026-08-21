from __future__ import annotations

import hashlib
import gzip
import json
import math
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
from .compiler import LIFECYCLE_ABSENT, ExecutionPlan, compile_xosc14
from .contract import (
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
from .materialized_traffic import merge_materialized_traffic, parse_materialized_traffic
from .validation import validate_sensor_evidence, validate_xosc14

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


def _attestation(validation: Mapping[str, object]) -> dict[str, object]:
    return {
        "schema": "uniscenario.worker-attestation/v1",
        "workerImageDigest": os.environ.get("SIMFORGE_WORKER_IMAGE_DIGEST", "unavailable"),
        "workerRevision": os.environ.get("SIMFORGE_WORKER_REVISION", "unavailable"),
        "carlaVersion": os.environ.get("SIMFORGE_CARLA_VERSION", "0.10.0"),
        "engineVersion": os.environ.get("SIMFORGE_ENGINE_VERSION", "UE5.5"),
        "pythonVersion": platform.python_version(),
        "xoscValidation": dict(validation),
    }


def _trace_to_path(plan: ExecutionPlan, readbacks: list[Mapping[str, Mapping[str, float]]], signal_readbacks: list[Mapping[str, str]], control_sha256: str, source_input_digest: str, materialized_traffic_digest: str, destination: Path, max_bytes: int, abort: Callable[[], None]) -> Path:
    if len(readbacks) != len(plan.frames) or len(signal_readbacks) != len(plan.frames):
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
            for index, (frame, readback, signals) in enumerate(zip(plan.frames, readbacks, signal_readbacks)):
                abort()
                if index:
                    encoded.write(b",")
                encoded.write(json.dumps({"index": frame.index, "t": frame.t, "actors": readback, "signals": signals}, sort_keys=True, separators=(",", ":")).encode())
            encoded.write(b'],"planSha256":')
            encoded.write(json.dumps(plan.sha256).encode())
            encoded.write(b',"schema":"uniscenario.render-trace/v1","signalStateSource":"backend-verified"}')
            abort()
    return destination


def _expected_sensor_paths(
    sensor_dir: Path,
    extension: str,
    expected_frame_count: int,
    abort: Callable[[], None] | None = None,
) -> list[Path]:
    if abort:
        abort()
    frames = sorted(sensor_dir.iterdir()) if sensor_dir.is_dir() else []
    expected = [
        sensor_dir / f"{index:08d}.{extension}"
        for index in range(expected_frame_count)
    ]
    if abort:
        abort()
    if frames != expected or any(not frame.is_file() or frame.stat().st_size <= 0 for frame in frames):
        raise RuntimeError(
            f"sensor {sensor_dir.name} produced {len(frames)} of {expected_frame_count} exact {extension} frames"
        )
    return frames


def _archive_sensor_frames(
    sensor_dir: Path,
    extension: str,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[str, int, int], None],
) -> Path:
    frames = _expected_sensor_paths(
        sensor_dir,
        extension,
        expected_frame_count,
        lambda: check_abort("archive_frames", 0, expected_frame_count),
    )
    source_bytes = 0
    for index, frame in enumerate(frames):
        check_abort("archive_frames", index, expected_frame_count)
        source_bytes += frame.stat().st_size
    # A ZIP can be slightly larger than incompressible inputs because of local
    # and central-directory records. Reject before creating it unless that
    # conservative upper bound fits the remaining artifact/output budget.
    if source_bytes + len(frames) * 512 + 1024 > max_bytes:
        raise ContractError(f"sensor archive {sensor_dir.name} exceeds its pre-allocation budget")
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for index, frame in enumerate(frames):
            check_abort("archive_frames", index, expected_frame_count)
            with frame.open("rb") as source, archive.open(f"{sensor_dir.name}/{frame.name}", "w") as target:
                while chunk := source.read(1024 * 1024):
                    check_abort("archive_frames", index, expected_frame_count)
                    target.write(chunk)
    if destination.stat().st_size > max_bytes:
        raise ContractError(f"sensor archive {sensor_dir.name} exceeds its output budget")
    check_abort("archive_frames", expected_frame_count, expected_frame_count)
    return destination


def _encode_video(
    frame_dir: Path,
    sensor_id: str,
    fps: float,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> Path:
    sensor_dir = frame_dir / sensor_id
    if not sensor_dir.is_dir():
        raise RuntimeError("video output requested but the backend produced no RGB sensor frames")
    frames = _expected_sensor_paths(sensor_dir, "png", expected_frame_count, lambda: check_abort("encode_video", 0, expected_frame_count))
    source_bytes = 0
    for index, frame in enumerate(frames):
        check_abort("encode_video", index, expected_frame_count)
        source_bytes += frame.stat().st_size
    if source_bytes > max_bytes:
        raise ContractError("video source frames exceed the pre-allocation output budget")
    result = _run_process([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
        "-start_number", "0", "-i", str(sensor_dir / "%08d.png"),
        "-frames:v", str(expected_frame_count),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-fs", str(max_bytes), str(destination),
    ], "encode_video", check_abort, deadline_monotonic)
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')}")
    probe = _run_process([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames,duration", "-of", "json", str(destination),
    ], "probe_video", check_abort, deadline_monotonic)
    if probe.returncode:
        raise RuntimeError(f"ffprobe failed: {probe.stderr.decode(errors='replace')}")
    try:
        stream = json.loads(probe.stdout)["streams"][0]
        frame_count = int(stream["nb_read_frames"])
        duration = float(stream["duration"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("ffprobe did not return frame-closed video metadata") from exc
    expected_duration = expected_frame_count / fps
    if frame_count != expected_frame_count or abs(duration - expected_duration) > (1 / fps):
        raise RuntimeError(
            f"encoded video is not frame-closed: {frame_count} frames/{duration}s, expected {expected_frame_count}/{expected_duration}s"
        )
    if destination.stat().st_size > max_bytes:
        raise ContractError("video exceeds its output budget")
    return destination


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
            "schema": "uniscenario.annotation-frame/v1",
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


def _manifest_to_path(
    lease: Lease,
    plan: ExecutionPlan,
    sensor_records: list[Mapping[str, Any]],
    validation: Mapping[str, object],
    parity: Mapping[str, object],
    attestation: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    destination: Path,
    max_bytes: int,
    abort: Callable[[], None],
) -> Path:
    value = {
        "schema": "uniscenario.render-manifest/v1",
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
        "artifacts": [dict(item) for item in artifacts],
        "sensorFrames": sensor_records,
        "capture": {
            "frameCount": len(sensor_records) // max(1, len(lease.render_spec.sensors)),
            "fps": lease.render_spec.fps,
            "durationS": plan.frames[-1].t,
        },
        "capabilities": {
            "execution": lease.render_spec.execution_mode,
            "sensors": sorted({sensor.kind for sensor in lease.render_spec.sensors}),
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
        if item.get("name") == "uniscenarios.provenance.inputHash"
    ]
    if values != [lease.execution_package.source_input_digest]:
        raise ContractError("OpenSCENARIO source input digest does not match the control package")


def _enforce_render_budgets(lease: Lease, plan: ExecutionPlan, capture_count: int) -> None:
    duration = plan.frames[-1].t
    if duration < 0 or duration > MAX_DURATION_SECONDS:
        raise ContractError(f"scenario duration must be between 0 and {MAX_DURATION_SECONDS:g} seconds")
    if capture_count > MAX_CAPTURE_FRAMES:
        raise ContractError(f"render capture exceeds {MAX_CAPTURE_FRAMES} frames")
    resources = lease.execution_package.runtime_requirements.resources
    sensors = lease.render_spec.sensors
    image_sensors = [
        sensor
        for sensor in sensors
        if sensor.kind in {"rgb", "depth", "semantic", "instance", "normals"}
    ]
    pixels_per_frame = sum(
        int(sensor.attributes["width"]) * int(sensor.attributes["height"])
        for sensor in image_sensors
    )
    sensor_pixels = pixels_per_frame * capture_count
    capture_frames = len(sensors) * capture_count
    actor_frame_states = len(plan.actors) * len(plan.frames)
    if sensor_pixels > MAX_SENSOR_PIXELS:
        raise ContractError(f"render capture exceeds {MAX_SENSOR_PIXELS} sensor pixels")
    if (
        abs(resources.duration_s - duration) > 1e-6
        or resources.capture_frames != capture_frames
        or resources.sensor_pixels != sensor_pixels
        or resources.actors < len(plan.actors)
        or resources.actor_frame_states < actor_frame_states
    ):
        raise ContractError("runtimeRequirements.resources do not cover the compiled execution plan")
    point_record_bytes = 0
    for sensor in sensors:
        if sensor.kind in {"lidar", "semantic_lidar", "radar"}:
            point_record_bytes += int(math.ceil(
                int(sensor.attributes["pointsPerSecond"])
                * capture_count
                / lease.render_spec.fps
            )) * 96
    frame_file_count = len(sensors) * capture_count
    projected_bytes = sensor_pixels * 4 + point_record_bytes + frame_file_count * 4096
    if projected_bytes > min(MAX_OUTPUT_BYTES, resources.output_bytes):
        raise ContractError("projected raw capture exceeds the temporary-disk budget")


def _body_size(body: ArtifactBody) -> int:
    return body.stat().st_size if isinstance(body, Path) else len(body)


def _capture_temp_bytes(output_dir: Path, abort: Callable[[], None]) -> int:
    total = 0
    if not output_dir.exists():
        return 0
    for path in output_dir.rglob("*"):
        abort()
        if not path.is_file():
            continue
        total += path.stat().st_size + 4096
        if total > MAX_OUTPUT_BYTES:
            raise ContractError("captured sensor data exceed the shared temporary-disk budget")
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


def _enforce_output_budget(
    current_bytes: int,
    body: ArtifactBody,
    kind: str,
    max_output_bytes: int | None = None,
) -> None:
    size = _body_size(body)
    if size > MAX_ARTIFACT_BYTES:
        raise ContractError(f"artifact {kind} exceeds {MAX_ARTIFACT_BYTES} bytes")
    output_limit = MAX_OUTPUT_BYTES if max_output_bytes is None else min(MAX_OUTPUT_BYTES, max_output_bytes)
    if current_bytes + size > output_limit:
        raise ContractError(f"render outputs exceed {output_limit} bytes")


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
) -> dict[str, object]:
    size = _body_size(body)
    digest = _body_digest(body, deadline_monotonic, abort)
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
    actor_ids = set(plan.actors)
    unknown_attachments = sorted({
        sensor.attach_to
        for sensor in lease.render_spec.sensors
        if sensor.attach_to not in actor_ids
    })
    if unknown_attachments:
        raise RuntimeError(f"sensor attachments reference unknown actors: {', '.join(unknown_attachments)}")
    emit("plan_compiled", {"planSha256": plan.sha256, "frames": len(plan.frames), "fixedTimestepS": plan.fixed_timestep_s})
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
    check_abort("index_asset_catalog")
    accumulator = ParityAccumulator(lease.parity_thresholds)
    readbacks: list[Mapping[str, Mapping[str, float]]] = []
    signal_readbacks: list[Mapping[str, str]] = []
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
    with tempfile.TemporaryDirectory(prefix="uniscenario-render-") as directory:
        output_dir = Path(directory) / "frames"
        try:
            check_abort("configure_execution")
            backend.configure_execution(lease.render_spec.execution_mode)
            backend_fence("load_opendrive")
            backend.load_opendrive(package.xodr.map_name, xodr, plan.fixed_timestep_s)
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
            backend.spawn(plan.actors, plan.frames[0], catalog, abort=lambda: backend_fence("spawn_actors"))
            check_abort("spawn_actors")
            stability = backend.prepare_scenario(plan.frames[0], abort=lambda: backend_fence("prepare_scenario"))
            check_abort("prepare_scenario")
            if lease.job_mode == "full_render":
                backend.configure_sensors(
                    lease.render_spec,
                    output_dir,
                    min(MAX_OUTPUT_BYTES, package.runtime_requirements.resources.output_bytes),
                    abort=lambda: backend_fence("configure_sensors"),
                )
                check_abort("configure_sensors")
            emit("interaction_started" if lease.job_mode == "interaction_2d" else "render_started", {"frames": len(plan.frames), "executionMode": lease.render_spec.execution_mode})
            for frame in plan.frames:
                check_abort("execute", frame.index, len(plan.frames))
                backend_fence("execute", frame.index, len(plan.frames))
                backend.apply(frame, abort=lambda: backend_fence("execute", frame.index, len(plan.frames)))
                capture = capture_schedule.get(frame.index)
                actual = backend.tick(None if capture is None else {
                    "outputFrameIndex": capture[0], "scheduledTimeS": capture[1],
                }, abort=lambda: backend_fence("execute", frame.index, len(plan.frames)))
                accumulator.observe(frame, actual)
                readbacks.append(actual)
                signal_readbacks.append(backend.signal_readback(abort=lambda: backend_fence("execute", frame.index, len(plan.frames))))
                if frame.index and frame.index % 250 == 0:
                    emit("progress", {"completedFrames": frame.index + 1, "totalFrames": len(plan.frames)})
            if lease.job_mode == "full_render":
                backend.finalize_capture(expected_capture_count, abort=lambda: backend_fence("finalize_capture", expected_capture_count, expected_capture_count))
        except BaseException as original_error:
            try:
                backend.cleanup()
            except BaseException as cleanup_error:
                raise original_error.with_traceback(original_error.__traceback__) from cleanup_error
            raise
        else:
            backend.cleanup()
        check_abort("collect_sensor_manifest")
        sensor_records = validate_sensor_evidence(
            lease.render_spec,
            backend.sensor_manifest(abort=lambda: check_abort("collect_sensor_manifest")),
            expected_capture_count,
        )
        check_abort("collect_sensor_manifest")
        capture_temp_bytes = _capture_temp_bytes(output_dir, lambda: check_abort("measure_capture_storage"))
        output_limit = min(MAX_OUTPUT_BYTES, package.runtime_requirements.resources.output_bytes)
        artifact_temp_limit = output_limit - capture_temp_bytes
        if artifact_temp_limit <= 0:
            raise ContractError("captured sensor data leave no shared temporary-disk budget for artifacts")
        artifacts: list[dict[str, object]] = []
        output_bytes = 0
        def add_artifact(item: dict[str, object]) -> None:
            nonlocal output_bytes
            output_bytes += int(item["sizeBytes"])
            artifacts.append(item)
            emit("artifact_uploaded", {"kind": item["kind"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
        def make_artifact(kind: str, body: ArtifactBody, media_type: str, reservation: Mapping[str, Any] | None, metadata: Mapping[str, object] | None = None) -> dict[str, object]:
            try:
                if _body_size(body) > artifact_temp_limit:
                    raise ContractError(f"artifact {kind} exceeds the shared temporary-disk budget")
                _enforce_output_budget(
                    output_bytes,
                    body,
                    kind,
                    package.runtime_requirements.resources.output_bytes,
                )
                check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames))
                return _artifact(
                    kind, body, media_type, reservation, uploader, metadata, authorize_upload,
                    deadline_monotonic=absolute_deadline,
                    abort=lambda: check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames)),
                )
            finally:
                if isinstance(body, Path):
                    body.unlink(missing_ok=True)
        if "trace" in lease.render_spec.outputs or "trace" in lease.artifact_uploads:
            trace_body = _trace_to_path(plan, readbacks, signal_readbacks, package.control_sha256, package.source_input_digest, package.materialized_traffic_digest, Path(directory) / "trace.json.gz", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, output_limit - output_bytes), lambda: check_abort("serialize_trace"))
            add_artifact(make_artifact("trace", trace_body, "application/gzip", lease.artifact_uploads.get("trace"), {"format": "json", "contentEncoding": "gzip"}))
        if "frames" in lease.render_spec.outputs:
            for sensor in lease.render_spec.sensors:
                upload_kind = f"sensorArchive-{sensor.id}"
                remaining_bytes = min(
                    MAX_ARTIFACT_BYTES,
                    output_limit - output_bytes,
                    artifact_temp_limit,
                )
                body = _archive_sensor_frames(
                    output_dir / sensor.id,
                    sensor.format,
                    Path(directory) / f"{sensor.id}.zip",
                    expected_capture_count,
                    remaining_bytes,
                    check_abort,
                )
                add_artifact(make_artifact(
                    upload_kind,
                    body,
                    "application/zip",
                    lease.artifact_uploads.get(upload_kind),
                    {
                        "sensorId": sensor.id,
                        "sensorKind": sensor.kind,
                        "format": sensor.format,
                        "frameCount": expected_capture_count,
                        "fps": lease.render_spec.fps,
                        "durationS": plan.frames[-1].t,
                    },
                ))
        if "video" in lease.render_spec.outputs:
            check_abort("encode_video", len(plan.frames), len(plan.frames))
            primary_rgb = next(sensor.id for sensor in lease.render_spec.sensors if sensor.kind == "rgb")
            remaining_bytes = min(MAX_ARTIFACT_BYTES, output_limit - output_bytes, artifact_temp_limit)
            body = _encode_video(
                output_dir,
                primary_rgb,
                lease.render_spec.fps,
                Path(directory) / "render.mp4",
                expected_capture_count,
                remaining_bytes,
                check_abort,
                absolute_deadline,
            )
            check_abort("encode_video", len(plan.frames), len(plan.frames))
            add_artifact(make_artifact("video", body, "video/mp4", lease.artifact_uploads.get("video"), {"frameCount": expected_capture_count, "fps": lease.render_spec.fps, "durationS": plan.frames[-1].t}))
        if "annotations" in lease.render_spec.outputs:
            annotations_body = _annotations_to_path(plan, readbacks, annotation_schedule, Path(directory) / "annotations.ndjson", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, output_limit - output_bytes), lambda: check_abort("serialize_annotations"))
            add_artifact(make_artifact("annotations", annotations_body, "application/x-ndjson", lease.artifact_uploads.get("annotations"), {"frameCount": len(annotation_schedule), "fps": lease.render_spec.fps, "durationS": plan.frames[-1].t}))
        parity = accumulator.report()
        attestation = _attestation(validation)
        if stability:
            attestation["nativeStability"] = stability
        if "manifest" in lease.render_spec.outputs:
            manifest_body = _manifest_to_path(lease, plan, sensor_records, validation, asdict(parity), attestation, artifacts, Path(directory) / "manifest.json", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, output_limit - output_bytes), lambda: check_abort("serialize_manifest"))
            add_artifact(make_artifact("manifest", manifest_body, "application/json", lease.artifact_uploads.get("manifest")))
    return {
        "status": "succeeded" if parity.accepted else "failed-parity",
        "planSha256": plan.sha256,
        "sourceInputDigest": package.source_input_digest,
        "materializedTrafficDigest": package.materialized_traffic_digest,
        "attestation": attestation,
        "parity": asdict(parity),
        "artifacts": artifacts,
    }


def filesystem_validator(xsd_path: Path) -> Validate:
    return lambda xml: validate_xosc14(xml, xsd_path)

