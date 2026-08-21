from __future__ import annotations

import hashlib

import pytest

from uniscenarios_carla_bridge import local
from uniscenarios_carla_bridge.runtime.contract import OFFICIAL_XSD_SHA256


def test_default_schema_is_bundled_and_digest_pinned() -> None:
    assert local.DEFAULT_XSD.is_file()
    assert hashlib.sha256(local.DEFAULT_XSD.read_bytes()).hexdigest() == OFFICIAL_XSD_SHA256


def test_run_intent_writes_the_final_manifest_without_legacy_progress_events(
    monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    intent_path = tmp_path / "intent.json"
    package_path = tmp_path / "package.json"
    output_path = tmp_path / "output"
    progress_path = tmp_path / "progress.jsonl"
    manifest_path = tmp_path / "manifest.json"
    intent_path.write_text('{"intentId":"intent-1","sensorHost":{}}')
    package_path.write_text("{}")
    monkeypatch.setattr(local, "_read_input_package", lambda _package, _intent: ("a" * 64, {}))
    monkeypatch.setattr(local, "_intent_lease", lambda *_args: (object(), {}))
    monkeypatch.setattr(
        local,
        "_execute_local_lease",
        lambda *_args: {
            "artifacts": [],
            "attestation": {
                "runtimeEvidence": {"prontoSensorHost": {}, "runtimeImage": {}},
            },
            "parityEvidence": {},
            "planSha256": "b" * 64,
        },
    )
    args = local.argparse.Namespace(
        intent=str(intent_path),
        package=str(package_path),
        output=str(output_path),
        progress=str(progress_path),
        manifest=str(manifest_path),
        host="127.0.0.1",
        port=2000,
    )

    result = local._run_intent(args)

    assert result["schema"] == "uniscenario.render-artifact-manifest/v1"
    assert manifest_path.is_file()
    assert progress_path.read_text() == ""


def test_probe_is_read_only_and_always_cleans_up(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    class Client:
        def get_server_version(self) -> str:
            calls.append("server-version")
            return "0.10.0-test"

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
    assert calls == [("carla.test", 2000), "server-version", "cleanup"]


def test_probe_cleans_up_when_server_version_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    cleaned: list[bool] = []

    class Backend:
        carla = object()
        client = type("Client", (), {"get_server_version": lambda _self: (_ for _ in ()).throw(RuntimeError("offline"))})()

        def __init__(self, _host: str, _port: int) -> None:
            pass

        def cleanup(self) -> None:
            cleaned.append(True)

    monkeypatch.setattr(local, "CarlaBackend", Backend)
    with pytest.raises(RuntimeError, match="offline"):
        local._probe("carla.test", 2000)
    assert cleaned == [True]


def test_runtime_map_name_uses_exact_deployment_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "UNISCENARIO_CARLA_COOKED_MAPS_JSON",
        '{"el-camino-road_20260416-014537":"El_Camino_Rd_Palo_Alto_CA"}',
    )
    assert local._runtime_map_name("el-camino-road_20260416-014537") == "El_Camino_Rd_Palo_Alto_CA"
    with pytest.raises(local.ContractError, match="no approved cooked CARLA map"):
        local._runtime_map_name("unknown-map")


def test_runtime_map_name_rejects_invalid_deployment_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNISCENARIO_CARLA_COOKED_MAPS_JSON", "[]")
    with pytest.raises(local.ContractError, match="must map non-empty strings"):
        local._runtime_map_name("el-camino-road_20260416-014537")
