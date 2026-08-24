from __future__ import annotations

import hashlib

from types import SimpleNamespace
import pytest

from uniscenarios_carla_bridge import local
from uniscenarios_carla_bridge.runtime.contract import OFFICIAL_XSD_SHA256


def test_default_schema_is_bundled_and_digest_pinned() -> None:
    assert local.DEFAULT_XSD.is_file()
    assert hashlib.sha256(local.DEFAULT_XSD.read_bytes()).hexdigest() == OFFICIAL_XSD_SHA256
def test_render_control_lineage_digest_matches_simcloud_contract() -> None:
    intent = {
        "executionPackage": {
            "id": "usepkg_1",
            "sourceInputDigest": "b" * 64,
        },
    }

    assert local._render_control_lineage_sha256(intent, "a" * 64) == (
        "778a97137de36a25e2fc215804ef86da8518dd282ed99a581ebdb88625ecb30c"
    )




def test_probe_is_read_only_and_always_cleans_up(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    class Client:
        def get_server_version(self) -> str:
            calls.append("server-version")
            return "0.10.0-test"

        def get_world(self) -> object:
            calls.append("world")
            return object()

    class Backend:
        carla = type("Carla", (), {"__version__": "0.10.0-client"})()
        client = Client()

        def __init__(self, host: str, port: int) -> None:
            calls.append((host, port))

        def cleanup(self) -> None:
            calls.append("cleanup")

    monkeypatch.setattr(local, "CarlaBackend", Backend)
    assert local._probe("carla.test", 2000) == {
        "schema": "uniscenarios.carla-probe/v2",
        "clientVersion": "0.10.0-client",
        "serverVersion": "0.10.0-test",
        "maxSimultaneousSensors": 64,
        "nativeSensors": local.native_sensor_capabilities(),
        "runtimeImage": {
            "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
            "indexDigest": local.CARLA_IMAGE_INDEX_DIGEST,
            "linuxAmd64ManifestDigest": local.CARLA_IMAGE_AMD64_MANIFEST_DIGEST,
        },
        "prontoSensorHost": {
            "catalogId": local.KIA_CARNIVAL_CATALOG_ID,
            "blueprintId": local.KIA_CARNIVAL_BLUEPRINT_ID,
            "classPath": local.KIA_CARNIVAL_CLASS_PATH,
            "make": local.KIA_CARNIVAL_MAKE,
            "model": local.KIA_CARNIVAL_MODEL,
            "baseType": local.KIA_CARNIVAL_BASE_TYPE,
        },
    }
    assert calls == [("carla.test", 2000), "world", "server-version", "cleanup"]


def test_probe_cleans_up_when_server_version_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    cleaned: list[bool] = []

    class Backend:
        carla = object()
        client = type("Client", (), {
            "get_world": lambda _self: object(),
            "get_server_version": lambda _self: (_ for _ in ()).throw(RuntimeError("offline")),
        })()
        def __init__(self, _host: str, _port: int) -> None:
            pass

        def cleanup(self) -> None:
            cleaned.append(True)

    monkeypatch.setattr(local, "CarlaBackend", Backend)
    with pytest.raises(RuntimeError, match="offline"):
        local._probe("carla.test", 2000)
    assert cleaned == [True]


def test_review_sensor_selection_is_explicit_and_minimal() -> None:
    sensors = [
        SimpleNamespace(sensor_id="camera-front", modality="rgb", actor_id="ego"),
        SimpleNamespace(sensor_id="lidar-front", modality="lidar", actor_id="ego"),
        SimpleNamespace(sensor_id="radar-front", modality="radar", actor_id="ego"),
    ]

    local._validate_pronto_sensor_selection(sensors, "ego", representative=True)
    with pytest.raises(local.ContractError, match="all exact Pronto sensors"):
        local._validate_pronto_sensor_selection(sensors, "ego", representative=False)


def test_authored_sensor_host_accepts_exact_selected_rig() -> None:
    sensors = [
        *[
            SimpleNamespace(sensor_id=f"camera-{index}", modality="rgb", actor_id="ego")
            for index in range(8)
        ],
        SimpleNamespace(sensor_id="lidar-roof", modality="lidar", actor_id="ego"),
    ]

    local._validate_authored_sensor_host(
        sensors,
        "ego",
        {"catalogAssetId": "vehicle.generic.sedan"},
        {"rigId": "authored", "cameras": 8, "lidars": 1, "radars": 0},
    )


def test_authored_sensor_host_rejects_cross_actor_sources() -> None:
    sensors = [
        SimpleNamespace(sensor_id="camera-front", modality="rgb", actor_id="ego"),
        SimpleNamespace(sensor_id="camera-rear", modality="rgb", actor_id="other"),
    ]

    with pytest.raises(local.ContractError, match="counts and actor"):
        local._validate_authored_sensor_host(
            sensors,
            "ego",
            {"catalogAssetId": "vehicle.generic.sedan"},
            {"rigId": "authored", "cameras": 2, "lidars": 0, "radars": 0},
        )




def test_artifact_manifest_accepts_sensor_data() -> None:
    entries = local._artifact_manifest_entries([{
        "kind": "sensorData:ego:lidar-front:lidar",
        "artifactUrl": "sensor-data.zip",
        "sha256": "a" * 64,
        "sizeBytes": 42,
        "mediaType": "application/zip",
        "metadata": {
            "actorId": "ego",
            "sensorId": "lidar-front",
            "modality": "lidar",
        },
    }])

    assert entries == [{
        "identity": {
            "role": "sensorArchive",
            "actorId": "ego",
            "sensorId": "lidar-front",
            "modality": "lidar",
        },
        "relativePath": "sensor-data.zip",
        "sha256": "a" * 64,
        "sizeBytes": 42,
        "mediaType": "application/zip",
        "frameCount": None,
    }]
