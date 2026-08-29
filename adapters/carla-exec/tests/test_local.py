from __future__ import annotations

import hashlib
import json

from types import SimpleNamespace
import pytest

from simforge_oss_carla_exec import local
from simforge_oss_carla_exec.runtime.contract import OFFICIAL_XSD_SHA256


def test_default_schema_is_bundled_and_digest_pinned() -> None:
    assert local.DEFAULT_XSD.is_file()
    assert hashlib.sha256(local.DEFAULT_XSD.read_bytes()).hexdigest() == OFFICIAL_XSD_SHA256

def test_render_intent_digest_sorts_per_source_arrays_like_typescript(tmp_path) -> None:
    intent = {
        "schema": "simforge.render-intent/v1",
        "sensorHosts": [
            {"sourceId": "z-source", "actorId": "actor-z"},
            {"sourceId": "a-source", "actorId": "actor-a"},
        ],
        "renderSpec": {
            "sources": [
                {"outputName": "z-source", "actorId": "actor-z"},
                {"outputName": "a-source", "actorId": "actor-a"},
            ],
        },
    }
    sorted_intent = {
        **intent,
        "sensorHosts": list(reversed(intent["sensorHosts"])),
        "renderSpec": {"sources": list(reversed(intent["renderSpec"]["sources"]))},
    }
    expected = hashlib.sha256(
        local._canonical_render_intent_json(sorted_intent).encode("utf-8")
    ).hexdigest()
    input_path = tmp_path / "input"
    input_path.write_bytes(b"x")
    package_path = tmp_path / "input-package.json"
    control_digest = "b" * 64
    package_path.write_text(json.dumps({
        "intentSha256": expected,
        "executionPackageControlSha256": control_digest,
        "inputs": [{
            "inputId": "scenario.xosc",
            "path": "input",
            "sha256": hashlib.sha256(b"x").hexdigest(),
            "sizeBytes": 1,
        }],
    }), "utf-8")

    digest, package_control_digest, _inputs = local._read_input_package(package_path, intent)
    assert digest == expected
    assert package_control_digest == control_digest


def test_input_package_requires_claimed_execution_package_control_digest(tmp_path) -> None:
    intent = {"schema": "simforge.render-intent/v1"}
    intent_sha = hashlib.sha256(
        local._canonical_render_intent_json(intent).encode("utf-8")
    ).hexdigest()
    package_path = tmp_path / "input-package.json"
    package_path.write_text(json.dumps({
        "intentSha256": intent_sha,
        "inputs": [],
    }), "utf-8")

    with pytest.raises(
        local.ContractError,
        match="exactly intentSha256, executionPackageControlSha256, and inputs",
    ):
        local._read_input_package(package_path, intent)



