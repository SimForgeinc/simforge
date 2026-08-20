from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Mapping

SCHEMA = "uniscenario.execution-package/v1"
OFFICIAL_XSD_SHA256 = "949fe2bcebd1f3fdb941a2cc56641482737ab48e3c5b0eed0ee5294b2355c0e9"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_XOSC_BYTES = 16 * 1024 * 1024
MAX_XODR_BYTES = 128 * 1024 * 1024
MAX_CATALOG_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_TRAFFIC_BYTES = 64 * 1024 * 1024
MAX_SENSOR_COUNT = 16
MAX_ACTOR_COUNT = 256
MAX_DURATION_SECONDS = 300.0
MAX_CAPTURE_FRAMES = 18_000
MAX_SENSOR_PIXELS = 2_000_000_000
MAX_ACTOR_FRAME_STATES = 2_000_000
MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024
ASSET_CATALOG_SCHEMA = "uniscenario.asset-catalog/v1"
RUNTIME_REQUIREMENTS_SCHEMA = "uniscenario.runtime-requirements/v1"
RENDER_RESOURCE_REQUEST_SCHEMA = "uniscenario.render-resource-request/v1"
CAPABILITY_PROFILE = "xml-1.4-trajectory-replay"
EMPTY_AMBIENT_CONFIG_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
EMPTY_AMBIENT_RESULT_SHA256 = "1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840"


class ContractError(ValueError):
    """An immutable execution package or lease violated its contract."""


def reject_unsafe_xml_envelope(xml_bytes: bytes) -> None:
    """Require UTF-8 XML and reject DTD/entity declarations before any parser starts."""
    try:
        decoded = xml_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ContractError("OpenSCENARIO XML must be UTF-8") from exc
    if "\x00" in decoded:
        raise ContractError("OpenSCENARIO XML must be UTF-8")
    lowered = decoded.casefold()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise ContractError("DTD and entity declarations are forbidden")


def _required_string(value: Mapping[str, Any], field: str) -> str:
    result = value.get(field)
    if not isinstance(result, str) or not result:
        raise ContractError(f"{field} must be a non-empty string")
    return result


def _sha(value: Mapping[str, Any], field: str) -> str:
    result = _required_string(value, field)
    if not SHA256.fullmatch(result):
        raise ContractError(f"{field} must be a lowercase SHA-256")
    return result


def _utf16_sort_key(value: str) -> bytes:
    # ECMAScript property ordering for the control-plane canonicalizer is by
    # UTF-16 code unit.  Python's default Unicode code-point ordering differs
    # for supplementary-plane characters.
    return value.encode("utf-16-be", errors="surrogatepass")


