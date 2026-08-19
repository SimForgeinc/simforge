# Dark 3D renders: root cause, fix, verification

Stream: `opus-render-exposure`. Worktree `/tmp/uniscenarios-opus-render-exposure`, branch `opus-render-exposure`.

## 1. Root cause

**The Studio renderer cannot survive a lost WebGL context, and it does not say so.** When the
driver drops the GPU device mid-capture, three.js re-initialises the context and re-uploads every
texture from its CPU-side copy. The streamed city has no CPU copy left, and the environment never
had one, so the scene comes back with black albedo under a black sky. Nothing refetched it, and
`getStats().loading` stayed `0`, so every "wait for stream idle" gate — including the exporter's —
happily shot the black frame and shipped it as evidence. Reviewers read the result as an exposure
defect.

The chain, with evidence:

1. `packages/city-renderer/src/gltf.ts:117` — `uploadTexture()` pushes a streamed texture to the
   GPU and then closes the `ImageBitmap` and drops the CPU copy. Correct for memory (an unclosed
   LOD0 tile costs its texture footprint twice), fatal for recovery.
2. `packages/city-renderer/src/streaming.ts:359` — every streamed city / road / vegetation tile
   texture goes through that function, so no tile has a CPU copy after its first upload.
3. `packages/city-renderer/src/environment.ts:29-51` — `loadEnvironment()` runs the `.hdr` through
   `PMREMGenerator` and installs the resulting **render-target** texture as both
   `scene.environment` and `scene.background`. A render target has no CPU copy at all.
4. On `webglcontextrestored`, three re-initialises the context, which resets its property store, so
   every texture is re-uploaded from `texture.image` on next use. A closed bitmap reports 0×0 and
   Chrome rejects the upload. Observed live, 216 times in one loss/restore cycle:
   `WebGL: INVALID_VALUE: texSubImage2D: The source data has been detached.`
5. `packages/city-renderer/src/viewer.ts:262-311` (constructor) — before this change `CityViewer`
   attached **no** `webglcontextlost` / `webglcontextrestored` listener. Nothing refetched the tiles
   and nothing regenerated the IBL.
6. `packages/city-renderer/src/viewer.ts:1070-1074` — `getStats().loading` summed stream, map-load,
   preset-transition and auxiliary work. It had no term for "the context died and the scene is being
   rebuilt", so it read `0` while the scene was black. Every capture gate keys off exactly that
   field.
7. `scripts/export-render.mjs:773-789` (pre-change) — the shutter's only guard was
   `screenshotBytes >= 20_000`, a proxy for "empty scene". A measured dark city frame is
   **72 314 bytes** — 3.6× the threshold — so the proxy passed the very defect it existed for.

### Why it presented as an exposure/tonemap defect, and why it is not

Exposure and tonemap are set once at construction (`viewer.ts:281-282`,
`AgXToneMapping` + `toneMappingExposure`) and never touched afterwards. A wrong default, a wrong
time-of-day or a missing environment light would be **constant across a clip**. The archived
defective clips instead show a **one-frame step down that never recovers** — an irreversible state
change mid-capture. Per-frame mean luma (`ffmpeg signalstats`) of the archived `video.mp4`:

```
el-camino-road-1beae1101faf0b55-1   136 136 136 136 137 137 | 39 40 41 42 ... 45     (step at frame 6)
el-camino-road-5fa984f01741bcdd-2   176 ... 178 178 178     | 18 18 18 18 ... 19     (step at frame 63)
el-camino-road-1fda689970019870-1   139 ... 141 141         | 22 22 22 21 ... 20     (step at frame 22)
yale-street-45552e879b159fb7-0      19 19 19 ... 20                                  (dark from frame 0)
richmond-field-station-307a4af...-0 21 21 21 ... 21                                  (dark from frame 0)
el-camino-road-5fa984f01741bcdd-0   19 19 19 ... 19                                  (dark from frame 0)
```

The post-step floor is Y≈18–22 on three different maps in three different jobs — one shared
fallback state, not a per-scene lighting choice. Accepted control clip
`el-camino-road-5fa984f01741bcdd-1` sits at Y 175–183 for all 142 frames.

Corroboration: cell `el-camino-road-1fda689970019870-1`'s four archived **stills** are bright
(Y 138.9 / 139.1 / 143.6) while its **video** goes dark at frame 22. The exporter captures stills
before the video sequence, so the loss landed inside the video loop — exactly where a mid-run device
loss would.

