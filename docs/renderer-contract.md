# Renderer contract v1 (`simforge.renderer-contract/v1`)

The renderer-neutral boundary between SimForge scene/session state and any
concrete renderer. It freezes the *shapes* that cross the boundary — camera
commands, actor frame batches, light state, picks, schedules, map
publications, semantic legends, artifact provenance — without rewriting any
working renderer internals.

Source of truth: `packages/viewer/src/renderer-contract.ts` (pure types +
normative pure functions, no `three` import, no runtime dependency).
Conformance evidence: `packages/viewer/src/renderer-contract.test.ts` against
`packages/viewer/fixtures/renderer-contract/basic-intersection.v1.json`,
executed through the Three adapter
(`packages/viewer/src/renderer-contract-adapter.ts`).

## Viewport ownership (frozen)

| Surface | Renderer | Status |
|---|---|---|
| Scenario editor + preview + quick VP9 recording | **Packaged Three WebGL** — `@simforge/viewer` `CityViewer` + `ActorRenderer` | Canonical authoring viewport. Keeps custom picking, `G`/`R` modal manipulation, WebCodecs canvas recording. |
| City / digital-twin | **Platform Three WebGPU** — bespoke `city-viewer` runtime (platform repo) | Canonical map/twin surface. Streaming, TSL post stack, luminaires. |
| High-fidelity preview, sensor/dataset artifacts | **Native Bevy** — `renderer/{render-core,sensors,service}` | Canonical sensor/cinematic lane. Headless jobs + shm service; not a browser viewport. |

**There is no third browser viewport.** New browser render work lands in one
of the two existing Three surfaces; Bevy work lands in the native lane. A
Bevy WASM editor is gated behind the strategy-A feasibility spike and is out
of scope for this contract version.

## Frozen wire identifiers

`scene-state.v1` and `uniscenario.static-semantics/v1` are referenced
byte-identically (see `docs/engineering/simcloud-sync.md`). Identifiers new
in this contract use the `simforge.` prefix:

- `simforge.renderer-contract/v1` — the contract version.
- `simforge.renderer-parity-fixture/v1` — the fixture document version.

## Contract surface

All coordinates are the y-up scene frame of scene-state.v1; metres, radians,
seconds. Matrices are 16 numbers, **column-major** (Three `Matrix4.elements`
order); row-major consumers own the transpose.

### Camera / view commands — `CameraCommand`, `CameraStateReport`

- `set-pose` — eye/target (+optional up). Formalizes `CameraView` /
  `CameraRig.applyView`.
- `set-intrinsics` — vertical FoV (deg), aspect, near, far. Pixel-focal
  consumers derive `fy = h / (2·tan(fovY/2))`, `fx = fy`, centred principal
  point.
- `frame` — explicit bounding sphere; the resulting pose is **normative**
  (`frameCameraPose`: fit the sphere in the smaller frustum axis, 15% pad,
  default azimuth π/4, elevation π/5) so framing is matrix-identical across
  renderers.
- `follow` — attachment (`actor` / `traffic-signal` / `map-feature`) +
  `chase`/`dash` mode; actor poses are normative (`followCameraPose`).
- `set-constraints-enabled` — sensor rigs temporarily own the exact eye below
  editor navigation limits (mirrors `setCameraPoseConstraintsEnabled`).

`CameraStateReport` returns pose, intrinsics, view matrix (world→camera) and
projection matrix (GL depth convention, [-1, 1]).

### Actor frame batches — `ActorFrameBatch`, `ActorRenderState`

`ActorRenderState` is the proven `ActorView` shape stated neutrally: id,
catalogId, ground-contact x/y/z, `headingRad` (CCW from +X about +Y), dims,
plus articulation/cue channels (doors, reversing, emergency, indicator,
headlights, bodyColor, animationTimeS, speedMps, downProgress). The Three
adapter compile-asserts `ActorRenderState` → `ActorView` assignability, so
the contract cannot drift from the renderer.

Batch semantics are **idempotent replace-all per layer** (`editor`,
`sumo-traffic`, renderer-local ids): the renderer draws exactly the batch,
matching `ActorRenderer.syncLayer`. Spawn/despawn is carried explicitly by
scene-state.v1 tick records; `actorRenderStateFromSceneState` is the
normative mapping from a scene-state actor tick (+ playback cues) to a
render state (`speedMps = |velocity|`, `animationTimeS = frame.t`).

### Light state — `LightStateReport`, `deriveVehicleLightStates`

Deterministic, renderer-portable rules (pinned to the Three implementation by
compile-time constant checks and the fixture test):

- Low beams: explicit per-actor `headlights` wins; otherwise the
  environment-driven global default (authored darkness). Emissive lenses are
  unbounded.
- Projected beams: at most `PROJECTED_HEADLIGHT_LIMIT = 8` real lights,
  chosen by ascending actor id.
- Street luminaires: bounded nearest-camera pool,
  `STREET_LUMINAIRE_ACTIVE_LIMIT = 12`.
- Emergency (`flashing`/`flashing_siren`), indicators
  (`left`/`right`/`hazard`), reverse panel: direct functions of the actor
  state.

### Picking — `PickRequest` → `PickResult`

Requests are NDC (+y up) against declared layers (`actors`, `ground`,
`map-static`). Hits are **id-based**: stable actor id or semantic instance
id, distance in metres, world-space point, optional semantic classification.
No `three` `Intersection`, no scene-graph object, ever crosses the boundary.
Light/cue volumes (low-beam lenses, emergency strobes, reverse panels) are
not selection targets.

### Fixed-step render schedule — `RenderSchedule`

