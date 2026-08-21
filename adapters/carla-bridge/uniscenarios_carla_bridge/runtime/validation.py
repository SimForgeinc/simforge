from __future__ import annotations

import hashlib
import math
import os
import subprocess
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

from .contract import ContractError, OFFICIAL_XSD_SHA256, reject_unsafe_xml_envelope


MAX_VALIDATION_DIAGNOSTIC_BYTES = 16 * 1024


def validate_xosc14(xml_bytes: bytes, xsd_path: Path) -> dict[str, object]:
    reject_unsafe_xml_envelope(xml_bytes)
    if not xsd_path.is_file():
        raise ContractError(f"official OpenSCENARIO 1.4 XSD is missing: {xsd_path}")
    xsd_digest = hashlib.sha256(xsd_path.read_bytes()).hexdigest()
    if xsd_digest != OFFICIAL_XSD_SHA256:
        raise ContractError(f"official XSD digest mismatch: expected {OFFICIAL_XSD_SHA256}, got {xsd_digest}")
    timeout_seconds = float(os.environ.get("UNISCENARIO_XML_VALIDATION_TIMEOUT_S", "10"))
    if not 0 < timeout_seconds <= 60:
        raise ContractError("UNISCENARIO_XML_VALIDATION_TIMEOUT_S must be in (0, 60]")
    try:
        result = subprocess.run(
            ["xmllint", "--nonet", "--noout", "--schema", str(xsd_path), "-"],
            input=xml_bytes,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ContractError(f"OpenSCENARIO XML validation exceeded {timeout_seconds:g} seconds") from exc
    if result.returncode:
        diagnostic = result.stderr[:MAX_VALIDATION_DIAGNOSTIC_BYTES].decode(errors="replace").strip()
        raise ContractError(f"official OpenSCENARIO 1.4 XSD validation failed: {diagnostic}")
    return {
        "standardVersion": "1.4.0",
        "xsdSha256": xsd_digest,
        "xmlSha256": hashlib.sha256(xml_bytes).hexdigest(),
        "valid": True,
        "validator": "xmllint --nonet",
    }

def validate_sensor_evidence(
    render_spec: Any,
    records: Sequence[Mapping[str, Any]],
    expected_frame_count: int,
) -> list[Mapping[str, Any]]:
    """Fail closed unless every configured sensor attests every output frame."""
    sensors = {sensor.id: sensor for sensor in render_spec.sensors}
    if len(sensors) != len(render_spec.sensors):
        raise ContractError("render sensor identifiers are not unique")
    if len(records) != len(sensors) * expected_frame_count:
        raise ContractError(
            f"sensor evidence contains {len(records)} of {len(sensors) * expected_frame_count} records"
        )
    indexes: dict[str, list[int]] = defaultdict(list)
    normalized: list[Mapping[str, Any]] = []
    image_kinds = {"rgb", "depth", "semantic", "instance", "normals"}
    base_fields = {
        "sensorId",
        "kind",
        "format",
        "outputFrameIndex",
        "scheduledTimeS",
        "carlaFrame",
        "timestamp",
        "relativePath",
        "attachTo",
        "attachment",
        "transform",
        "relativeMatrix",
        "canonicalWorldMatrix",
        "attributes",
    }

    def finite_vector(value: Any, size: int, path: str) -> None:
        if (
            not isinstance(value, list)
            or len(value) != size
            or any(
                not isinstance(item, (int, float))
                or isinstance(item, bool)
                or not math.isfinite(float(item))
                for item in value
            )
        ):
            raise ContractError(f"{path} must be a finite row-major vector of length {size}")

    for record_index, record in enumerate(records):
        if not isinstance(record, Mapping):
            raise ContractError(f"sensor evidence record {record_index} must be an object")
        sensor_id = record.get("sensorId")
        sensor = sensors.get(sensor_id)
        if sensor is None:
            raise ContractError(f"sensor evidence references unknown sensor {sensor_id}")
        expected_fields = base_fields | ({"calibration"} if sensor.kind in image_kinds else set())
        if set(record) != expected_fields:
            raise ContractError(f"sensor evidence for {sensor_id} has invalid fields")
        output_index = record.get("outputFrameIndex")
        carla_frame = record.get("carlaFrame")
        timestamp = record.get("timestamp")
        scheduled_time = record.get("scheduledTimeS")
        if (
            not isinstance(output_index, int)
            or isinstance(output_index, bool)
            or not 0 <= output_index < expected_frame_count
        ):
            raise ContractError(f"sensor evidence for {sensor_id} has an invalid outputFrameIndex")
        if not isinstance(carla_frame, int) or isinstance(carla_frame, bool) or carla_frame < 0:
            raise ContractError(f"sensor evidence for {sensor_id} has an invalid carlaFrame")
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            for value in (timestamp, scheduled_time)
        ):
            raise ContractError(f"sensor evidence for {sensor_id} has invalid timing")
        if abs(float(scheduled_time) - output_index / render_spec.fps) > 1e-9:
            raise ContractError(f"sensor evidence for {sensor_id} has inconsistent scheduledTimeS")
        if (
            record.get("kind") != sensor.kind
            or record.get("format") != sensor.format
            or record.get("attachTo") != sensor.attach_to
            or record.get("attachment") != sensor.attachment
            or record.get("transform") != sensor.transform
            or record.get("attributes") != sensor.attributes
            or record.get("relativePath") != f"{sensor_id}/{output_index:08d}.{sensor.format}"
        ):
            raise ContractError(f"sensor evidence for {sensor_id} does not match the render specification")
        finite_vector(record.get("relativeMatrix"), 16, f"sensor evidence {sensor_id}.relativeMatrix")
        finite_vector(
            record.get("canonicalWorldMatrix"),
            16,
            f"sensor evidence {sensor_id}.canonicalWorldMatrix",
        )
        if sensor.kind in image_kinds:
            calibration = record.get("calibration")
            if not isinstance(calibration, Mapping) or set(calibration) != {
                "intrinsicMatrix",
                "width",
                "height",
                "fov",
                "clipNear",
                "clipFar",
            }:
                raise ContractError(f"sensor evidence for {sensor_id} has invalid calibration")
            finite_vector(
                calibration.get("intrinsicMatrix"),
                9,
                f"sensor evidence {sensor_id}.calibration.intrinsicMatrix",
            )
            if (
                calibration.get("width") != sensor.attributes["width"]
                or calibration.get("height") != sensor.attributes["height"]
                or calibration.get("fov") != sensor.attributes["fov"]
                or calibration.get("clipNear") != sensor.attributes["clipNear"]
                or calibration.get("clipFar") != sensor.attributes["clipFar"]
            ):
                raise ContractError(f"sensor evidence for {sensor_id} has inconsistent calibration")
        indexes[sensor_id].append(output_index)
        normalized.append(dict(record))
    expected_indexes = list(range(expected_frame_count))
    for sensor_id in sensors:
        if sorted(indexes[sensor_id]) != expected_indexes:
            raise ContractError(f"sensor evidence for {sensor_id} is not frame-closed")
    return sorted(
        normalized,
        key=lambda item: (int(item["outputFrameIndex"]), str(item["sensorId"])),
    )

