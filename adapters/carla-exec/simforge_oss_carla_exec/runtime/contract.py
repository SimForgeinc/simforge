from __future__ import annotations

from .._compat_env import simforge_env
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping

SCHEMA = "simforge.execution-package/v1"
ASSET_CATALOG_SCHEMA = "simforge.asset-catalog/v1"
RUNTIME_REQUIREMENTS_SCHEMA = "simforge.runtime-requirements/v1"
RENDER_RESOURCE_REQUEST_SCHEMA = "simforge.render-resource-request/v1"
INTERACTION_SPEC_SCHEMA = "simforge.interaction-spec/v1"
RENDER_SPEC_SCHEMA = "simforge.render-spec/v1"
# historical name retained for stored-data compat
HISTORICAL_SCHEMAS = {
    SCHEMA: "uniscenario.execution-package/v1",
    ASSET_CATALOG_SCHEMA: "uniscenario.asset-catalog/v1",
    RUNTIME_REQUIREMENTS_SCHEMA: "uniscenario.runtime-requirements/v1",
    RENDER_RESOURCE_REQUEST_SCHEMA: "uniscenario.render-resource-request/v1",
    INTERACTION_SPEC_SCHEMA: "uniscenario.interaction-spec/v1",
    RENDER_SPEC_SCHEMA: "uniscenario.render-spec/v1",
}
OFFICIAL_XSD_SHA256 = "949fe2bcebd1f3fdb941a2cc56641482737ab48e3c5b0eed0ee5294b2355c0e9"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_XOSC_BYTES = 16 * 1024 * 1024
MAX_XODR_BYTES = 128 * 1024 * 1024
MAX_CATALOG_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_TRAFFIC_BYTES = 64 * 1024 * 1024
MAX_SENSOR_COUNT = 64
MAX_ACTOR_COUNT = 256
MAX_DURATION_SECONDS = 300.0
MAX_CAPTURE_FRAMES = 18_000
MAX_ACTOR_FRAME_STATES = 2_000_000
MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024
CAPABILITY_PROFILE = "xml-1.4-trajectory-replay"
EMPTY_AMBIENT_CONFIG_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
EMPTY_AMBIENT_RESULT_SHA256 = "1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840"


class ContractError(ValueError):
    """An immutable execution package or lease violated its contract."""


def _configured_max_sensor_pixels() -> int:
    """Aggregate sensor-sample guard. 6e9 covers a 20 s, 9-camera 1280x720@24
    Pronto intent (~3.98e9). It bounds compute and temporary-disk pressure, not
    memory: camera frames stream straight into their per-camera ffmpeg encoder
    and never land on disk; lidar/radar data lands per frame.
    Fail-closed above the bound; override via SIMFORGE_MAX_SENSOR_PIXELS."""
    raw = simforge_env("MAX_SENSOR_PIXELS", "").strip()
    if not raw:
        return 6_000_000_000
    if not raw.isdigit() or int(raw) <= 0:
        raise ContractError("SIMFORGE_MAX_SENSOR_PIXELS must be a positive integer")
    return int(raw)


