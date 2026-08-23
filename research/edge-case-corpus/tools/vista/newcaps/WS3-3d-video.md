# WS-3: 3D VIDEO (UniScenarios-vista)

## BOTTOM LINE
**MET.** Scenarios render as H.264 MP4 **from the real UniScenarios 3D world** (apps/studio +
city-renderer/three.js) driven in headless Chrome by `scripts/export-render.mjs`. Three real bugs found
and fixed; none of them was the FirstRunGraphicsChooser that the previous two agents suspected.
Full-corpus render rate is **0.970** (98 ok / 3 failed over the first 101 of 293 records) and the
3 residuals are characterised: 2 corrupt input artifacts and 1 genuinely-occluded pedestrian.
Throughput **18.2 s/scenario at concurrency 4 (~198 renders/hour)** without camera search, ~22-23 s
(~160/hour) with it => the full 293 corpus is **1.5-1.8 h wall clock**. A full-corpus render is feasible.

## The three bugs

**Bug 1 (the hang that killed both previous agents) - `hideUiForExport()` hid the viewer canvas.**
It set `visibility:hidden` on every non-CANVAS child of `#root > div`, but the canvas is not a direct
child: the chain is `#root > DIV > DIV > DIV > DIV > CANVAS`, and `#root > div` has children
`[HEADER, DIV]`. The wrapper holding the canvas was hidden, the canvas became non-visible, and
`elementHandle.screenshot()` blocked on actionability. Both previous runs stop immediately after
`[progress] ... composition`, which is exactly the line before the screenshot. Measured with
`scripts/_ws3-probe.mjs`:

```
OK   page.screenshot                144 ms 761819 B
OK   canvas.screenshot              157 ms 714749 B   <- before hideUiForExport
FAIL canvas.screenshot afterHideUi  20004 ms TimeoutError: elementHandle.screenshot
OK   page.screenshot afterHideUi     21 ms   6717 B   <- 6.7 KB == blank, whole app hidden
```
Fix: walk the canvas ancestor chain and hide only its *siblings* at each level.

**Bug 2 - benign SUMO warnings rejected valid evidence.** 4/12 of the first batch failed the
`browser-diagnostics-empty` gate on `Warning: Vehicle 'sumo-...' performs emergency braking on lane ...
decel=9.00`. The bundled ambient traffic model emits its advisory channel through `console.error`. Fix:
`/^Warning: /` console messages go to a new non-blocking `manifest.simulationNotices` bucket; pageerrors
and every real console error still fail the gate.

**Bug 3 - the analytic camera aims through buildings.** A first full-corpus pass ran at only **0.634**
(52 ok / 30 failed over 82 records), 29 of the 30 failures in parking archetypes
(c11g-indicator-mislead 10, c11g-hidden-child 7, c11g-wrong-way-aisle 6, parked-vans-narrow-road 6).
Every one threw `incident composition failed at t=<x>: <actor>(inFrame=true, sceneryClear=false,
blocker=city)`. This was the exporter failing CLOSED and being right: `cameraForClip` /
`cameraForIncident` derive the azimuth from the incident sightline alone, and on a real city map that
direction is frequently occupied by a building, so `inspectIncidentComposition()` raycasts
`viewer.cityGroup`, sees the facade, and rejects. Parking archetypes dominate because they are authored
against building frontages and lots. It is *not* a timeout, a crash, or asset density: an early-clip
occlusion throws at ~7-9 s and a late-clip one at ~33 s, which is just the clip position of the
occlusion. (Note `frames/frame-002.png` being absent is by design, not a symptom -- the conflict phase
still is written to the reserved catalog name `<out>/frame.png`.)

Fix: `--camera-search`. On composition failure it orbits the *same fitted camera* around its own target
through a ranked ladder (azimuth 0, +-25, +-55, +-90, +-125, 180 deg; height gain 1.0 -> 2.2x) and takes
the first candidate where every framing actor is inside the canvas with an unobstructed ray. The
accepted offset is **sticky** across the clip so the shot stays stable (a typical clip uses 1-3 offsets
over 145 frames) instead of jittering. The strict gate is unchanged: the search runs *before*
`waitForStreamIdle`, and the authoritative composition check still runs *after* stream-idle + settle, so
the export still fails closed. Success went **0.634 -> 0.970** for ~25% more time (~64 s -> ~80 s
serial). `render3d.py` passes it by default; `--no-camera-search` restores the old behaviour.

