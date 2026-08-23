# UniScenarios: Project Overview

Last updated: 2026-08-23.

## What it is

UniScenarios is a scenario platform for Physical AI / autonomous-vehicle
simulation. It owns the portable, deterministic core:

- **Scenario model** (`packages/scenario-model`): versioned scenario documents
  (ScenarioTemplateV2), drafts/revisions, content hashing, storage adapters.
- **Simulation engine** (`packages/sim-engine`): fixed-step deterministic
  simulation — actors, routes, triggers, interactions, physics, traces. The
  determinism moat: editor == simulation == replay, byte-for-byte.
- **Editor runtime** (`packages/editor-core` + `packages/city-renderer`):
  EditorDocument/EditorController over a persistent three.js CityViewer that
  streams real city map tiles (GLB + baked lightmaps) with lane-snapping from
  topology indexes.
- **Map pipeline**: OpenDRIVE (XODR) ingestion, topology/lane-polygon/signal
  derivation, SUMO network derivation, collision derivatives, publication into
  immutable map versions (`dev-assets/<map>/` holds five real maps:
  yale-street, belmont-research-center, el-camino-road,
  easterbrook-discovery-school, richmond-field-station).
- **Interchange**: OpenSCENARIO 1.4 import/export with XSD validation
  (`packages/openscenario`), CARLA compatibility facade (`import carla`
  Python shim over the native stack).
- **Renderers**:
  - Browser: `packages/browser-renderer` / city-renderer (three.js), used for
    in-editor preview, playback, and browser render jobs (recording → mp4).
  - Native: `native/` Bevy (Rust) renderer behind the same render-runtime
    contract (`render run --engine native`) with two profiles — `sensor`
    (linear, fixed exposure, hash-stable output; 18-sensor suite incl.
    lidar/radar/IMU/GNSS) and `cinematic` (AgX, bloom, realism ladder). Byte
    determinism is CI-gated per GPU fingerprint (golden-hash CI).
- **Adapters**: `adapters/uniscenarios-gym` (RL environment boundary — Python
  stays at the gym/adapter seam, the core stays TypeScript), SUMO ambient
  traffic, V2X digital-twin bridge (WS :8765 byte-compatible protocol),
  esmini/CARLA execution adapters.

## Relationship to SimCloud / SimForge

SimForge (design system: "Mission Console" — telemetry amber #E8E044 on
near-black, zero radius, Share Tech Mono labels) is the brand; SimCloud
(`/home/path/simcloud-platform`) is the commercial cloud product: Next.js
dashboard + scenario editor + datasets + maps + assets + render fleet, backed
by Aurora Postgres, S3, and GPU workers. SimCloud vendors immutable
UniScenarios releases (npm tarball stack + CARLA wheel) and builds its own
presentation layer over the vendored engine — it intentionally does NOT use
`@uniscenarios/editor-ui`.

Dependency direction is one-way (UniScenarios → release → SimCloud), per
`docs/simcloud-convergence.md`. As of 2026-08-23 there is one deliberate,
scoped exception: **`apps/cloud`** is a 1:1 copy of SimCloud's product surface
living in this repo so the full product runs locally (see below). It is kept
byte-faithful to SimCloud source except at three local seams; it must not
become a fork that grows its own product behavior.

## The local product: `apps/cloud`

Running UniScenarios locally launches the SimCloud product itself:

- `pnpm dev` (root) → `apps/cloud` boot: migrate → seed → Next.js dev on
  **http://127.0.0.1:5199**. `pnpm run dev:worker` also starts the local
  render/compile worker (`UNISCENARIOS_LOCAL_WORKER=1` / `--with-worker`).
- Same UI as production SimCloud: app switcher (Maps / Assets / Datasets;
  Exports disabled "In development"), shared top bar (the editor has no top
  bar of its own — it portals actions into the app chrome), datasets
  workspace, full scenario editor (actor rail with Car / Two-wheelers /
  Pedestrian / robots / Animals / Object / Asset gallery / Weather / Traffic /
  Parked cars; floating timeline dock; right inspector with
  appearance/placement/sensors; simple vs advanced experience chooser;
  first-run graphics page at `/dashboard/render-settings`).
- **Local seams** (the only intentional divergences from SimCloud source):
  1. DB: embedded Postgres (PGlite) behind SimCloud's unchanged
     `app/lib/db/data-api.ts` adapter API; data at `~/.uniscenarios/cloud/db`;
     `DATABASE_URL` switches to a real Postgres pool. Graceful close on
     SIGINT/SIGTERM (PGlite corrupts on abrupt kill; adapter drains + closes).
     Never open the data dir from two processes.
  2. Storage: filesystem object store keyed `{bucket,key}` under
     `~/.uniscenarios/cloud/artifacts` behind the `s3-presign`/`s3-object`
     APIs; presigned URLs are local routes.
  3. Identity: fixed Local Owner user + workspace at the
     `route-session`/app-context seam; billing returns free/unlimited; Meshy
     asset generation and enrichment fleets are disabled with explicit UI
     states.
- **Local workers** (`apps/cloud/worker/`): one process, two lanes speaking
  the production HTTP protocols against localhost (workers never touch the
  DB): the browser render lane (cpu-jobs claim → download input closure →
  render with the repo renderer → encode mp4 → reserve/upload/finalize
  recording) and the compiler lane (exports claim → materialize → OpenSCENARIO
  1.4 export + XSD validation → execution package artifacts).
- Maps are seeded through the REAL publication pipeline (not hand-inserted
  rows): full browser asset closures (~1088 members for Yale) including
  collision derivatives, SUMO networks (packaged SUMO 1.27.1 wasm runtime),
  parking stalls, road-network GeoJSON, and generated thumbnails.

## Repo layout (top level)

- `packages/*` — the canonical npm stack (scenario-model, sim-engine,
  editor-core, city-renderer, browser-renderer, playback, openscenario,
  prop-catalog, ambient-traffic, camera-rig, xodr-tools, render-runtime, …).
- `apps/cloud` — the local SimCloud product (Next.js 16 / React 19 /
  Tailwind 3.4). **The launch surface.**
- `apps/studio` — the legacy Vite studio UI, retired from entry points
  (`pnpm run dev:studio-legacy` only); scheduled for removal once `apps/cloud`
  fully supersedes it.
- `native/` — Bevy renderer (render-core, service, sensors) + shm zero-copy
  service.
- `adapters/`, `qualification/`, `catalog/`, `dev-assets/` (symlink to local
  map corpus), `tools/` (bridge-fidelity instrument, h3-reproduce, …),
  `docs/`.

## Verification culture

Determinism and evidence are load-bearing: frozen eval suites
(`qualification/`), golden-maneuver oracles with provenance CI, golden-hash
render CI per GPU fingerprint, a frozen detection instrument (yolo11s,
ultralytics 8.4.126, conf 0.25/IoU 0.5, weights checked in) for all
render-fidelity scoring, and real executed evidence required from every
program lane (no scaffolds).
