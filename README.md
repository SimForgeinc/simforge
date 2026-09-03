


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

For a production deployment build the packages and Studio once, then serve the
build (migrations and seed run on every start, as in development):

```sh
pnpm -r --filter './packages/**' build
pnpm --filter @simforge-oss/studio build
PORT=5199 HOSTNAME=127.0.0.1 pnpm --filter @simforge-oss/studio start
```

`NEXT_PUBLIC_*` variables are inlined at build time, so export them before
`build`, not only before `start`.

On first boot, Studio generates a compact Starter Road from checked-in source
assets when the optional full development map library is not installed. No
separate map download or environment variable is required for the quickstart.
Set `SCEN_DEV_ASSETS` to a full map-bundle directory when you want the larger
local catalog; Studio continues to use the starter map if that directory is
unavailable.

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

## Architecture

The TypeScript workspace has 13 public packages organized as eight systems.
Every package is released at the same stack version.

| System | Package | Responsibility |
|---|---|---|
| Scenario | [`@simforge-oss/scenario`](packages/scenario) | Versioned, framework-free portable scenario documents and schemas. |
| Engine | [`@simforge-oss/engine`](packages/engine) | Fixed-step simulation, deterministic traces, and the `scene-state.v1` serializer exposed at `/scene-state`. |
| World | [`@simforge-oss/maps`](packages/maps) | OpenDRIVE parsing, georeferencing, lane and signal topology, and scenario-independent map intelligence; parsing is also exposed at `/opendrive`. |
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