**Not a bug: the graphics chooser.** `parseQualityPreference()` accepts a bare `{"preset":"minimal"}`
for any non-`custom` preset id, so `inspectQualityPreference().state` is already `'stored'` and the
world mounts in ~2.9 s (stream idle also ~2.9 s). An explicit in-page assertion on that state was added
anyway, so a future regression fails loudly instead of rendering empty frames.

Also added `--pin-page`, which suppresses the Vite dev client's `location.reload()` for the export
session: sibling agents are editing `packages/**` and an HMR full reload mid-sequence destroys
`window.__viewer`.

## Measures
- **M3.1 - renders come from the 3D world, and corpus coverage: PASS on mechanism, 0.970 on coverage.**
  Look at the frames yourself:
  **`/tmp/vista-3d/_try2/frame.png`** (conflict key frame, 1040x918, belmont-research-center) - real
  streamed city, roads, lane markings, street furniture; ego sedan and `lead_suv` both clearly on the
  roadway. **`/tmp/vista-3d/_cs1/frame.png`** (c11g-hidden-child on el-camino-road, a scenario the old
  camera could not shoot at all) - parked vans, traffic signals, and the hidden child pedestrian beside
  the sedan.
  Machine-side this is not my eyeballs: `inspectIncidentComposition()` projects every required actor
  through the live `viewer.camera` and raycasts `viewer.cityGroup`/`vegetationGroup`, so a frame is
  accepted only if every authored actor is inside the canvas AND has an unobstructed ray. In corpus mode
  `framingActorIds = [...evidence.actorIds]`, i.e. **every authored actor, not just the metric pair**,
  and gate `every-video-frame-shows-every-present-actor` passes on all 145 video frames. `audit.py`
  M3.1 is a *coverage* ratio and rises as the run completes.
- **M3.2 - manifest integrity: PASS.** `manifest.integrity` =
  `instanceInputHashMatches:true, traceInputHashMatches:true, mapIdsExactMatch:true,`
  `actorIdsExactMatch:true, staticActorsInvariant:true`; `machineAssessment.verdict:"pass"` with all
  14 gates; `resultBinding.mode:"corpus-semantic"` carrying `resultDigest`, `instanceFileSha256`,
  `traceFileSha256`. `audit.py` reproduced this independently (12/12/12, then 18/18 on the parent's
  own audit).
- **M3.3 - stream properties: PASS.** `ffprobe /tmp/vista-3d/_try2/video.mp4` ->
  `h264, 1040x918, r_frame_rate 12/1, nb_frames 145, duration 12.083333`. The trace clip runs
  t=0.00..12.00, so this is the FULL clip (`coverage:"full-clip"`, gate
  `video-covers-full-clip-duration` pass), not a window around the reveal. `min(w,h)=918 >= 720`,
  `fps=12 >= 12` - exactly what `audit.py` M3.3 checks. 12/12 then 18/18 probed clean.
- **M3.4 - throughput.** Measured on a clean 12-scenario batch, 15-core machine, Chrome falling back to
  SwiftShader software WebGL headless:
  | setting | serial s/scenario | s/scenario @ concurrency 4 | renders/hour | success rate |
  |---|---|---|---|---|
  | no camera search | 64-77 | **18.21** (218.5 s / 12) | **197.7** | 0.634 corpus-wide |
  | `--camera-search` | ~80 | ~22-23 (projected) | ~160 | **0.970** corpus-wide |
  Per-frame cost from `--progress`: sync 1-4 ms, setView ~65 ms, streamIdle ~100 ms, settle ~25 ms,
  composition 1-3 ms, screenshot ~130 ms => ~0.33 s/frame; a 12 s clip at 12 fps is 145 frames.
  Full 293-record corpus: **1.5-1.8 h wall clock at concurrency 4**.

## Residual failures (all characterised, none a renderer defect)
- `upstream-artifact-hash-mismatch` x2 - `evidence integrity failed: manifest.inputHash <a> != recomputed
  <b>`. The instance.json's own declared inputHash does not match a recomputation of its inputs. These
  are DATA defects and fail in ~1.5 s before Chrome starts: `2b4d8a75191b65b5` (c11g-wrong-way-aisle),
  `4c1caccd0ae990b4` (parked-vans-narrow-road, which lives under `/tmp/vista-harv-user`, not `-deliver`).