MAX_SENSOR_PIXELS = _configured_max_sensor_pixels()


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
        if value.get("contractVersion") not in {ASSET_CATALOG_SCHEMA, HISTORICAL_SCHEMAS[ASSET_CATALOG_SCHEMA]}:
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
    sensor_samples: int
    output_bytes: int
    max_frame_width: int
    max_frame_height: int
    samples_per_frame: int

    @classmethod
    def parse(cls, value: Any) -> "RenderResourceRequest":
        if not isinstance(value, Mapping):
            raise ContractError("runtimeRequirements.resources must be an object")
        expected_fields = {
            "schema", "durationS", "sensors", "captureFrames", "actors",
            "actorFrameStates", "sensorSamples", "outputBytes", "maxFrameWidth",
            "maxFrameHeight", "samplesPerFrame",
        }
        if set(value) != expected_fields:
            raise ContractError("runtimeRequirements.resources has invalid fields")
        if value.get("schema") not in {RENDER_RESOURCE_REQUEST_SCHEMA, HISTORICAL_SCHEMAS[RENDER_RESOURCE_REQUEST_SCHEMA]}:
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
        sensor_samples = bounded_integer("sensorSamples", 0, MAX_SENSOR_PIXELS)
        output_bytes = bounded_integer("outputBytes", 1, MAX_OUTPUT_BYTES)
        max_frame_width = bounded_integer("maxFrameWidth", 0, MAX_SENSOR_PIXELS)
        max_frame_height = bounded_integer("maxFrameHeight", 0, MAX_SENSOR_PIXELS)
        samples_per_frame = bounded_integer("samplesPerFrame", 0, MAX_SENSOR_PIXELS)
        if sensors == 0 and any(
            (capture_frames, sensor_samples, max_frame_width, max_frame_height, samples_per_frame)
        ):
            raise ContractError("runtimeRequirements.resources declares capture work without sensors")
        if sensors > 0 and any(
            item == 0 for item in (capture_frames, sensor_samples, samples_per_frame)
        ):
            raise ContractError("runtimeRequirements.resources omits required sensor capture bounds")
        if (max_frame_width == 0) != (max_frame_height == 0):
            raise ContractError("runtimeRequirements.resources raster dimensions must both be zero or non-zero")
        if actor_frame_states < actors:
            raise ContractError("runtimeRequirements.resources.actorFrameStates must cover every actor")
        return cls(
            RENDER_RESOURCE_REQUEST_SCHEMA,
            float(duration),
            sensors,
            capture_frames,
            actors,
            actor_frame_states,
            sensor_samples,
            output_bytes,
            max_frame_width,
            max_frame_height,
            samples_per_frame,
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
    sensor_modalities: tuple[str, ...]
    outputs: tuple[str, ...]
    resources: RenderResourceRequest

    @classmethod
    def parse(cls, value: Any) -> "RuntimeRequirements":
        if not isinstance(value, Mapping):
            raise ContractError("executionPackage.runtimeRequirements must be an object")
        expected_fields = {
            "schema", "xoscVersion", "capabilityProfile", "fixedTimestepS", "jobMode",
            "trafficMode", "executionMode", "sensorModalities", "outputs", "resources",
        }
        if set(value) != expected_fields:
            raise ContractError("executionPackage.runtimeRequirements has invalid fields")
        if value.get("schema") not in {RUNTIME_REQUIREMENTS_SCHEMA, HISTORICAL_SCHEMAS[RUNTIME_REQUIREMENTS_SCHEMA]}:
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
        sensor_modalities = value.get("sensorModalities")
        outputs = value.get("outputs")
        if (
            not isinstance(sensor_modalities, list)
            or sensor_modalities != sorted(set(sensor_modalities))
            or any(item not in SENSOR_MODALITIES for item in sensor_modalities)
        ):
            raise ContractError("runtimeRequirements.sensorModalities must be sorted, unique supported values")
        if not isinstance(outputs, list) or outputs != sorted(set(outputs)) or any(
            item not in {"video", "trace", "manifest", "annotations"} for item in outputs
        ):
            raise ContractError("runtimeRequirements.outputs must be sorted, unique supported values")
        return cls(
            RUNTIME_REQUIREMENTS_SCHEMA, "1.4", CAPABILITY_PROFILE, 0.02,
            job_mode, traffic_mode, execution_mode, tuple(sensor_modalities), tuple(outputs),
            RenderResourceRequest.parse(value.get("resources")),
        )


CAMERA_MODALITIES = frozenset({"rgb", "depth", "semantic", "instance", "normals"})
LIDAR_MODALITIES = frozenset({"lidar", "semantic-lidar"})
RADAR_MODALITIES = frozenset({"radar"})
SENSOR_MODALITIES = CAMERA_MODALITIES | LIDAR_MODALITIES | RADAR_MODALITIES
SENSOR_FORMATS: Mapping[str, str] = {
    **{modality: "png" for modality in CAMERA_MODALITIES},
    **{modality: "ply" for modality in LIDAR_MODALITIES},
    "radar": "csv",
}


@dataclass(frozen=True)
class Sensor:
    role: str
    actor_id: str | None
    sensor_id: str
    modality: str
    transform: Mapping[str, float]
    config: Mapping[str, int | float]

    @property
    def artifact_key(self) -> tuple[str, str | None, str, str]:
        return self.role, self.actor_id, self.sensor_id, self.modality

    @property
    def artifact_name(self) -> str:
        actor = self.actor_id if self.actor_id is not None else "world"
        return f"{self.role}:{actor}:{self.sensor_id}:{self.modality}"


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


def _finite_number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ContractError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ContractError(f"{label} must be in [{minimum}, {maximum}]")
    return result


def _parse_sensor_config(modality: str, value: Any, label: str) -> Mapping[str, int | float]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{label} must be an object")
    if modality in CAMERA_MODALITIES:
        expected = {"width", "height", "fov"}
        if set(value) != expected:
            raise ContractError(f"{label} must contain exactly width, height, and fov")
        width, height = value["width"], value["height"]
        if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 8192:
            raise ContractError(f"{label}.width must be an integer in [64, 8192]")
        if not isinstance(height, int) or isinstance(height, bool) or not 64 <= height <= 8192:
            raise ContractError(f"{label}.height must be an integer in [64, 8192]")
        return {
            "width": width,
            "height": height,
            "fov": _finite_number(value["fov"], f"{label}.fov", 0.001, 179.0),
        }
    if modality in LIDAR_MODALITIES:
        expected = {
            "channels", "rangeM", "pointsPerSecond", "rotationFrequencyHz",
            "upperFovDeg", "lowerFovDeg",
        }
        if set(value) != expected:
            raise ContractError(f"{label} has invalid {modality} fields")
        channels, points = value["channels"], value["pointsPerSecond"]
        if not isinstance(channels, int) or isinstance(channels, bool) or not 1 <= channels <= 256:
            raise ContractError(f"{label}.channels must be an integer in [1, 256]")
        if not isinstance(points, int) or isinstance(points, bool) or not 1 <= points <= 20_000_000:
            raise ContractError(f"{label}.pointsPerSecond must be an integer in [1, 20000000]")
        upper = _finite_number(value["upperFovDeg"], f"{label}.upperFovDeg", -90.0, 90.0)
        lower = _finite_number(value["lowerFovDeg"], f"{label}.lowerFovDeg", -90.0, 90.0)
        if lower >= upper:
            raise ContractError(f"{label}.lowerFovDeg must be less than upperFovDeg")
        return {
            "channels": channels,
            "rangeM": _finite_number(value["rangeM"], f"{label}.rangeM", 0.1, 1000.0),
            "pointsPerSecond": points,
            "rotationFrequencyHz": _finite_number(
                value["rotationFrequencyHz"], f"{label}.rotationFrequencyHz", 0.01, 1000.0,
            ),
            "upperFovDeg": upper,
            "lowerFovDeg": lower,
        }
    expected = {"horizontalFovDeg", "verticalFovDeg", "rangeM", "pointsPerSecond"}
    if set(value) != expected:
        raise ContractError(f"{label} has invalid radar fields")
    points = value["pointsPerSecond"]
    if not isinstance(points, int) or isinstance(points, bool) or not 1 <= points <= 20_000_000:
        raise ContractError(f"{label}.pointsPerSecond must be an integer in [1, 20000000]")
    return {
        "horizontalFovDeg": _finite_number(value["horizontalFovDeg"], f"{label}.horizontalFovDeg", 0.001, 180.0),
        "verticalFovDeg": _finite_number(value["verticalFovDeg"], f"{label}.verticalFovDeg", 0.001, 180.0),
        "rangeM": _finite_number(value["rangeM"], f"{label}.rangeM", 0.1, 1000.0),
        "pointsPerSecond": points,
    }


@dataclass(frozen=True)
class RenderSpec:
    schema: str
    fps: float
    sensors: tuple[Sensor, ...]
    outputs: tuple[str, ...]
    execution_mode: str
    quality: str
    environment: Environment
    formats: tuple[str, ...]

    @classmethod
    def parse(cls, value: Any, allow_sensor_free: bool = False) -> "RenderSpec":
        if not isinstance(value, Mapping):
            raise ContractError("renderSpec must be an object")
        expected_schema = INTERACTION_SPEC_SCHEMA if allow_sensor_free else RENDER_SPEC_SCHEMA
        allowed_fields = {
            "schema", "fps", "sensors", "outputs", "executionMode", "quality",
            "environment", "formats",
        }
        required_fields = {"schema", "fps", "sensors", "outputs"}
        if set(value) - allowed_fields or not required_fields.issubset(value):
            raise ContractError("renderSpec has invalid fields")
        if value.get("schema") not in {expected_schema, HISTORICAL_SCHEMAS[expected_schema]}:
            raise ContractError(f"renderSpec.schema must equal {expected_schema}")
        fps = _finite_number(value.get("fps"), "renderSpec.fps", 0.001, 240.0)
        raw_sensors = value.get("sensors")
        if (
            not isinstance(raw_sensors, list)
            or len(raw_sensors) > MAX_SENSOR_COUNT
            or (not raw_sensors and not allow_sensor_free)
        ):
            raise ContractError(
                f"renderSpec.sensors must contain 1..{MAX_SENSOR_COUNT} sensors, or be empty for interaction_2d"
            )
        sensors: list[Sensor] = []
        identities: set[tuple[str, str | None, str, str]] = set()
        for index, raw in enumerate(raw_sensors):
            label = f"renderSpec.sensors.{index}"
            if not isinstance(raw, Mapping) or set(raw) != {
                "role", "actorId", "sensorId", "modality", "transform", "config",
            }:
                raise ContractError(f"{label} must use the strict generic sensor shape")
            role = _required_string(raw, "role")
            sensor_id = _required_string(raw, "sensorId")
            if (
                len(role) > 100
                or len(sensor_id) > 100
                or not re.fullmatch(r"[A-Za-z0-9._-]+", role)
                or not re.fullmatch(r"[A-Za-z0-9._-]+", sensor_id)
            ):
                raise ContractError(f"{label} identity must use 1..100 portable characters")
            actor_id = raw.get("actorId")
            if actor_id is not None and (not isinstance(actor_id, str) or not actor_id):
                raise ContractError(f"{label}.actorId must be a non-empty actor id or null")
            modality = raw.get("modality")
            if modality not in SENSOR_MODALITIES:
                raise ContractError(f"{label}.modality is unsupported")
            transform = raw.get("transform")
            if not isinstance(transform, Mapping) or set(transform) != {"x", "y", "z", "pitch", "yaw", "roll"}:
                raise ContractError(f"{label}.transform must contain exactly x, y, z, pitch, yaw, and roll")
            numeric_transform = {
                key: _finite_number(transform[key], f"{label}.transform.{key}", -1_000_000.0, 1_000_000.0)
                for key in ("x", "y", "z", "pitch", "yaw", "roll")
            }
            config = _parse_sensor_config(modality, raw.get("config"), f"{label}.config")
            sensor = Sensor(role, actor_id, sensor_id, modality, numeric_transform, config)
            if sensor.artifact_key in identities:
                raise ContractError("renderSpec sensor artifact identities must be unique")
            identities.add(sensor.artifact_key)
            sensors.append(sensor)
        outputs = value.get("outputs")
        allowed_outputs = {"video", "trace", "manifest", "annotations"}
        if not isinstance(outputs, list) or not outputs or outputs != list(dict.fromkeys(outputs)) or any(
            item not in allowed_outputs for item in outputs
        ):
            raise ContractError("renderSpec.outputs must contain unique supported values")
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
        if set(raw_environment) - set(environment_fields):
            raise ContractError("renderSpec.environment has invalid fields")
        environment_values: dict[str, float] = {}
        defaults = Environment()
        for external, internal in environment_fields.items():
            default = getattr(defaults, internal)
            minimum, maximum = (
                (-90.0, 90.0) if external == "sunAltitude" else
                (0.0, 360.0) if external == "sunAzimuth" else
                (0.0, 1_000_000.0) if external == "fogDistance" else
                (0.0, 100.0)
            )
            environment_values[internal] = _finite_number(
                raw_environment.get(external, default), f"renderSpec.environment.{external}", minimum, maximum,
            )
        environment = Environment(**environment_values)
        raw_formats = value.get("formats", ["png", "ply", "csv", "mp4-h264", "json", "jsonl"])
        allowed_formats = {"png", "ply", "csv", "mp4-h264", "json", "jsonl"}
        if not isinstance(raw_formats, list) or not raw_formats or raw_formats != list(dict.fromkeys(raw_formats)) or any(
            item not in allowed_formats for item in raw_formats
        ):
            raise ContractError("renderSpec.formats contains an unsupported or duplicate format")
        required_formats = {
            # Lidar/radar measurement data always uploads; camera frames exist
            # only as encoded video, so no image format is ever required.
            *(
                SENSOR_FORMATS[sensor.modality] for sensor in sensors
                if sensor.modality not in CAMERA_MODALITIES
            ),
            *({"mp4-h264"} if "video" in outputs else set()),
            *({"json"} if any(output in outputs for output in ("trace", "manifest")) else set()),
            *({"jsonl"} if "annotations" in outputs else set()),
        }
        missing_formats = sorted(required_formats - set(raw_formats))
        if missing_formats:
            raise ContractError(f"renderSpec.formats is missing required formats: {', '.join(missing_formats)}")
        if "video" in outputs and not any(sensor.modality == "rgb" for sensor in sensors):
            raise ContractError("video output requires at least one RGB sensor")
        return cls(
            expected_schema, fps, tuple(sensors), tuple(outputs), execution_mode,
            quality, environment, tuple(raw_formats),
        )


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
        if not isinstance(value, Mapping) or value.get("schema") not in {SCHEMA, HISTORICAL_SCHEMAS[SCHEMA]}:
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
    "headingDeg": 45.0,
    "speedMps": 2.0,
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
    render_spec = RenderSpec.parse(job.get("renderSpec"), allow_sensor_free=job_mode == "interaction_2d")
    if job_mode == "interaction_2d" and render_spec.sensors:
        raise ContractError("interaction_2d jobs must not include sensors")
    expected_uploads = {"trace"}
    expected_uploads.update(render_spec.outputs)
    if "video" in render_spec.outputs:
        # The primary RGB camera's encoded stream uploads as the review
        # "video"; every other sensor gets its own sensorVideo upload
        # (camera streams plus lidar/radar visualizations).
        primary_rgb = next(
            (sensor for sensor in render_spec.sensors if sensor.modality == "rgb"), None,
        )
        expected_uploads.update(
            f"sensorVideo:{sensor.artifact_name}"
            for sensor in render_spec.sensors
            if sensor is not primary_rgb
        )
    # Lidar/radar measurement data always uploads; camera frame archives were
    # removed with individual frame persistence.
    expected_uploads.update(
        f"sensorData:{sensor.artifact_name}"
        for sensor in render_spec.sensors
        if sensor.modality in LIDAR_MODALITIES or sensor.modality in RADAR_MODALITIES
    )
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
    actual_sensor_modalities = tuple(sorted({sensor.modality for sensor in render_spec.sensors}))
    actual_outputs = tuple(sorted(render_spec.outputs))
    if (
        requirements.job_mode != job_mode
        or requirements.traffic_mode != execution_package.ambient["ambientMode"]
        or requirements.execution_mode != render_spec.execution_mode
        or requirements.sensor_modalities != actual_sensor_modalities
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