### Trigger on this machine (environmental, not a renderer bug)

`packages/cli/src/commands/render/tier3d.ts:99-103` forces the production render onto the real GPU
(`--use-gl=angle --use-angle=vulkan --enable-features=Vulkan`). On this host that GPU is shared:

```
$ nvidia-smi
|    0   N/A  N/A          124224    C+G   ...ux/CarlaUnreal-Linux-Shipping       9453MiB |
|    0   N/A  N/A          347242      C   /usr/bin/ffmpeg                         394MiB |   (x6)
|    0   N/A  N/A         2327341      C   ...la/perception-venv/bin/python        532MiB |
|   13553MiB /  16303MiB |
```

13.4 GiB of 16.3 GiB is committed before Chrome starts. A device loss under that pressure is
expected. A renderer that returns black afterwards is the defect.

## 2. The fix

All at the renderer source. No frame post-processing, no clamping, no new gate.

**`packages/city-renderer/src/viewer.ts`** — `CityViewer` now owns context recovery:

* Attaches `webglcontextlost` / `webglcontextrestored` in the constructor, after three's own
  listeners, so the GL context is already re-initialised when ours runs; detaches both in `dispose()`.
* `handleContextLost` raises a `contextLost` flag.
* `handleContextRestored` drops the dead PMREM environment (and the stashed copies the ultra-low
  toggle keeps, so a disposed texture stays unreachable), clears the memoised
  `visualResourcesPromise`, then rebuilds through the existing `runPresetTransition`:
  `ensureVisualResources()` regenerates the IBL and `reloadAssetVariant()` refetches every streamed
  tile. Losing the CPU copy remains the right trade; the recovery is a refetch.
* `getStats().loading` adds `Number(this.contextLost)`. `runPresetTransition` raises the count
  synchronously, so the flag can clear immediately without ever letting `loading` touch `0` during
  the rebuild. Every existing "wait for stream idle" caller therefore blocks until the scene is
  whole again — no caller changed.

**`packages/city-renderer/src/gltf.ts`** — the `uploadTexture` doc now records the trap: closing the
bitmap is deliberate, the restore path re-reads `texture.image`, and the answer is a refetch, not a
second resident copy. Comment only.

**`packages/city-renderer/src/types.ts`** — documents what `CityViewerStats.loading` now covers.

**`scripts/export-render.mjs`** — the shutter no longer guesses from PNG size. A context can die
between the readiness gate and the shutter, so after each capture it asks the renderer whether
anything was outstanding (`getStats().loading === 0`); if not, it waits for stream idle and
re-shoots, and fails closed after three attempts.

**`scripts/verify-city-renderer.mjs`** — new step 6 is the regression test: measure mean luminance of
the live drawing buffer, force a context loss with `WEBGL_lose_context`, assert `loading > 0` while
lost, wait on the viewer's own idle signal, and fail the smoke if luminance does not return to
≥80 % of baseline. Console notices from the *induced* loss are exempt; a spontaneous loss still
fails the run.

## 3. Verification

### 3a. Decisive A/B — one build, one live page, handlers detached vs attached

`scripts/.ab-ctxloss-tmp.mjs` (scratch, deleted; measurement identical to the committed smoke step):

```
baseline                      mean luminance 147.03
PRE-FIX  handlers detached    mean luminance 7.30    loading while lost=0
POST-FIX handlers attached    mean luminance 147.03  loading while lost=1

detached-bitmap upload warnings observed: 216
  e.g. WebGL: INVALID_VALUE: texSubImage2D: The source data has been detached.
recovery vs baseline: pre-fix 0.050x, post-fix 1.000x
```

Canvas screenshots of the same three states, mean luma via `ffmpeg signalstats`: 139.6 → **23.1** →
139.6. Pre-fix Y=23.1 lands inside the archived defect's floor band (Y 18–22): the same fault.
`loading` staying `0` pre-fix and rising to `1` post-fix is the reason the old gates never held.
Visually inspected: pre-fix is a black scene with a handful of untextured beige polygons and no sky;
post-fix is indistinguishable from baseline.

### 3b. Re-render of previously-dark cells from the archived traces

Same inputs (`source/instance.json` + `source/trace.json.gz`), same exporter arguments as `tier3d`
(fps 12, 1600×960, `--camera-search --pin-page --full-clip`, ANGLE/Vulkan), same frame count and
fps as the archive. Mean luma over the whole clip via `ffmpeg signalstats`:

