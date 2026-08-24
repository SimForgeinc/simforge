# W0 Kill-Test Inputs

Rendered clip set for the Phase-5W W0 H3 translation kill test: 10
driving-scene clips (5 s @ 12 fps, 736x416 = H3's true 0.3 MP) with per-frame
engine ground truth, staged for transfer to `simforge1:~/w0-data/`.

## Pipeline

1. **Select** — one catalog slot per content class from
   `catalog/uniscenarios-five-map-v2.catalog.json` (500 authored slots,
   template x site x seed identities).
2. **Instantiate** — `simforge instantiate <template> --map --site --seed`
   using each slot's recorded matcher site + seed → `/home/path/w0-data/instances/`.
3. **Simulate** — `simforge simulate <instance> --trace …` → deterministic
   50 Hz engine trace → `/home/path/w0-data/traces/`.
4. **Render** — `scripts/w0/render-clip.mjs` drives the live Studio viewer
   headless via Playwright (`--use-gl=angle --use-angle=vulkan` selects the real
   RTX 5080; default headless lands on SwiftShader on this host), projects every
   trace tick through `export-render-lib.renderViewsAtTraceIndex`, solves the
   clip camera (CAR POV by default), and screenshots the canvas per frame.
   `scripts/w0/render-all.sh [pov|framing]` batches the full set.
5. **GT** — `gt.jsonl` written alongside frames (format below).
6. **Transfer** — `rsync /home/path/w0-data/ simforge1:~/w0-data/`.

## POV re-render (primary set)

Per the W0 audit finding, the elevated chase view is out-of-distribution for
H3 (trained on dashcam footage). All 10 clips are re-rendered in CAR POV —
camera pinned to the ego windshield (ground +1.45 m, ego pose per frame,
forward along ego heading, 12 m look-ahead, 58° vertical FOV), the pinned ego
body hidden from the render sync while staying in GT. Same instances, sites
and seeds as v1; GT camera fields record the POV solve.

- `render-clip.mjs --camera pov` is the default; `--camera framing` reproduces
  the v1 cinematic solve.
- Output: `/home/path/w0-data/clips-pov/` mirrored to
  `simforge1:~/w0-data/clips-pov/` (verified 10/10). The v1 framing set remains
  at `clips/` for comparison.
- Known drift: the Studio dev server hot-reloads editor-core from the
  training-grade worktree; a mid-batch reload made the renderer throw on
  actors whose trace metadata lacks a `catalog:` tag (some pedestrians and
  cyclists). `render-clip.mjs` now falls back to kind-default catalog ids for
  those, which is also what the old renderer did silently.

## Scene inventory

| clip | class | map | catalog identity | seed source | weather |
|---|---|---|---|---|---|
| baseline-midblock | baseline urban street | yale-street | adult-midblock-crossing, site 00c2fef16f6c7658 | catalog slot yale-street-008 seed | clear |
| signal-red-light | signalized intersection | yale-street | yale-street-002-red-light-late-entry-7f65638f4987 | catalog slot seed | clear |
| school-parked-row-dartout | occlusion dart-out (school) | easterbrook-discovery-school | vru.child-dartout-parked-cars slot | catalog slot seed | clear |
| parked-row-dartout | parked-row occlusion | yale-street | yale-street-007-child-dartout-parked-cars-e4305f31c9d2 | catalog slot seed | clear |
| fog-midblock | fog weather | yale-street | same instance/trace as baseline-midblock | visual-only fog overlay | fog |
| night-rain-merge | night rain + merge | belmont-research-center | belmont-research-center-014-merge-gap-collapse-a3ac64c722d7 | catalog slot seed | night-rain |
| workzone-lane-shift | construction zone | el-camino-road | el-camino-road-003-lane-shift-bbdec3df42c8 | catalog slot seed | clear |
| cutout-reveals-stopped | occlusion-heavy longitudinal | belmont-research-center | belmont-research-center-010-cutout-reveals-stopped-62114c5ecb2f | catalog slot seed | clear |
| bus-stop-emergence | transit multi-actor | yale-street | yale-street-023-bus-stop-emergence-e3ef422a9682 | catalog slot seed | clear |
| lane-drop-merge | multi-actor merge | el-camino-road | el-camino-road-002-lane-drop-late-merge-5018d99ad28e | catalog slot seed | clear |

Every clip directory contains `frames/frame-00000..00059.png`, `video.mp4`
(libx264, 60 frames @ 12 fps = exactly 5 s), `gt.jsonl` (60 records), and
`manifest.json` (sources, sha256s, window, camera mode, weather backend).

## GT format (`gt.jsonl`, one record per rendered frame)

```
schema            "uniscenarios.w0-frame-gt.v1"
scenarioId        engine instanceId of the simulated pair
mapId             five-map id
frame / t         output frame index and exact trace time (tick-nearest)
tickIndex         index into trace.ticks arrays this frame displays
weatherVisual     clear | fog | night-rain (visual overlay flag)
actors[]          per actor, from trace header metadata + exact tick channels:
  id kind catalogId static dims{l,w,h} present
  x yEngine       engine-plane pose (trace channels, quantised engine values)
  zScene yScene   scene-space pose actually displayed (-yEngine, ground-sampled)
  headingRad speedMps s reversing
  laneRsl         lane id ("segment:offset:direction" RSL key; null off-lane)
props[]           static/authored props displayed (parked rows, cones): id,
                  catalogId, dims, x/zScene/headingRad
signals{}         per signal id: state (+program) at that tick; empty on
                  unsignalized maps
camera{eye,target,fovDeg}   solved camera used for this frame (POV = ego pose)
```

The GT is read directly off the engine trace channels (no re-simulation), so it
is byte-consistent with `trace.header.inputHash`; `manifest.json` records both
the raw-file hash and the engine-normalised hash when they differ (adapter
ordering vs `normalizeSimScenarioInput`) — informational only.

## Style references

Copied from `simforge1:~/h3-teacher/smoke/assets/` (already-vetted CC0/PD):
`style-refs/ref1_madison_sb_oakst.jpg`, `ref2_madison_sb_dampier.jpg`,
`ref3_colin_kelley_marker.jpg`. Use as `<Picture 1-3>` in the canonical 5W
prompt (see local://rl-plan.md §"Canonical W0/5W prompt").

## Transfer manifest

`simforge1:~/w0-data/` mirrors `/home/path/w0-data/`:
- `clips-pov/` — primary POV set, 10 clips x (60 PNG + gt.jsonl + video.mp4 +
  manifest.json), verified 10/10 post-transfer.
- `clips/` — v1 framing set, same structure, kept for comparison.
- `style-refs/` — 3 CC0 dashcam stills.
- `instances/`, `traces/` — the exact simulated pairs backing every clip.

## Content gaps found (matter for the content moat)

1. **No weather/time-of-day variants exist.** All 500 catalog slots are authored
   `weekday-clear` (clear/day). Fog and night-rain clips above are *visual-only*
   overlays applied at render time (`render-clip.mjs` WEATHER_PRESETS); the
   engine has no friction/visibility coupling and no authored wetness/snow
   scenarios. Night-rain currently renders through a three.js fallback because
   the Studio dev server's Vite pre-bundle predates
   `CityViewer.setWeatherAppearance` (no surface wetness or sky coupling).
2. **`school.child-dartout` is unrenderable**: all 6 easterbrook slots fail
   instantiation — `examples/school-dartout.template.json` references
   `prop.playground_ball`, which no longer exists in the prop catalog
   (`actor_catalog_class_mismatch`). The class is covered here via
   `vru.child-dartout-parked-cars` on the same map instead.
3. **One stale catalog site**: slot yale-street-008 (adult-midblock-crossing)
   records a matcher site that no longer resolves; instantiated against an
   available current site with the slot's seed instead.
4. **Potholes/damage class** (named in the plan's W0 list) has no templates,
   props or surface-damage capability anywhere in the catalog — zero renderable
   content.
5. Construction zones exist only on el-camino-road (`workZones: true`; all
   other four maps are `false`).
