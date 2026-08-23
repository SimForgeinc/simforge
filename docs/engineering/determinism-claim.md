# Determinism claim — what is byte-exact, what is not (WS4.3)

Status: measured 2026-08-22. This document scopes SimForge's byte-exactness
claim after running a two-pass render determinism harness against the real
Chrome/three.js export path. It replaces assumption with measurement.

## The claim, in four tiers

| Tier | Scope | Byte-exact? | Evidence |
| --- | --- | --- | --- |
| 1. Symbolic engine + traces | `@simforge/engine` ticks, trace JSON, evidence verify (`same-input-hash`) | **Yes** — fixed-step 20ms, integer/canonical serialization; re-simulation reproduces byte-identical traces on any hardware | `campaigns/occluded-pedestrian/determinism-check.json` (trace sha256 equality across cells); engine test suite |
| 2. Structured sensor passes (ID / depth / instance semantics) | G-buffer passes from `@simforge/render/web`, LiDAR/radar point records | **Yes on the Bevy path** (measured bit-identical across process runs, below); intended-but-unmeasured for the browser sensor pipeline | spike hash table §4; harness manifests |
| 3. RGB pixels through Bevy headless | `scripts/renderer-spike/bevy-spike` offscreen wgpu renders | **Yes on one GPU** — RGB, instance-ID and depth f32 all sha256-identical across two independent process runs (RTX 5080). Cross-vendor/cross-driver: NOT guaranteed → golden-hash-per-GPU policy | `scripts/renderer-spike/FINDINGS.md` §4 |
| 4. RGB pixels through Chrome | `scripts/export-render.mjs` → Studio dev server → headless Chrome → three.js WebGL canvas screenshots | **No.** Measured NOT byte-stable even on one machine, one Chrome build, sequential runs. RGB byte-exactness through Chrome is claimed only when *additionally* pinned to one hardware+driver+browser build AND shown stable by this harness per release | see manifest below |

## Measured result (first evidence manifest)


Harness: `qualification/render-determinism/determinism-harness.mjs`
(`--record` copies the manifest into `qualification/render-determinism/evidence/`).

Run `ws4-run-001-map`: yale-street map-orbit scene state rendered **twice**
through independent headless-Chrome processes with identical arguments
(Studio dev server + `scripts/export-render.mjs --map yale-street --frames 8`,
`--headless`, fps 12).

- Frames compared: 8/8 PNG pairs.
- Byte-equal frames: **0/8**. Verdict: **NOT byte-stable**.
- Pixel-level analysis (PIL diff of pass A vs pass B): differences are real
  pixel content changes, not metadata — up to 1.01% of pixels differing on a
  frame (mean channel delta 0.70), max channel delta 212–217.
- Differences are localized: on frame 0 they are confined to rows 55–272,
  cols 0–739 — the distant streamed-tile/sky region — consistent with
  tile-upload/LOD timing racing the exporter's stream-idle + settle heuristic,
  not with rasterizer arithmetic noise.

Hardware fingerprint recorded in the manifest (and it matters):

- GPU as seen by Chrome: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero) (0x0000C0DE)), SwiftShader driver)` — headless Chrome 151 on this
  host renders via **SwiftShader software rasterization**, not the installed
  NVIDIA RTX 5080 (host driver 595.84). The current exporter launch flags
  (`--ignore-gpu-blocklist` only) do not opt out of SwiftShader in new-headless.
- Full fingerprint (Chrome version, user agent, WebGL strings, OS, kernel,
  CPU, nvidia-smi output) is in the manifest under `hardware`.

A second run on belmont-research-center (`ws4-run-002-map`, 6 frames) came out
**5/6 byte-equal**, one frame differing — the instability is intermittent and
content-dependent (far-tile region), which is arguably worse for evidence use
than uniform instability: a clip can pass nine times and silently break on the
tenth.


## Bevy headless path (WS4.1 bake-off, measured independently)

The bake-off spike (`scripts/renderer-spike/FINDINGS.md` §4, read-only for
this workstream) rendered the same yale-street tile set at a fixed pose in two
independent Bevy 0.19.1 headless process runs on the RTX 5080 (Vulkan 1.3,
driver 595.84): RGB PNG, instance-ID PNG, and raw depth f32 were all
**sha256-identical across runs** (e.g. RGB `c3d917c55a02…` in both). Nondeterminism
sources were eliminated by construction (MSAA off, no temporal effects, fixed
camera, deterministic entity-ID assignment).

**Policy adopted: golden-hash-per-GPU.** Same-device wgpu is empirically
bitwise-stable, but cross-vendor/cross-driver byte equality is NOT guaranteed.

Independently re-verified from this workstream after the spike produced
clip-length sequences: `scripts/renderer-spike/out/seq_run1` vs `seq_run2`
(two full process runs) have **59/59 common frames sha256-identical**
(first frame `c9edb32e830c…`). The contrast with the Chrome path on the same
machine could not be sharper: Bevy 59/59 byte-stable vs Chrome 0/8 and 5/6.
Any CI gate on Bevy render hashes therefore pins (GPU model, driver, wgpu
backend) and compares against a golden hash table recorded for that exact
fingerprint — never against a universal hash. The hardware fingerprint block
of every determinism manifest is the key into that table.

Limitation: at the time the ablation runner was written, only single-pose
Bevy stills existed (`scripts/renderer-spike/out/bevy_a_run1.*`); the spike has
since landed clip-length sequences (`out/seq_run1`, `out/seq_run2`), which are
the stage-B frame sets the runner now discovers automatically. Vegetation,
HDRI sky and lighting-calibration parity remain open spike work
(est. 4–7 days per the bake-off report).

## Consequences

1. **RGB frame hashes must never be used as replay/evidence identity.** Trace
   and instance hashes (tier 1) remain the binding identity; render manifests
   may record RGB hashes as diagnostics only.
2. **Any student-training or perception gate that consumes RGB** must treat
   renderer output as *approximately* reproducible: identical inputs give
   visually equivalent frames (>99% pixels identical, differences concentrated
   in far tiles) but not identical bytes.
3. **The "pinned hardware+driver" RGB tier requires two fixes before it can be
   claimed:** (a) force a real GPU rasterizer (e.g. launch flags opting out of
   SwiftShader) or accept and pin the software rasterizer explicitly;
   (b) eliminate the far-tile settle race (e.g. deterministic tile-residency
   barrier before capture). Both are measurable with this harness; neither is
   claimed today.
4. **Cross-hardware RGB reproducibility is explicitly NOT claimed** — see the
   `verdict.scope` field in every manifest.

## Reproducing

```sh
pnpm install && pnpm -r --filter './packages/*' --filter '@simforge/studio' build

# Map-orbit mode (no scenario evidence needed):
node qualification/render-determinism/determinism-harness.mjs \
  --map yale-street --frames-count 8 \
  --out artifacts/render-determinism/<run-id> --record

# Bound-scenario mode (instance + trace + result triple; requires the
# topology-index.json.gz sidecar for the map, which local dev-assets lack —
# regenerate via the map pipeline first):
node qualification/render-determinism/determinism-harness.mjs \
  --scenario catalog/evidence/belmont-research-center/belmont-research-center-001-child-dartout-parked-cars-afeb89eed1e5 \
  --out artifacts/render-determinism/<run-id> --record
```

Exit code is 0 when the measurement completes regardless of stability (this is
a measurement tool); `--require-stable` turns instability into exit code 2 for
use as a CI gate once tier-3 pins land.

First manifests:
`qualification/render-determinism/evidence/ws4-run-001-map.json` and
`qualification/render-determinism/evidence/ws4-run-002-map.json`.
