# UniScenarios CARLA bridge

`uniscenarios-carla-bridge` is the public CARLA renderer and sensor adapter
owned by UniScenarios. It consumes `uniscenario.render-intent/v1` plus a
hash-closed local input package; the managed worker retains only leases,
fencing, authorization, and transfer. The package owns OpenSCENARIO 1.4
compilation, deterministic native execution, RGB/depth/semantic/instance/
normals cameras, LiDAR, semantic LiDAR, radar, materialized traffic, parity
evidence, bounded artifact transport, and the official schema validator.

CARLA is optional. The browser editor, local deterministic simulation,
OpenDRIVE tooling, OpenSCENARIO export, and playback do not import CARLA or
require a CARLA server.

## Install

From this repository:

```sh
python3 -m pip install ./adapters/carla-exec
```

Install the Python client distributed with the exact CARLA server build you
intend to use. The bridge deliberately does not declare `carla` as a package
dependency because the client/server build pair is part of execution
provenance, not a floating package resolution.

The validator also requires `xmllint` on `PATH`. The pinned official ASAM
OpenSCENARIO XML 1.4 schema is bundled in the wheel and its SHA-256 is checked
before every validation.

## Use locally

Start CARLA, then verify the client/server connection without mutating its
world:

```sh
uniscenarios-carla --host 127.0.0.1 --port 2000 probe
```

The unified Node CLI dispatches `--engine carla` to this installed process
adapter:

```sh
uniscenarios-carla --host 127.0.0.1 --port 2000 run-intent \
  --intent render-intent.json \
  --package input-package.json \
  --output output/carla \
  --progress output/carla-progress.jsonl \
  --manifest output/render-artifact-manifest.json
```

`run-intent` accepts strict render-spec/v3 sources, verifies `intentSha256` and
every local input before CARLA starts, writes `uniscenario.render-progress/v1`
JSONL, and closes with `uniscenario.render-artifact-manifest/v1`.

Set `UNISCENARIO_CARLA_COOKED_MAPS_JSON` to a JSON map of cooked map names to
their source XODR SHA-256 values; a digest or loaded-world identity mismatch is
fatal. `UNISCENARIO_CARLA_SIGNAL_ID_MAP` supplies an explicit one-to-one authored
to cooked OpenDRIVE signal-id map. `UNISCENARIO_SENSOR_WRITER_WORKERS` bounds
parallel streaming writers. Set `UNISCENARIO_PRESENTATION_VIDEO_ENCODER=nvidia`
to request `h264_nvenc`; PNG/PLY/CSV sensor frames remain the canonical output.

Managed Pronto execution derives from
`ghcr.io/simforgeinc/carla-rfs-munich-belmont@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64`
(OCI index `sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5`).
All 18 sensors must attach to one host actor whose catalog asset and CARLA
blueprint are both exactly `vehicle.kia.carnival`. The packaged evidence is
`CarlaUnreal/Content/Carla/Config/VehicleParameters.json`: Make `Kia`, Model
`Carnival`, BaseType `van`, class
`/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C`.
The runtime rejects mismatched intent identity, catalog binding, spawned actor
type-id, sensor parent readback, or image-manifest provenance.

## Develop and verify

```sh
python3 -m pip install -e './adapters/carla-exec[dev]'
python3 -m pytest adapters/carla-exec/tests -q
```

The test corpus uses fake CARLA APIs, so it exercises the compiler, runtime,
failure handling, security boundaries, and deterministic evidence without a
GPU server. A real CARLA qualification remains a separate hardware acceptance
gate.

See `docs/carla-renderer-adapter.md` for the ownership boundary, capability
matrix, and real-runtime acceptance criteria.