- `composition-occluded` x1 - `99b012139df5fd1b` (parked-vans-narrow-road), `stepping_pedestrian ...
  blocker=city` at t=2.2: a pedestrian genuinely behind a building from all 17 candidate viewpoints.
  Widening the ladder would likely recover it.

## Deliverables
- **`research/edge-case-corpus/tools/vista/render3d.py`** - resumable batch driver:
  ```
  pnpm --filter @simforge/studio dev --host 127.0.0.1 --port 5199   # ONCE
  cd research/edge-case-corpus/tools/vista
  python3 render3d.py --records /tmp/vista-dataset-all/train.jsonl \
                      --records /tmp/vista-dataset-all/test.jsonl \
                      --out /tmp/vista-3d --concurrency 4
  ```
  Skips scenarios that already have `manifest.json` unless `--force`. Writes `INDEX.json` after
  **every** scenario, so a killed run keeps everything it produced. `--reindex` rebuilds `INDEX.json`
  from artifacts already on disk, with real error text, rendering nothing.
- **`/tmp/vista-3d/INDEX.json`** - a bare JSON **array** of entries. This matters: `audit.py` does
  `ent = json.load(...)` then `for e in ent`, so a top-level object would silently score 0. Each entry:
  `{scenarioId, archetypeId, mapId, siteId, split, instance, mp4, manifest, status, failureKind, error,`
  `log, seconds, integrity{instanceInputHashMatches, instanceHashMatches, manifestInputHashMatches,`
  `traceInputHashMatches, traceHashMatches, mapIdsExactMatch, actorIdsExactMatch, machineVerdict,`
  `failedGates, videoSha256, videoFrameCount, videoFps, videoDurationSeconds, pass}}`.
  Failures also drop `<scenarioDir>/error.json`. Run metadata, `successRate`, `failureKinds` and
  `failuresByArchetype` go to `/tmp/vista-3d/INDEX-meta.json`.
  Stable `failureKind` buckets: `upstream-artifact-hash-mismatch`, `composition-occluded`,
  `camera-clearance`, `preflight-rejected`, `browser-diagnostics`, `evidence-gate-rejected`,
  `quality-preference`, `map-mismatch`, `playwright-timeout`, `studio-unreachable`, `ffmpeg`,
  `driver-timeout`, `missing-input`, `unknown`.
- **`scripts/export-render.mjs`** - the four changes above (`hideUiForExport` fix, simulation-notice
  classification, `--camera-search`, `--pin-page`) plus the explicit `stored` quality assertion.
- **`scripts/_ws3-probe.mjs`** - the diagnostic probe that isolated the screenshot hang.
- Commits on `vista-lane`: `8be7901`, `80a4198`, `23463ac`.

## Caveats
- Chrome falls back to SwiftShader (`--enable-unsafe-swiftshader`) headless on this machine, so this is
  CPU-rendered. A real GPU headless path would improve throughput.
- Canvas is 1040x918 at the default 1600x960 viewport (Studio's header and side panels take layout
  space). That passes `min(w,h) >= 720`. `--width/--height` raise it at proportional cost.
- Rendered against `/tmp/vista-harv-deliver` (+ a few `/tmp/vista-harv-user`) scenarios, which sibling
  agents are regenerating. This is a REHEARSAL: the repeatable path, the failure taxonomy and the cost
  number are the deliverable, not the MP4s. Re-running after regeneration is one command.

## Log
- stub created; dev server confirmed live on 127.0.0.1:5199; reproduced previous agent's hang exactly
- probe isolated the hang to `hideUiForExport` + element screenshot actionability -> fixed
- first end-to-end scenario: 64 s, 145-frame 12 fps MP4, all 14 gates pass
- 12-scenario batch @ concurrency 4: 8 ok, 4 rejected on benign SUMO warnings -> fixed -> 12/12 ok,
  218.5 s wall, 18.21 s/scenario, 197.7 renders/hour
- `audit.py --videos /tmp/vista-3d` confirms M3.2 (12/12/12) and M3.3 (12 probed, all >=720p, all >=12fps)
- full-corpus run 1 (no camera search): 0.634, 29/30 failures in parking archetypes, all
  `sceneryClear=false, blocker=city` -> diagnosed and fixed with `--camera-search`
- full-corpus run 2 (camera search on): **0.970** (98 ok / 3 failed over the first 101 records)
- `render3d.py` now records `status` + `failureKind` + real thrown `error` + `log` per scenario, writes
  `<scenarioDir>/error.json`, and supports `--reindex`