def _ecmascript_number(value: int | float) -> str:
    if isinstance(value, int):
        if abs(value) <= 9_007_199_254_740_991:
            return str(value)
        value = float(value)
        if not math.isfinite(value):
            raise ContractError("canonical JSON number exceeds the ECMAScript finite range")
    if not math.isfinite(value):
        raise ContractError("canonical JSON numbers must be finite")
    if value == 0:
        return "0"
    if not value.is_integer() and abs(value) < 1e15:
        rounded = Decimal.from_float(value).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        value = float(rounded)
        if value == 0:
            return "0"
    absolute = abs(value)
    shortest = repr(value).lower()
    if 1e-6 <= absolute < 1e21:
        fixed = format(Decimal(shortest), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    if "e" not in shortest:
        shortest = format(value, ".15e")
    mantissa, exponent = shortest.split("e", 1)
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent_value = int(exponent)
    return f"{mantissa}e{'+' if exponent_value >= 0 else ''}{exponent_value}"


def canonical_json(value: Any) -> str:
    """Serialize the supported JSON domain exactly like JS JSON.stringify(canonicalize())."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _ecmascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ContractError("canonical JSON object keys must be strings")
        return "{" + ",".join(
            f"{canonical_json(key)}:{canonical_json(value[key])}"
            for key in sorted(value, key=_utf16_sort_key)
        ) + "}"
    raise ContractError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _control_value(value: Any) -> Any:
    """Remove only transport URLs and the digest itself from package control data."""
    if isinstance(value, Mapping):
        return {
            key: _control_value(item)
            for key, item in value.items()
            if key not in {"url", "controlSha256"}
        }
    if isinstance(value, list):
        return [_control_value(item) for item in value]
    return value


@dataclass(frozen=True)
class Asset:
    url: str
    sha256: str
    size_bytes: int

    @classmethod
    def parse(cls, value: Any, label: str, limit: int) -> "Asset":
        if not isinstance(value, Mapping):
            raise ContractError(f"{label} must be an object")
        size = value.get("sizeBytes")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > limit:
            raise ContractError(f"{label}.sizeBytes must be between 0 and {limit}")
        return cls(_required_string(value, "url"), _sha(value, "sha256"), size)

    def verify(self, body: bytes, label: str) -> None:
        if len(body) != self.size_bytes:
            raise ContractError(f"{label} size mismatch: expected {self.size_bytes}, got {len(body)}")
        actual = hashlib.sha256(body).hexdigest()
        if actual != self.sha256:
            raise ContractError(f"{label} digest mismatch: expected {self.sha256}, got {actual}")


@dataclass(frozen=True)
class XoscAsset(Asset):
    xsd_sha256: str

    @classmethod
    def parse(cls, value: Any) -> "XoscAsset":
        base = Asset.parse(value, "xosc", MAX_XOSC_BYTES)
        assert isinstance(value, Mapping)
        xsd = _sha(value, "xsdSha256")
        if xsd != OFFICIAL_XSD_SHA256:
            raise ContractError("xosc.xsdSha256 must identify the pinned official OpenSCENARIO 1.4.0 XSD")
        return cls(base.url, base.sha256, base.size_bytes, xsd)


@dataclass(frozen=True)
class XodrAsset(Asset):
    map_name: str

    @classmethod
    def parse(cls, value: Any) -> "XodrAsset":
        base = Asset.parse(value, "xodr", MAX_XODR_BYTES)
        assert isinstance(value, Mapping)
        return cls(base.url, base.sha256, base.size_bytes, _required_string(value, "mapName"))


@dataclass(frozen=True)
class AssetCatalogAsset(Asset):
    contract_version: str
    catalog_version_id: str

    @classmethod
    def parse(cls, value: Any) -> "AssetCatalogAsset":
        base = Asset.parse(value, "assetCatalog", MAX_CATALOG_BYTES)
        assert isinstance(value, Mapping)
        if value.get("contractVersion") != ASSET_CATALOG_SCHEMA:
            raise ContractError(f"assetCatalog.contractVersion must equal {ASSET_CATALOG_SCHEMA}")
        return cls(
            base.url,
            base.sha256,
            base.size_bytes,
            ASSET_CATALOG_SCHEMA,
            _required_string(value, "catalogVersionId"),
        )


@dataclass(frozen=True)
class RenderResourceRequest:
    schema: str
    duration_s: float
    sensors: int
    capture_frames: int
    actors: int
    actor_frame_states: int
    sensor_pixels: int
    output_bytes: int
    max_camera_width: int
    max_camera_height: int
    pixels_per_frame: int

    @classmethod
    def parse(cls, value: Any) -> "RenderResourceRequest":
        if not isinstance(value, Mapping):
            raise ContractError("runtimeRequirements.resources must be an object")
        expected_fields = {
            "schema", "durationS", "sensors", "captureFrames", "actors",
            "actorFrameStates", "sensorPixels", "outputBytes", "maxCameraWidth",
            "maxCameraHeight", "pixelsPerFrame",
        }
        if set(value) != expected_fields:
            raise ContractError("runtimeRequirements.resources has invalid fields")
        if value.get("schema") != RENDER_RESOURCE_REQUEST_SCHEMA:
            raise ContractError(
                f"runtimeRequirements.resources.schema must equal {RENDER_RESOURCE_REQUEST_SCHEMA}"
            )

        duration = value.get("durationS")
        if (
            not isinstance(duration, (int, float))
            or isinstance(duration, bool)
            or not math.isfinite(float(duration))
            or not 0 < float(duration) <= MAX_DURATION_SECONDS
        ):
            raise ContractError(
                f"runtimeRequirements.resources.durationS must be in (0, {MAX_DURATION_SECONDS}]"
            )

        def bounded_integer(field: str, minimum: int, maximum: int) -> int:
            result = value.get(field)
            if (
                not isinstance(result, int)
                or isinstance(result, bool)
                or result < minimum
                or result > maximum
            ):
                raise ContractError(
                    f"runtimeRequirements.resources.{field} must be between {minimum} and {maximum}"
                )
            return result

        sensors = bounded_integer("sensors", 0, MAX_SENSOR_COUNT)
        capture_frames = bounded_integer("captureFrames", 0, MAX_CAPTURE_FRAMES)
        actors = bounded_integer("actors", 1, MAX_ACTOR_COUNT)
        actor_frame_states = bounded_integer("actorFrameStates", 1, MAX_ACTOR_FRAME_STATES)
        sensor_pixels = bounded_integer("sensorPixels", 0, MAX_SENSOR_PIXELS)
        output_bytes = bounded_integer("outputBytes", 1, MAX_OUTPUT_BYTES)
        max_camera_width = bounded_integer("maxCameraWidth", 0, MAX_SENSOR_PIXELS)
        max_camera_height = bounded_integer("maxCameraHeight", 0, MAX_SENSOR_PIXELS)
        pixels_per_frame = bounded_integer("pixelsPerFrame", 0, MAX_SENSOR_PIXELS)
        if sensors == 0 and any(
            (capture_frames, sensor_pixels, max_camera_width, max_camera_height, pixels_per_frame)
        ):
            raise ContractError("runtimeRequirements.resources declares capture work without sensors")
        if sensors > 0 and any(
            item == 0
            for item in (
                capture_frames, sensor_pixels, max_camera_width, max_camera_height, pixels_per_frame,
            )
        ):
            raise ContractError("runtimeRequirements.resources omits required sensor capture bounds")
        if actor_frame_states < actors:
            raise ContractError("runtimeRequirements.resources.actorFrameStates must cover every actor")
        return cls(
            RENDER_RESOURCE_REQUEST_SCHEMA,
            float(duration),
            sensors,
            capture_frames,
            actors,
            actor_frame_states,
            sensor_pixels,
            output_bytes,
            max_camera_width,
            max_camera_height,
            pixels_per_frame,
        )


@dataclass(frozen=True)
class RuntimeRequirements:
    schema: str
    xosc_version: str
    capability_profile: str
    fixed_timestep_s: float
    job_mode: str
    traffic_mode: str
    execution_mode: str
    camera_kinds: tuple[str, ...]
    outputs: tuple[str, ...]
    resources: RenderResourceRequest

    @classmethod
    def parse(cls, value: Any) -> "RuntimeRequirements":
        if not isinstance(value, Mapping):
            raise ContractError("executionPackage.runtimeRequirements must be an object")
        expected_fields = {
            "schema", "xoscVersion", "capabilityProfile", "fixedTimestepS", "jobMode",
            "trafficMode", "executionMode", "cameraKinds", "outputs", "resources",
        }
        if set(value) != expected_fields:
            raise ContractError("executionPackage.runtimeRequirements has invalid fields")
        if value.get("schema") != RUNTIME_REQUIREMENTS_SCHEMA:
            raise ContractError(f"runtimeRequirements.schema must equal {RUNTIME_REQUIREMENTS_SCHEMA}")
        if value.get("xoscVersion") != "1.4" or value.get("capabilityProfile") != CAPABILITY_PROFILE:
            raise ContractError("runtimeRequirements identifies an unsupported OpenSCENARIO capability profile")
        timestep = value.get("fixedTimestepS")
        if not isinstance(timestep, (int, float)) or isinstance(timestep, bool) or float(timestep) != 0.02:
            raise ContractError("runtimeRequirements.fixedTimestepS must equal 0.02")
        job_mode = value.get("jobMode")
        traffic_mode = value.get("trafficMode")
        execution_mode = value.get("executionMode")
        if job_mode not in {"interaction_2d", "full_render"}:
            raise ContractError("runtimeRequirements.jobMode is unsupported")
        if traffic_mode not in {"disabled", "native", "sumo"}:
            raise ContractError("runtimeRequirements.trafficMode is unsupported")
        if execution_mode not in {"native-physics", "diagnostic-replay"}:
            raise ContractError("runtimeRequirements.executionMode is unsupported")
        camera_kinds = value.get("cameraKinds")
        outputs = value.get("outputs")
        if not isinstance(camera_kinds, list) or camera_kinds != sorted(set(camera_kinds)) or any(
            item not in {"rgb", "depth", "semantic", "instance"} for item in camera_kinds
        ):
            raise ContractError("runtimeRequirements.cameraKinds must be sorted, unique supported values")
        if not isinstance(outputs, list) or outputs != sorted(set(outputs)) or any(
            item not in {"frames", "video", "trace", "manifest", "annotations"} for item in outputs
        ):
            raise ContractError("runtimeRequirements.outputs must be sorted, unique supported values")
        return cls(
            RUNTIME_REQUIREMENTS_SCHEMA, "1.4", CAPABILITY_PROFILE, 0.02,
            job_mode, traffic_mode, execution_mode, tuple(camera_kinds), tuple(outputs),
            RenderResourceRequest.parse(value.get("resources")),
        )


@dataclass(frozen=True)
class Camera:
    id: str
    kind: str
    attach_to: str | None
    transform: Mapping[str, float]
    fov: float
    mount: str


@dataclass(frozen=True)
class Environment:
    cloudiness: float = 0.0
    precipitation: float = 0.0
    precipitation_deposits: float = 0.0
    wind_intensity: float = 0.0
    sun_azimuth_angle: float = 0.0
    sun_altitude_angle: float = 45.0
    fog_density: float = 0.0
    fog_distance: float = 0.0
    wetness: float = 0.0


CAMERA_MOUNTS: Mapping[str, Mapping[str, float]] = {
    "chase": {"x": -7.5, "y": 0.0, "z": 3.0, "pitch": -12.0, "yaw": 0.0, "roll": 0.0},
    "hood": {"x": 1.4, "y": 0.0, "z": 1.25, "pitch": -3.0, "yaw": 0.0, "roll": 0.0},
    "dash": {"x": 0.35, "y": 0.0, "z": 1.4, "pitch": 0.0, "yaw": 0.0, "roll": 0.0},
    "roof": {"x": 0.0, "y": 0.0, "z": 2.3, "pitch": -5.0, "yaw": 0.0, "roll": 0.0},
    "birdseye": {"x": 0.0, "y": 0.0, "z": 28.0, "pitch": -90.0, "yaw": 0.0, "roll": 0.0},
    "world": {"x": 0.0, "y": 0.0, "z": 8.0, "pitch": -20.0, "yaw": 0.0, "roll": 0.0},
}


@dataclass(frozen=True)
class RenderSpec:
    schema: str
    width: int
    height: int
    fps: float
    cameras: tuple[Camera, ...]
    outputs: tuple[str, ...]
    execution_mode: str
    quality: str
    environment: Environment
    formats: tuple[str, ...]

    @classmethod
    def parse(cls, value: Any, allow_camera_free: bool = False) -> "RenderSpec":
        if not isinstance(value, Mapping):
            raise ContractError("renderSpec must be an object")
        expected_schema = "uniscenario.interaction-spec/v1" if allow_camera_free else "uniscenario.render-spec/v1"
        if value.get("schema") != expected_schema:
            raise ContractError(f"renderSpec.schema must equal {expected_schema}")
        width, height, fps = value.get("width"), value.get("height"), value.get("fps")
        if not isinstance(width, int) or not 64 <= width <= 8192:
            raise ContractError("renderSpec.width must be an integer in [64, 8192]")
        if not isinstance(height, int) or not 64 <= height <= 8192:
            raise ContractError("renderSpec.height must be an integer in [64, 8192]")
        if not isinstance(fps, (int, float)) or isinstance(fps, bool) or not math.isfinite(fps) or not 0 < fps <= 240:
            raise ContractError("renderSpec.fps must be in (0, 240]")
        raw_cameras = value.get("cameras")
        if not isinstance(raw_cameras, list) or len(raw_cameras) > MAX_SENSOR_COUNT or (not raw_cameras and not allow_camera_free):
            raise ContractError(f"renderSpec.cameras must contain 1..{MAX_SENSOR_COUNT} cameras, or be empty for interaction_2d")
        cameras: list[Camera] = []
        ids: set[str] = set()
        for index, raw in enumerate(raw_cameras):
            sensor_kind = raw.get("kind")
            if not isinstance(raw, Mapping) or sensor_kind not in {"rgb", "depth", "semantic", "instance"}:
                raise ContractError(f"renderSpec.cameras.{index} has an unsupported CARLA camera kind")
            camera_id = _required_string(raw, "id")
            if len(camera_id) > 100:
                raise ContractError(f"renderSpec.cameras.{index}.id exceeds 100 characters")
            if camera_id in ids:
                raise ContractError("renderSpec camera ids must be unique")
            ids.add(camera_id)
            mount = raw.get("mount", "chase")
            if mount not in CAMERA_MOUNTS:
                raise ContractError(f"renderSpec.cameras.{index}.mount is unsupported")
            transform = raw.get("transform", CAMERA_MOUNTS[mount])
            if not isinstance(transform, Mapping):
                raise ContractError(f"renderSpec.cameras.{index}.transform must be an object")
            numeric = {key: float(transform.get(key, 0.0)) for key in ("x", "y", "z", "pitch", "yaw", "roll")}
            if not all(math.isfinite(item) for item in numeric.values()):
                raise ContractError(f"renderSpec.cameras.{index}.transform must be finite")
            attach_to = raw.get("attachTo")
            if attach_to is not None and not isinstance(attach_to, str):
                raise ContractError(f"renderSpec.cameras.{index}.attachTo must be an actor id")
            if mount == "world" and attach_to:
                raise ContractError(f"renderSpec.cameras.{index}.world mount cannot attach to an actor")
            fov = float(raw.get("fov", 90))
            if not math.isfinite(fov) or not 0 < fov <= 179:
                raise ContractError(f"renderSpec.cameras.{index}.fov must be in (0, 179]")
            cameras.append(Camera(camera_id, sensor_kind, attach_to, numeric, fov, mount))
        outputs = value.get("outputs")
        allowed = {"frames", "video", "trace", "manifest", "annotations"}
        if not isinstance(outputs, list) or not outputs or any(item not in allowed for item in outputs):
            raise ContractError("renderSpec.outputs must contain frames, video, or trace")
        execution_mode = value.get("executionMode", "native-physics")
        if execution_mode not in {"native-physics", "diagnostic-replay"}:
            raise ContractError("renderSpec.executionMode must be native-physics or diagnostic-replay")
        quality = value.get("quality", "standard")
        if quality not in {"preview", "standard", "high", "cinematic"}:
            raise ContractError("renderSpec.quality is unsupported")
        raw_environment = value.get("environment", {})
        if not isinstance(raw_environment, Mapping):
            raise ContractError("renderSpec.environment must be an object")
        environment_fields = {
            "cloudiness": "cloudiness", "precipitation": "precipitation",
            "deposits": "precipitation_deposits", "wind": "wind_intensity",
            "sunAzimuth": "sun_azimuth_angle", "sunAltitude": "sun_altitude_angle",
            "fogDensity": "fog_density", "fogDistance": "fog_distance", "wetness": "wetness",
        }
        environment_values: dict[str, float] = {}
        for external, internal in environment_fields.items():
            number = float(raw_environment.get(external, getattr(Environment(), internal)))
            if not math.isfinite(number):
                raise ContractError(f"renderSpec.environment.{external} must be finite")
            if external == "sunAzimuth" and not 0 <= number <= 360:
                raise ContractError("renderSpec.environment.sunAzimuth must be in [0, 360]")
            if external == "sunAltitude" and not -90 <= number <= 90:
                raise ContractError("renderSpec.environment.sunAltitude must be in [-90, 90]")
            if external not in {"sunAzimuth", "sunAltitude", "fogDistance"} and not 0 <= number <= 100:
                raise ContractError(f"renderSpec.environment.{external} must be in [0, 100]")
            environment_values[internal] = number
        environment = Environment(**environment_values)
        raw_formats = value.get("formats", ["png", "mp4-h264", "json", "jsonl"])
        allowed_formats = {"png", "mp4-h264", "json", "jsonl"}
        if not isinstance(raw_formats, list) or not raw_formats or any(item not in allowed_formats for item in raw_formats):
            raise ContractError("renderSpec.formats contains an unsupported format")
        required_format = {"frames": "png", "video": "mp4-h264", "trace": "json", "manifest": "json", "annotations": "jsonl"}
        missing_formats = sorted({required_format[output] for output in outputs} - set(raw_formats))
        if missing_formats:
            raise ContractError(f"renderSpec.formats is missing required formats: {', '.join(missing_formats)}")
        if "video" in outputs and not any(camera.kind == "rgb" for camera in cameras):
            raise ContractError("video output requires at least one RGB camera")
        return cls(expected_schema, width, height, float(fps), tuple(cameras), tuple(dict.fromkeys(outputs)), execution_mode, quality, environment, tuple(dict.fromkeys(raw_formats)))


@dataclass(frozen=True)
class ExecutionPackage:
    id: str
    revision_id: str
    source_input_digest: str
    materialized_traffic_digest: str
    map_asset_id: str
    map_version_id: str
    manifest: Asset
    xosc: XoscAsset
    xodr: XodrAsset
    asset_catalog: AssetCatalogAsset
    ambient: Mapping[str, Any]
    runtime_requirements: RuntimeRequirements
    control_sha256: str

    @classmethod
    def parse(cls, value: Any) -> "ExecutionPackage":
        if not isinstance(value, Mapping) or value.get("schema") != SCHEMA:
            raise ContractError(f"executionPackage.schema must equal {SCHEMA}")
        expected_fields = {
            "schema", "id", "revisionId", "sourceInputDigest", "materializedTrafficDigest", "mapAssetId", "mapVersionId", "manifest", "xosc", "xodr", "assetCatalog",
            "ambient", "runtimeRequirements", "controlSha256",
        }
        if set(value) != expected_fields:
            raise ContractError("executionPackage has invalid fields")
        control_sha256 = _sha(value, "controlSha256")
        ambient = value.get("ambient")
        if not isinstance(ambient, Mapping) or ambient.get("ambientMode") not in {"disabled", "native", "sumo"}:
            raise ContractError("executionPackage.ambient.ambientMode must be disabled, native, or sumo")
        mode = ambient["ambientMode"]
        allowed = {
            "disabled": {"ambientMode", "ambientConfig", "configSha256", "resultSha256", "materializedTraffic"},
            "native": {"ambientMode", "runtimeVersion", "seed", "ambientConfig", "configSha256", "resultSha256", "materializedTraffic"},
            "sumo": {"ambientMode", "sumoVersion", "networkSha256", "seed", "ambientConfig", "configSha256", "resultSha256", "materializedTraffic"},
        }[mode]
        if set(ambient) != allowed:
            raise ContractError(f"executionPackage.ambient has invalid fields for {mode} mode")
        config = ambient.get("ambientConfig")
        if not isinstance(config, Mapping):
            raise ContractError("ambientConfig must be an object")
        config_sha = _sha(ambient, "configSha256")
        result_sha = _sha(ambient, "resultSha256")
        if canonical_sha256(config) != config_sha:
            raise ContractError("ambientConfig digest mismatch")
        if mode == "disabled":
            if config or config_sha != EMPTY_AMBIENT_CONFIG_SHA256:
                raise ContractError("disabled ambient provenance must identify deterministic empty configuration")
            materialized = Asset.parse(ambient.get("materializedTraffic"), "materializedTraffic", MAX_TRAFFIC_BYTES)
            if materialized.sha256 != result_sha:
                raise ContractError("materializedTraffic must match ambient resultSha256")
            ambient = {**ambient, "materializedTraffic": materialized}
        elif mode == "native":
            _required_string(ambient, "runtimeVersion")
            _required_string(ambient, "seed")
            materialized = Asset.parse(ambient.get("materializedTraffic"), "materializedTraffic", MAX_TRAFFIC_BYTES)
            if materialized.sha256 != result_sha:
                raise ContractError("materializedTraffic must match ambient resultSha256")
            ambient = {**ambient, "materializedTraffic": materialized}
        else:
            _required_string(ambient, "sumoVersion")
            _sha(ambient, "networkSha256")
            _required_string(ambient, "seed")
            materialized = Asset.parse(ambient.get("materializedTraffic"), "materializedTraffic", MAX_TRAFFIC_BYTES)
            if materialized.sha256 != result_sha:
                raise ContractError("materializedTraffic must match ambient resultSha256")
            ambient = {**ambient, "materializedTraffic": materialized}
        package_id = _required_string(value, "id")
        revision_id = _required_string(value, "revisionId")
        source_input_digest = _sha(value, "sourceInputDigest")
        materialized_traffic_digest = _sha(value, "materializedTrafficDigest")
        if materialized_traffic_digest != result_sha:
            raise ContractError("materializedTrafficDigest must match ambient resultSha256")
        map_asset_id = _required_string(value, "mapAssetId")
        map_version_id = _required_string(value, "mapVersionId")
        manifest = Asset.parse(value.get("manifest"), "manifest", MAX_MANIFEST_BYTES)
        xosc = XoscAsset.parse(value.get("xosc"))
        xodr = XodrAsset.parse(value.get("xodr"))
        asset_catalog = AssetCatalogAsset.parse(value.get("assetCatalog"))
        runtime_requirements = RuntimeRequirements.parse(value.get("runtimeRequirements"))
        actual_control_sha256 = canonical_sha256(_control_value(value))
        if actual_control_sha256 != control_sha256:
            raise ContractError(
                f"executionPackage control digest mismatch: expected {control_sha256}, got {actual_control_sha256}"
            )
        return cls(
            package_id, revision_id, source_input_digest, materialized_traffic_digest, map_asset_id, map_version_id, manifest, xosc, xodr, asset_catalog,
            ambient, runtime_requirements, control_sha256,
        )


@dataclass(frozen=True)
class Lease:
    lease_token: str
    lease_expires_at: str
    job_id: str
    attempt: int
    execution_package: ExecutionPackage
    render_spec: RenderSpec
    parity_thresholds: Mapping[str, float]
    artifact_uploads: Mapping[str, Any]
    job_mode: str


NATIVE_PHYSICS_PARITY_LIMITS = {
    "positionM": 2.0,
    "headingDeg": 5.0,
    "speedMps": 1.0,
}


def _parse_parity_thresholds(value: Any) -> Mapping[str, float]:
    if not isinstance(value, Mapping):
        raise ContractError("parityThresholds must be an object")
    parsed = {key: float(item) for key, item in value.items()}
    unsupported = sorted(set(parsed) - set(NATIVE_PHYSICS_PARITY_LIMITS))
    if unsupported:
        raise ContractError(f"unsupported parity thresholds: {', '.join(unsupported)}")
    if any(not math.isfinite(item) or item < 0 for item in parsed.values()):
        raise ContractError("parity thresholds must be finite and non-negative")
    exceeded = sorted(
        key for key, item in parsed.items()
        if item > NATIVE_PHYSICS_PARITY_LIMITS[key]
    )
    if exceeded:
        raise ContractError(
            "parity thresholds cannot exceed the native-physics acceptance limits: "
            + ", ".join(exceeded)
        )
    return parsed


def parse_lease(value: Any) -> Lease:
    if not isinstance(value, Mapping) or not isinstance(value.get("job"), Mapping):
        raise ContractError("lease must contain a job object")
    job = value["job"]
    attempt = job.get("attempt")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise ContractError("job.attempt must be a positive integer")
    thresholds = job.get("parityThresholds", {})
    uploads = job.get("artifactUploads", {})
    if not isinstance(uploads, Mapping):
        raise ContractError("artifactUploads must be an object")
    parsed_thresholds = _parse_parity_thresholds(thresholds)
    job_mode = job.get("mode")
    if job_mode not in {"interaction_2d", "full_render"}:
        raise ContractError("job.mode must be interaction_2d or full_render")
    render_spec = RenderSpec.parse(job.get("renderSpec"), allow_camera_free=job_mode == "interaction_2d")
    if job_mode == "interaction_2d" and render_spec.cameras:
        raise ContractError("interaction_2d jobs must not include cameras")
    expected_uploads = {"trace"}
    expected_uploads.update(output for output in render_spec.outputs if output != "frames")
    if "frames" in render_spec.outputs:
        expected_uploads.update(f"framesArchive-{camera.id}" for camera in render_spec.cameras)
    missing_uploads = sorted(expected_uploads - set(uploads))
    if missing_uploads:
        raise ContractError(f"artifactUploads is missing reservations: {', '.join(missing_uploads)}")
    for kind, reservation in uploads.items():
        if not isinstance(kind, str) or not isinstance(reservation, Mapping):
            raise ContractError("artifactUploads must map kinds to reservation objects")
        _required_string(reservation, "uploadUrl")
        _required_string(reservation, "artifactUrl")
        _required_string(reservation, "uploadId")
        headers = reservation.get("headers", {})
        if not isinstance(headers, Mapping) or any(not isinstance(key, str) or not isinstance(item, str) for key, item in headers.items()):
            raise ContractError(f"artifactUploads.{kind}.headers must be a string map")
    lease_token = _required_string(value, "leaseToken")
    if len(lease_token) < 32:
        raise ContractError("leaseToken must contain at least 32 characters")
    execution_package = ExecutionPackage.parse(job.get("executionPackage"))
    requirements = execution_package.runtime_requirements
    actual_camera_kinds = tuple(sorted({camera.kind for camera in render_spec.cameras}))
    actual_outputs = tuple(sorted(render_spec.outputs))
    if (
        requirements.job_mode != job_mode
        or requirements.traffic_mode != execution_package.ambient["ambientMode"]
        or requirements.execution_mode != render_spec.execution_mode
        or requirements.camera_kinds != actual_camera_kinds
        or requirements.outputs != actual_outputs
    ):
        raise ContractError("runtimeRequirements do not match the leased job and render specification")
    return Lease(
        lease_token,
        _required_string(value, "leaseExpiresAt"),
        _required_string(job, "id"),
        attempt,
        execution_package,
        render_spec,
        parsed_thresholds,
        uploads,
        job_mode,
    )
