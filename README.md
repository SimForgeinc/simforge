


# SimForge
<img width="914" height="170" alt="Screenshot 2026-08-24 at 11 09 40 PM" src="https://github.com/user-attachments/assets/4982be0b-7d7b-45ec-9310-da9c8ace9c5f" />

SimForge is an open-source ML training environment for autonomous systems and a
CARLA competitor. It provides deterministic scenario authoring, simulation,
replay, rendering, dataset generation, and evaluation in one repository.

The central contract is simple: **editor == sim == replay**. SimForge Studio,
headless runs, and recorded playback execute the same fixed-step engine and the
same scenario document. A scenario does not acquire a second implementation
when it leaves the editor.

## Components

| Component | Responsibility |
|---|---|
| **SimForge Engine** | Deterministic fixed-step simulation, scenario execution, traces, and portable scene-state output. |
| **SimForge Renderer** | Native Rust/Bevy rendering for sensor-grade frames and datasets, with web rendering available through the same render-job contract. |
| **SimForge Studio** | The local product app for editing scenarios, maps, assets, playback, datasets, and renders. |
| **SimForge Cloud** | The hosted product, consuming the same immutable SimForge package stack and frozen wire contracts. |

## Quickstart

Requires Node.js and pnpm.

```sh
pnpm install
pnpm dev
```

SimForge Studio is then available at <http://localhost:5199>.

On first boot, Studio discovers complete map installations from the common
`${SIMFORGE_MAPS_CACHE_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/maps}`
cache populated by `simforge maps pull`. A registry map is published only when
its semantic, web, and native profiles carry matching verified release receipts.
When no complete installation exists, Studio generates the compact Starter Road
from checked-in source assets.

The CLI binary is `simforge`; `sf` is its short alias:

```sh
# Inspect available maps.
simforge maps list

# Run a scenario headlessly through the deterministic engine.
simforge run path/to/scenario.json

# Produce artifacts with either render engine.
simforge render run --engine native path/to/render-job.json
simforge render run --engine web path/to/render-job.json

# Launch Studio explicitly.
sf studio
```

CLI output is machine-readable by default, so the same commands can be used in
local workflows, CI, and unattended dataset generation.

## Map releases

`richmond-field-station` is the only public map. Other exported maps remain in
the authenticated private registry.

```sh
simforge maps list
simforge maps pull richmond-field-station
```

Each immutable release binds the native `master.gltf` resource closure and its
browser tier. Pulling reconstructs their external geometry, KTX2 textures,
decoder runtime, OpenDRIVE, lane topology, signal records, and derived locations.
Source rasters are archival and are not transferred to render workers.
Studio also provisions its installed Three Basis JS/WASM pair at `/basis/`
before starting. Other embedders must serve the matching runtime pair or
explicitly configure `ktx2TranscoderPath`.

The Linux/A100 source builder requires `flock`, KTX-Software and a durable work
directory. An optional `map-source.json` (`simforge.map-source.v1`) selects
`name`, `glb`, `xodr`, `sky`, and `donorMasters` explicitly. Ambiguous GLB/XODR
directories are rejected.

```sh
simforge maps ingest /path/to/export --name richmond-field-station \
  --work-dir /persistent/map-builds --registry s3://simforge-maps-internal \
  --target private
```

Scene, semantic, and browser caches are independent. A semantic-only change
does not re-encode the scene. `--reuse-master /path/to/master/content` can seed
the scene cache from an explicitly selected, source-matching master.
Roadway failures and unavailable visual/runtime evidence remain explicit in
the release; publication never converts missing evidence into a pass.
Static collision derivatives are built from the canonical master placements,
not the instanced browser meshes. Their separately cached runtime closure binds
the exact browser manifest and topology without re-encoding render cells.

## Architecture

The TypeScript workspace has 15 public packages organized as eight systems.
Every package is released at the same stack version.