| cell | map | frames | archived: mean / min | re-render: mean / min | machine verdict |
|---|---|---|---|---|---|
| `el-camino-road-5fa984f01741bcdd-2` (job 52fc92cd) | el-camino-road | 145 | 87.1 / **18.2** | **181.9 / 175.8** | pass |
| `el-camino-road-1fda689970019870-1` (job 38a19fd2) | el-camino-road | 61 | 63.6 / **20.4** | **143.9 / 140.4** | pass |
| `yale-street-45552e879b159fb7-0` (job 340f7a3a) | yale-street | 95 | 19.3 / **18.9** | **131.3 / 128.5** | pass |

Not one dark frame in any of the three re-renders; the minimum frame is brighter than the archived
maximum in two of three cells. Visually inspected frame-for-frame against the archive
(`ffmpeg -vf select=eq(n\,N)`):

* Cell A frame 100 — archived: black road, no markings, vehicles readable only as white roof
  silhouettes with tail-lights. Re-render: asphalt, dashed white lane lines, solid yellow centre
  line, left-turn arrow, both vehicles with body colour and visible wheel/road contact, street
  lights, kerb, sky.
* Cell B frame 45 — archived: black; only cones, a work-zone sign and silhouettes visible.
  Re-render: asphalt, lane arrows, dashed and solid markings, cone taper, both actors grounded,
  buildings, sky.
* Cell C frame 60 — archived: black; pedestrian and both vehicles nearly invisible. Re-render:
  double-yellow centre line, dashed lane line, crosswalk, right-turn arrow, pedestrian mid-crossing
  clearly on the road surface, traffic lights, storefronts, street trees.

### 3c. End-to-end: full export driven *through* two forced mid-capture losses

Instrumented copy of the exporter (scratch, deleted) that forces `loseContext()`/`restoreContext()`
twice inside the video-frame loop, otherwise identical arguments:

```
Error: scenario visual evidence rejected: browser-diagnostics-empty
verdict = reject
gates: 12 pass= 11
  FAIL browser-diagnostics-empty {"count": 4, "diagnostics": [
     {"type":"console","text":"[ctxloss-probe] forcing context loss #1"},
     {"type":"console","text":"[ctxloss-probe] restored #1"},
     {"type":"console","text":"[ctxloss-probe] forcing context loss #2"},
     {"type":"console","text":"[ctxloss-probe] restored #2"}]}
videoFrames = 59 fps = 12

$ ffmpeg signalstats /tmp/rerender/ctxloss-injected/video.mp4
   frames=59 meanY=143.6 min=139.7 max=146.9
```

The only failing gate is `browser-diagnostics-empty`, and it fails **only** because of the probe's
own four console lines, which the manifest quotes verbatim — that is the proof the two losses fired.
59 frames captured across two context destructions: minimum Y 139.7, no dark frame. The archived run
of the same cell stepped 141 → 22 and never recovered.

### 3d. Renderer smoke (committed regression test)

```
$ DISPLAY=:120 node scripts/verify-city-renderer.mjs --url "http://127.0.0.1:5297/?map=yale-street" \
    --out /tmp/verify-cr --chrome-flags "--use-gl=angle,--use-angle=vulkan,--enable-features=Vulkan"
> WebGL {"vendor":"Google Inc. (NVIDIA)","renderer":"ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX 5080 ...","version":"WebGL 2.0"}
> coarse city resident after 8855 ms
> gpu context loss recovery
  mean luminance 142.3 -> 142.3 (1.000x), loading while lost: 3
console errors: 0
```

`report.json`: `contextRecovery = {meanLumaBefore: 142.267, meanLumaAfter: 142.267, ratio: 1,
loadingWhileLost: 3}`, `finalStats.residentTiles = 38`, `loading = 0`. Exit 0.

### 3e. Targeted unit tests

```
$ pnpm --filter @uniscenarios/city-renderer test
 Test Files  11 passed (11)
      Tests  75 passed (75)

$ node --test scripts/__tests__/export-render.test.mjs
# tests 12
# pass 12
# fail 0
```

`pnpm --filter @uniscenarios/city-renderer build` (tsup + dts) succeeds; the built `dist` is what the
Studio dev server serves.

## 4. Simplified away