`tickHz`, `startTick`, `frameCount`, exact backing-buffer size, pixel ratio
pinned to 1. `scheduleTimestampsMicros` yields the exact integer-microsecond
timestamps (WebCodecs/WebM timebase). A conforming renderer presents exactly
`frameCount` frames at these timestamps — the browser recorder's capture
manifest and a native render job share this schedule.

### Map publication — `MapPublicationDescriptor`

Manifest URL + `cacheVersion` (first 16 hex of sha256(manifest bytes) — the
existing asset-cache identity), schema version, optional full digest, static
semantics sidecar reference (`uniscenario.static-semantics/v1`), optional
asset variant. Browser renderers stream it; native renderers receive the same
publication resolved to absolute payloads. Identity is the digest, never a
mutable URL.

### Semantic legend — `SemanticLegend`

Static classes (the ten `uniscenario.static-semantics/v1` classes) and
scene-state actor classes are restated and pinned by test. Static instance
ids come from the published sidecar; actor instance ids are assigned
`1 + index` in ascending actor-id order (`actorInstanceLegend`) so ID passes
agree across renderers.

### Artifact provenance — `ArtifactProvenance`

Renderer identity (`three-webgl` / `three-webgpu` / `bevy-native`, version,
backend, device) plus input digests (scene-state, XODR, map cache version,
schedule) and a **determinism class**: `schedule-and-structure` (exact
schedule, container layout, ids, digests) or `byte-identical-pixels`.
Cross-GPU browser artifacts must claim `schedule-and-structure`; matching
input digests never imply pixel parity.

## Parity fixtures

`packages/viewer/fixtures/renderer-contract/*.json`
(`simforge.renderer-parity-fixture/v1`). Given the embedded scene-state.v1
document at tick `T` (+ playback cues + darkness default), a conforming
renderer must reproduce:

| Expectation | Tolerance |
|---|---|
| Camera view/projection matrices per camera case | abs ≤ `1e-6` per element |
| Actor body world transforms (position + yaw + dims/template scale, incl. gait offsets at `animationTimeS`) | abs ≤ `1e-6` per element |
| Vehicle light-on states + street-light pool config | exact |
| Semantic legend (classes, actor instance ids) | exact |
| Pick results (actor id per NDC ray; hit distance) | id exact; distance abs ≤ `1e-4` m |
| Schedule timestamps (µs) | exact integers |

Tolerances are f64-math tolerances, not pixel tolerances: the fixture pins
scene semantics, never GPU output. Regenerate after an *intentional*
behaviour change:

```
cd packages/viewer
REGEN_RENDERER_CONTRACT_FIXTURE=1 pnpm vitest run src/renderer-contract.test.ts
```

## Three adapter (compile-level proof, not a migration)

`ThreeRendererAdapter` wraps the narrow structural slice of `CityViewer`
(`ThreeAdapterHost`: camera, rig `getView`/`applyView`/`setEnabled`,
constraint toggle — the same structural trick as the editor's
`viewer-contract.ts`) plus an `ActorRenderer`. Compile-time proofs:

- `cityViewerAsAdapterHost`: `CityViewer` satisfies the host slice.
- `contractActorToView`: `ActorRenderState` is assignable to `ActorView`.
- `PROJECTED_HEADLIGHT_LIMIT` / `STREET_LUMINAIRE_ACTIVE_LIMIT` are pinned to
  `MAX_PROJECTED_HEADLIGHTS` / `DEFAULT_ACTIVE_LUMINAIRE_LIMIT` by typed
  constant assignment.

The adapter's light report is read from the *observed* renderer scene graph
(batch id bands, visible spotlights) and must equal the contract's normative
derivation — the fixture test asserts both.

## Public APIs this contract replaces at integration time (patch notes)

No implementation is migrated in v1. When a surface adopts the contract, the
following leaked-Three publics are superseded (replacement in parentheses):

- `CityViewer.scene` / `.camera` / `.renderer` / `.roadGroup` / `.cityGroup` /
  `.vegetationGroup` — mutable Three objects in the public API
  (→ `CameraCommand` / `CameraStateReport`; actor mounting via
  `ActorFrameBatch`; map layers via `MapPublicationDescriptor`).
- `CityViewer.controls: CameraRig` and `CameraRig.setView(Vector3, Vector3)`,
  `CameraPoseConstraint(PerspectiveCamera, Vector3)` (→ `set-pose` /
  `set-constraints-enabled`; `CameraView` capture stays, it is already
  neutral).
- Editor `EditorViewer` (`packages/editor/src/viewer-contract.ts`) exposing
  `Scene`/`PerspectiveCamera`/`renderer.domElement` (→ `ThreeAdapterHost`-
  style narrow slice + contract camera/pick channels).
- `Raycaster.setFromCamera` + `ActorRenderer.pickables()` +
  `actorIdForHit(Intersection)` call sites in editor/platform surfaces
  (→ `PickRequest`/`PickResult`; `actorIdForHit` remains internal to the
  Three adapter).
- `ActorRenderer.group` mounting into `viewer.scene` by platform code
  (→ adapter-owned mounting; frames via `applyActorFrame`).
- Ad-hoc light toggles (`setHeadlightsEnabled`, `setStreetLightsEnabled`)
  consumed cross-package (→ `LightStateReport` + environment default in the
  frame path).
- Sensor-capture camera re-posing that mutates Three cameras directly
  (→ `set-intrinsics`/`set-pose` with `set-constraints-enabled`).

Interior uses of Three inside a renderer are untouched — the contract governs
what crosses package/process boundaries, not how a renderer draws.
