from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

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