* **`screenshotBytes >= 20_000` and the whole `stat()`-based shutter guard** in
  `scripts/export-render.mjs`, plus the now-unused `stat` import. It was a byte-size proxy for
  "empty scene" that could not see the defect it existed for: a measured dark city frame is
  72 314 bytes, 3.6× the threshold. Replaced by asking the renderer whether the scene was whole
  across the shutter — the same field every other gate already trusts.
* **A redundant `settleFrames(page, 12)`** in the re-shoot path: `waitForStreamIdle`
  (`scripts/export-render.mjs:209`) already settles 12 frames.
* **A redundant loop exit**: the retry had both `attempt < 3 && !whole` and an inner
  `if (whole) break`. One condition now.
* **A dead local** in `handleContextRestored` (`const rebuilt = …; void rebuilt;`) collapsed to
  `void this.runPresetTransition(…)`, matching the existing call style at `viewer.ts:1203/1213/1215`.
* **No new machinery for the lost window**: no new counter, no new option, no new abstraction. The
  rebuild reuses `runPresetTransition` (which already owns error capture and the `loading` count) and
  `reloadAssetVariant` (which already exists for preset changes). The `loading` contract is unchanged
  for every caller.
* **No brightness or luminance gate was added.** The archived dark renders passed all 12 machine
  gates; the temptation is to add a 13th. Per the owner's direction the source fix removes the need,
  and `tools/gates/tg_gate.py` and evidence-identity hashing were not touched.
* **Seven scratch probe scripts deleted** (`scripts/.abtest-tmp.sh`, `.backend-tmp.mjs`,
  `.export-probe-tmp.mjs`, `.probe-tmp.mjs`, `.probe2-tmp.mjs`, `.probe3-mean.mjs`,
  `.verify-ctxloss-tmp.mjs`, plus this session's `.ab-ctxloss-tmp.mjs` and `.export-ctxloss-tmp.mjs`).
  The one durable thing among them — a real-GPU context-loss recovery check — is folded into
  `scripts/verify-city-renderer.mjs` step 6.

Net: `packages/` gains 67 lines and drops 4; `scripts/` gains 88 and drops 10. 75 of the 88 are the
regression test, and the byte-size heuristic is gone.

## 5. What I could not explain

* **One of the seven `render.camera.exposure` verdicts is a different defect and is not fixed.**
  `belmont-research-center-01e04873160b2b01-1` (job 340f7a3a) reads "Washed-out lighting makes road,
  sidewalk, and verge boundaries difficult to distinguish". Its clip measures Y 141 → 184, i.e.
  *brighter* than the accepted control (175–183) — over-exposure, not context loss. I did not
  investigate it. The other six verdicts are the dark signature and are addressed.
* **I never captured a spontaneous device loss.** Every loss I observed was induced with
  `WEBGL_lose_context`. The VRAM-pressure trigger is inferred from `nvidia-smi` plus the archived
  step-function luminance traces; the archived manifests record no GL diagnostics, so the original
  loss events are not directly attested in the artifacts. What is proven is the consequence: an
  unhandled restore produces exactly the archived failure state, and the fix removes it.
* **A loss forced every 12 s never converged.** One instrumented run lost the context every 12
  seconds; the initial `waitForStreamIdle` never reached idle inside its 120 s budget and the export
  failed closed instead of emitting dark frames. I did not determine whether that is simply "losses
  arriving faster than a 14-tile refetch completes" or a convergence problem in the rebuild path. At
  a 60 s period the same export completes cleanly (§3c).
* **Post-drop drift in one archived clip.** `el-camino-road-1beae1101faf0b55-1` floors at 39 and
  drifts 39 → 57 → 43 instead of staying flat. Consistent with tiles fetched *after* the restore
  uploading correctly while pre-loss tiles stay black, but I did not verify that per tile.
* **Operational footgun, not a bug:** rebuilding `packages/city-renderer` while an export is running
  makes Vite hot-update the page and kills the run with "Execution context was destroyed"
  (`--pin-page` only neutralises `location.reload()`). One re-render died that way and was repeated.

## 6. Files changed

```
packages/city-renderer/src/viewer.ts    +52 -1   context loss/restore recovery, loading term
packages/city-renderer/src/gltf.ts      +10 -3   records the closed-bitmap/restore trap
packages/city-renderer/src/types.ts     +5  -0   documents CityViewerStats.loading
scripts/export-render.mjs               +13 -9   shutter asks the renderer, not the PNG size
scripts/verify-city-renderer.mjs        +75 -1   step 6: context-loss recovery regression test
```