| System | Package | Responsibility |
|---|---|---|
| Scenario | [`@simforge-oss/scenario`](packages/scenario) | Versioned, framework-free portable scenario documents and schemas. |
| Engine | [`@simforge-oss/engine`](packages/engine) | Fixed-step simulation, deterministic traces, and the `scene-state.v1` serializer exposed at `/scene-state`. |
| World | [`@simforge-oss/maps`](packages/maps) | OpenDRIVE parsing, georeferencing, lane and signal topology, and scenario-independent map intelligence; parsing is also exposed at `/opendrive`. |
| World | [`@simforge-oss/map-pipeline`](packages/map-pipeline) | Deterministic master, semantic and browser-tier generation from explicit map sources. |
| World | [`@simforge-oss/map-registry`](packages/map-registry) | Immutable map releases, content-addressed resources, resumable publication and verified pulls. |
| World | [`@simforge-oss/compiler`](packages/compiler) | Loads maps and templates, matches logical anchors, selects sites, and materializes concrete simulatable worlds. |
| Studio runtime | [`@simforge-oss/viewer`](packages/viewer) | Streaming three.js viewport, camera rigs, and framework-neutral actor presentation. |
| Studio runtime | [`@simforge-oss/editor`](packages/editor) | Authoring documents, editing interactions, validation, and editor state. |
| Studio runtime | [`@simforge-oss/playback`](packages/playback) | Deterministic trace playback, timing, and ambient traffic through `/traffic`. |
| Studio runtime | [`@simforge-oss/asset-catalog`](packages/asset-catalog) | Canonical parametric vehicles, pedestrians, props, and generated catalog assets. |
| Rendering | [`@simforge-oss/render`](packages/render) | Render-job contracts plus lazy web and native engines exposed at `/web` and `/native`. |
| Interop | [`@simforge-oss/openscenario`](packages/openscenario) | ASAM OpenSCENARIO import/export, esmini execution via `/esmini`, and conformance comparison via `/trace-diff`. |
| Training & evaluation | [`@simforge-oss/training-env`](packages/training-env) | Gymnasium-semantics environment and causal ground-truth channel without a CLI dependency. |
| Training & evaluation | [`@simforge-oss/evaluation`](packages/evaluation) | Frozen policy-evaluation protocols and the scenario-faithfulness examiner. |
| CLI | [`@simforge-oss/cli`](packages/cli) | `simforge`/`sf` orchestration and the stack-level integration surface. |

The other product boundaries are intentionally not npm packages:

- [`renderer/`](renderer) is the SimForge Renderer Rust workspace.
- [`studio/`](studio) is SimForge Studio, the local Next.js product.
- [`adapters/gym`](adapters/gym) is the Python Gymnasium client.
- [`qualification/`](qualification) contains release and determinism gates;
  [`research/`](research) contains experiments that do not ship as product code.

## CARLA compatibility

SimForge supports both directions of CARLA interoperability without conflating
them:

- [`adapters/carla-api`](adapters/carla-api) provides a drop-in Python
  `import carla` facade over SimForge Engine. Existing CARLA-facing tools can
  target SimForge without starting a CARLA server.
- [`adapters/carla-exec`](adapters/carla-exec) runs SimForge scenarios in a
  real, pinned CARLA runtime when CARLA execution is the required reference.

OpenDRIVE and OpenSCENARIO remain explicit interchange boundaries. Compatibility
reports distinguish exact control-stream behavior from behavior approximated by
a third-party runtime.

## Receipts

Claims are tied to checked-in contracts and measurements:

- **Determinism CI:** the native golden gate records renderer, corpus, hardware,
  and artifact hashes and compares them per GPU fingerprint. See
  [`docs/engineering/native-golden-ci.md`](docs/engineering/native-golden-ci.md)
  and the scoped claim in
  [`docs/engineering/determinism-claim.md`](docs/engineering/determinism-claim.md).
- **18-sensor suite:** the native renderer qualification covers the camera,
  LiDAR, radar, IMU, and GNSS surface; the recorded suite produced 46/46
  hash-identical checks. See the historical program record in
  [`docs/context/program-history-2026-08.md`](docs/context/program-history-2026-08.md)
  and the renderer plan in
  [`docs/engineering/native-renderer-production-plan.md`](docs/engineering/native-renderer-production-plan.md).
- **Byte-compatible V2X:** the V2X port preserves the deployed WebSocket
  protocol while replacing the CARLA backend, with explicit coordinate and map
  digest contracts. See
  [`docs/engineering/v2x-port-plan.md`](docs/engineering/v2x-port-plan.md) and
  [`docs/engineering/v2x-coordinate-contract.md`](docs/engineering/v2x-coordinate-contract.md).

## Documentation

- [`docs/product/`](docs/product/) — Studio behavior and product workflows
- [`docs/engineering/`](docs/engineering/) — architecture, contracts,
  qualification, release, and migration records
- [`docs/research/`](docs/research/) — research plans, surveys, and decisions
- [`docs/context/`](docs/context/) — project overview and program history

SimForge is licensed under Apache-2.0.