def test_run_intent_records_named_preflight_failure_before_exit(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    intent_path = tmp_path / "intent.json"
    intent_path.write_text(json.dumps({"intentId": "intent-1"}), "utf-8")
    progress_path = tmp_path / "progress.jsonl"
    monkeypatch.setattr(
        local,
        "_read_input_package",
        lambda _package_path, _intent: ("a" * 64, "b" * 64, {}),
    )
    monkeypatch.setattr(
        local,
        "_intent_lease",
        lambda _intent, _sha, _control_sha, _inputs, _output: (object(), {}),
    )

    def fail(*_args, **_kwargs):
        raise local.ContractError("vehicle actor has no same-class native CARLA fallback")

    monkeypatch.setattr(local, "_execute_local_lease", fail)
    args = SimpleNamespace(
        intent=str(intent_path),
        package=str(tmp_path / "package.json"),
        output=str(tmp_path / "output"),
        progress=str(progress_path),
        manifest=str(tmp_path / "manifest.json"),
        host="127.0.0.1",
        port=2000,
    )

    with pytest.raises(local.ContractError, match="same-class native"):
        local._run_intent(args)

    records = [json.loads(line) for line in progress_path.read_text("utf-8").splitlines()]
    assert [record["event"] for record in records] == [
        "job.started",
        "stage.started",
        "warning",
    ]
    assert records[1]["stage"] == "preparing"
    assert records[2] == {
        **{key: records[2][key] for key in ("schema", "jobId", "attempt", "sequence", "timestamp")},
        "event": "warning",
        "code": "carla.execution_failed",
        "message": "vehicle actor has no same-class native CARLA fallback",
    }




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
        "schema": "simforge.carla-probe/v2",
        "clientVersion": "0.10.0-client",
        "serverVersion": "0.10.0-test",
        "maxSimultaneousSensors": 64,
        "nativeSensors": local.native_sensor_capabilities(),
        "runtimeImage": {
            "repository": "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
            "indexDigest": local.CARLA_IMAGE_INDEX_DIGEST,
            "linuxAmd64ManifestDigest": local.CARLA_IMAGE_AMD64_MANIFEST_DIGEST,
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


def _tick_probe_world(leak_every: int):
    """A fake CARLA world whose engine sneaks in an extra tick every N commanded ones."""
    class Timestamp:
        def __init__(self, elapsed): self.elapsed_seconds = elapsed
    class Snapshot:
        def __init__(self, elapsed): self.timestamp = Timestamp(elapsed)
    class Blueprint:
        id = "vehicle.kia.carnival"
    class Library:
        def find(self, blueprint_id): return Blueprint()
        def filter(self, pattern): return [Blueprint()]
    class Location:
        z = 0.0
    class SpawnPoint:
        location = Location()
    class Map:
        def get_spawn_points(self): return [SpawnPoint()]
    class Vehicle:
        def destroy(self): return True
    class Settings:
        synchronous_mode = False
        fixed_delta_seconds = None
    class World:
        def __init__(self):
            self.frame = 1000
            self.commanded = 0
            self.settings_history = []
        def get_settings(self): return Settings()
        def apply_settings(self, settings): self.settings_history.append(settings)
        def get_blueprint_library(self): return Library()
        def get_map(self): return Map()
        def try_spawn_actor(self, blueprint, transform): return Vehicle()
        def get_snapshot(self): return Snapshot(self.frame * 0.02)
        def tick(self):
            self.commanded += 1
            self.frame += 1
            if leak_every and self.commanded % leak_every == 0:
                self.frame += 1  # the engine ticked itself
            return self.frame
    return World()


@pytest.mark.parametrize("leak_every, verdict", [(0, "pass"), (2, "fail")])
def test_tick_barrier_probe_detects_un_commanded_engine_ticks(
    monkeypatch: pytest.MonkeyPatch, leak_every: int, verdict: str,
) -> None:
    world = _tick_probe_world(leak_every)

    class Backend:
        carla = object()
        client = type("Client", (), {
            "get_world": lambda _self: world,
            "get_server_version": lambda _self: "0.10.0-test",
        })()
        def __init__(self, _host: str, _port: int) -> None:
            pass
        def cleanup(self) -> None:
            pass

    monkeypatch.setattr(local, "CarlaBackend", Backend)
    result = local._probe_tick_barrier("carla.test", 2000, 0.02, 40)
    assert result["schema"] == "simforge.carla-tick-barrier-probe/v1"
    assert result["verdict"] == verdict
    if verdict == "fail":
        assert result["populatedWorld"]["unCommandedTicks"] > 0
        assert result["populatedWorld"]["simTimeRatio"] > 1.2
    else:
        assert result["populatedWorld"]["unCommandedTicks"] == 0
        assert result["emptyWorld"]["unCommandedTicks"] == 0
    # The probe restores the server's prior settings after itself.
    assert world.settings_history[-1].synchronous_mode is False


def test_sedan_sensor_host_accepts_full_pronto_rig_without_kia_identity() -> None:
    sensors = [
        *[
            SimpleNamespace(role=f"camera-{index}", sensor_id=f"camera-{index}", modality="rgb", actor_id="ego")
            for index in range(8)
        ],
        *[
            SimpleNamespace(role=f"lidar-{index}", sensor_id=f"lidar-{index}", modality="lidar", actor_id="ego")
            for index in range(6)
        ],
        *[
            SimpleNamespace(role=f"radar-{index}", sensor_id=f"radar-{index}", modality="radar", actor_id="ego")
            for index in range(4)
        ],
    ]
    hosts = sorted(
        (
            {
                "sourceId": sensor.role,
                "actorId": sensor.actor_id,
                "vehicleAsset": {"catalogAssetId": "vehicle.sedan"},
            }
            for sensor in sensors
        ),
        key=lambda item: item["sourceId"],
    )

    local._validate_sensor_hosts(sensors, hosts)

def test_sensor_hosts_cover_trailing_chase_camera_as_its_own_source() -> None:
    sensors = [
        SimpleNamespace(role="front", sensor_id="camera-front", modality="rgb", actor_id="ego"),
        SimpleNamespace(
            role="chase",
            sensor_id=local.PRONTO_CHASE_CAMERA_SENSOR_ID,
            modality="rgb",
            actor_id="ego",
        ),
    ]
    hosts = [
        {"sourceId": "chase", "actorId": "ego", "vehicleAsset": {"catalogAssetId": "vehicle.sedan"}},
        {"sourceId": "front", "actorId": "ego", "vehicleAsset": {"catalogAssetId": "vehicle.sedan"}},
    ]

    local._validate_sensor_hosts(sensors, hosts)



def test_sensor_hosts_accept_sources_on_multiple_actors() -> None:
    sensors = [
        SimpleNamespace(role="front", sensor_id="camera-front", modality="rgb", actor_id="ego"),
        SimpleNamespace(role="rear", sensor_id="camera-rear", modality="rgb", actor_id="other"),
    ]
    hosts = [
        {"sourceId": "front", "actorId": "ego", "vehicleAsset": {"catalogAssetId": "vehicle.sedan"}},
        {"sourceId": "rear", "actorId": "other", "vehicleAsset": {"catalogAssetId": "vehicle.van"}},
    ]

    local._validate_sensor_hosts(sensors, hosts)




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
