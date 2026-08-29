# SimForge: Project Overview

Last updated: 2026-08-23. The SimForge rebrand and 24→13 package consolidation
are the current repository layout.

## What it is

SimForge is an open-source scenario simulation and ML training platform for
Physical AI. It is designed as a CARLA competitor with explicit CARLA
compatibility in both directions. Its portable deterministic core includes:

- **Scenario documents** (`packages/scenario`): versioned templates, concrete
  instances, schemas, hashing, and storage-neutral types.
- **Simulation** (`packages/engine`): fixed-step actors, routes, triggers,
  interactions, physics, traces, and the frozen `scene-state.v1` output. The
  determinism boundary is editor == sim == replay.
- **World compilation** (`packages/maps`, `packages/compiler`): OpenDRIVE map
  intelligence, logical anchor matching, site selection, and deterministic
  scenario materialization.
- **Studio runtime** (`packages/editor`, `packages/viewer`,
  `packages/playback`, `packages/asset-catalog`): framework-neutral authoring,
  a streaming three.js viewport, replay and traffic, and canonical assets.
- **Rendering** (`packages/render`, `renderer/`): one render-job contract with
  web and native adapters; the Rust/Bevy SimForge Renderer provides sensor and
  cinematic profiles and the 18-sensor suite.
- **Interchange** (`packages/openscenario`): ASAM OpenSCENARIO import/export,
  esmini conformance execution, and trace comparison.
- **Training and evaluation** (`packages/training-env`,
  `packages/evaluation`): Gymnasium-semantics execution, causal ground truth,
  frozen policy evaluation, and scenario-faithfulness examination.
- **Automation** (`packages/cli`): the `simforge` binary and `sf` alias.

All 15 TypeScript packages use the `@simforge-oss/*` scope and lockstep
`0.1.0-rc.51` version.

## Products and compatibility

**SimForge Studio** is the local Next.js product in `studio/`. Root `pnpm dev`
runs it on <http://127.0.0.1:5199>. It is a byte-faithful copy of SimForge
Cloud's product surface except for workspace dependency specifiers and its
explicit local infrastructure seams. Product behavior must not fork between
Studio and Cloud.

**SimForge Cloud** is the hosted product. Portable behavior is authored here,
released as one immutable stack, and mechanically synchronized into Cloud. The
legacy `uniscenario.*` database schemas, `/api/uniscenario/**` routes, scenario
format identifiers, `scene-state.v1`, and worker environment variables are
frozen wire contracts, not public branding.

CARLA interoperability remains two separate adapters:

- `adapters/carla-api`: drop-in Python `import carla` over SimForge Engine.
- `adapters/carla-exec`: execute SimForge scenarios in a real CARLA runtime.

## Repository layout

- `packages/` — the 13-package `@simforge-oss/*` TypeScript stack.
- `studio/` — SimForge Studio, the local product and default launch surface.
- `renderer/` — SimForge Renderer Rust workspace.
- `adapters/` — Gymnasium, CARLA API, and CARLA execution boundaries.
- `qualification/` — deterministic release gates, golden harnesses, and frozen
  evaluation assets.
- `research/` — experimental lanes that do not ship as product code.
- `catalog/`, `campaigns/`, `fixtures/`, `dev-assets/`, `examples/`,
  `services/`, `config/` — product data, evidence, services, and stack config.
- `docs/product`, `docs/engineering`, `docs/research`, `docs/context` — product,
  architecture, research, and historical context documentation.

## Verification culture

Claims require receipts. Symbolic traces and evidence identities are
byte-exact; native renderer goldens are keyed to an explicit GPU fingerprint;
Chrome RGB is not claimed cross-machine byte-exact. The 18-sensor native suite,
OpenSCENARIO conformance matrix, physics provenance, and byte-compatible V2X
contracts are maintained as explicit qualification artifacts. See
[determinism-claim.md](../engineering/determinism-claim.md),
[native-golden-ci.md](../engineering/native-golden-ci.md), and
[simcloud-convergence.md](../engineering/simcloud-convergence.md).
