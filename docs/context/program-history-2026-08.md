# Program History — August 2026
> **Historical record:** Pre-rebrand UniScenarios package, CLI, and directory
> names are retained verbatim below.


Last updated: 2026-08-23. Condensed record of the multi-wave agent programs
that produced the current tree. Each wave ran as parallel worktree lanes with
evidence gates; all listed results are merged to main unless noted.

## Wave 1 — RL / sim-to-real pipeline hardening (WS1–WS7)

Context: RL training was paused program-wide to fix pipeline fundamentals
first. Two prior RL result sets (r1/r2) were invalidated — pedestrian contacts
never fired collision termination.

- **WS1 Real corpus**: 1760 frames (BDD100K + nuScenes mirrors), frozen
  detection instrument (yolo11s, weights sha `85a76fe8…` checked in).
- **WS2 Examiner**: claims.v1 examiner, 423-case benchmark, 100% recovery.
- **WS3 Teacher decision**: The 2026-08-22 license review found MiniMax H3
  restricted for training. The user superseded that recommendation on
  2026-08-23: H3 is the only video model for research tasks, the license concern
  is explicitly waived for that scope, and Wan 2.2 was removed. The retired
  Wan student v0 scores remain only as annotated experiment history.
- **WS4 Determinism**: Chrome/SwiftShader rendering is NOT byte-stable (0/8);
  Bevy native is (59/59) — grounded the native-renderer program.
- **WS5**: frozen 40-entry policy eval suite
  (`qualification/policy-eval-suite.v1.json`).
- **WS6**: CARLA-oracled `golden-maneuvers.v2.json` with provenance CI.
- **WS7 Training economics**: 53 real GRPO steps, OOM boundary table; 100k
  decisions ≈ 0.6–4.9 GPU-days on the 8×A100 cluster (simforge1).

## Wave 2 — Bevy native renderer to CARLA-application coverage (WSB1–WSB7)

- 5-map decoded sensor corpus (`.corpus/`, byte-stable); scene-state.v1 +
  actor playback; 18-sensor suite (lidar/radar/IMU/GNSS; 46/46
  hash-identical); realism stack (LightProbe scaling bug fixed — probe was a
  1 m cube at origin; HDRI_TO_CDM2=20_000); `render run --engine native`
  end-to-end (401 frames, 4.5× realtime; service 193.5 steps/s; zero-copy
  shm); golden-hash CI (caught tile spawn-order nondeterminism); `import
  carla` Python facade; vegetation instancing; BestShot fidelity comparisons
  vs three.js shipped to the user.
- Open punch list: motion-vector buffers all-zero (WSB2), road-speckle /
  fog-sky-zenith / dark-facade artifacts (WSB4), one-tick pose-offset audit
  (WSB5), Solari rung-5 wiring, realism ablation stage B.

## Wave 3 — V2XCarla digital-twin port (V1–V7)

Keeps the deployed WS :8765 protocol byte-compatible while swapping CARLA for
the UniScenarios backend. Landed: TruthStream (signalSnapshotAt, live msgpack
subscription, byte-identical stream), MapParity (ingested the deployed
Richmond XODR `0737f3d9…` — road-14 had moved 16.9 m vs the repo revision;
coordinate contract + golden fixtures), ScenarioMigration (firetruck .xosc
pair re-expressed, PASS), FacadeExt (28 pytest, pure-pursuit demo), SensorRig
(camera service + one-frame readback-lag flush fix). V2 BridgePort remains
undispatched. The user's production V2X twin service is read-only/untouchable.

## H3 video-translation investigation

The earlier 0.0-binding score was a harness payload artifact (source video
sent as `role:"reference"` = style-only). Working recipe: `task:"fl2va"` with
first+last source frames as `role:"keyframe"` → recall 0.375 / IoU 0.750 vs
the user's Hailuo-website bar 0.354 / 0.711. Caveat: keyframes pin style
(midnight restyle fails); restyled-keyframe arms ran as follow-up. On
2026-08-23 the user made H3 the only video model for research and explicitly
waived the documented license concern for that scope. Wan 2.2 was removed;
its scored results remain annotated as historical records. Verdict doc:
`tools/h3-reproduce/VERDICT.md`.

## Wave 4 — SimCloud local port (SC1–SC7, 2026-08-22/23)

Goal: the app you run locally IS SimCloud — 1:1 UI, zero cloud dependencies,
optional local render worker. Plan: `docs/simcloud-local-port-plan.md`.

- Reconnaissance established: SimCloud owns its entire editor presentation
  (`apps/web/app/dashboard/uniscenario/editor/**`) over vendored rc.45
  packages; backend seams are narrow (one SQL adapter over Aurora Data API,
  S3 helpers, Better Auth session seam); render/compile workers are HTTP
  clients that never touch Postgres.
- Six lanes ported ~1,300 files into `apps/cloud` (foundation/seams, editor,
  datasets/dashboard, API control plane [125 routes], maps+assets apps,
  local worker). Integration closed ~792 cross-lane gaps by copying real
  source modules (never stubs). `tsc` and `next build` clean.
- Local additions where upstream had no local path (all documented):
  browser-recording create/reserve/finalize routes; enriched CPU claim
  closure (`RemoteInput.relativePath` map-tree preservation, decoded
  PlaybackBundle reuse from simulation previews); local compiler worker lane;
  legacy-table migrations (SimCloud's own fresh bootstrap is broken — several
  live tables have no tracked DDL; synthesized/copied into
  `apps/cloud/migrations/`).
- Defects found and fixed during the product E2E (work-zone scenario:
  cones/barriers/marshal/vehicles/rain/sensors): PGlite needed
  `serverExternalPackages`; PGlite corrupts on SIGTERM → graceful-close
  singleton (25/25 kill-cycle proof); seed rewritten to run the REAL map
  publication pipeline (member counts ~2.5×; SUMO runtime + 56 live vehicles
  verified; parked cars; thumbnails; route config unblocked); dark world =
  Balanced tier passed `cinematicLighting:false` → scene.environment null;
  render validation wrongly demanded the Pronto/Kia rig for browser renders →
  authored sensor hosts accepted; worker poll timer was unref'd → silent
  idle exit.
- Cutover: root `pnpm dev` launches `apps/cloud` on :5199;
  `dev:worker` adds the local worker; the legacy Vite studio moved behind
  `dev:studio-legacy` pending removal.

## Wave 4 completion — SimCloud port verified end-to-end (2026-08-23)

After the cutover, the full product chain was proven on the local stack:
author work-zone scenario → simulate (SUMO 56 live ambient vehicles, parked
cars, lit world) → simulation preview → Create Render with an authored Basic
Dash Camera → local worker claims/renders/encodes → gallery mp4 (H.264
1280×720, 24 fps, 5.0 s) → OpenSCENARIO 1.4 export compiles and downloads
(local compiler worker lane). Everything merged to main; the running services
serve from the canonical checkout on :5199 (tailnet 100.72.252.40:5199).

## Wave 5 — Video-model bake-off (2026-08-23)

Question: which model can take our Bevy-rendered driving video, change the
weather, and make it photoreal while preserving the scene? Protocol: full
source-video conditioning (keyframe conditioning prohibited unless a model has
no reference path — user policy), frozen yolo11s all-class scoring against the
tick-identical three.js twin, GPU-resident execution only (no CPU offload —
user policy), ARM-RAIN + ARM-NIGHT prompts, artifacts on
`seablue:~/Downloads/model-bakeoff/` (grids `bakeoff-*-grid-v2.mp4`).

| Model | Verdict |
|---|---|
| **Qwen-Video-Edit** (Qwen-Image-Edit DiT over Wan-VAE latents) | **Winner** — the only architecture that binds to source structure (road/median/houses/ego path preserved) with convincing rain and real night (luma 0.34). Resident recipe proven: FP8-resident DiT + component-placed encoder/VAE, 12.4% faster than offload. Its Wan2.2 enhancement stage runs resident in 11 min but WORSENS seams (+8%) and hallucinates a fake dashcam timestamp — recommendation: raw resident; seam fix = overlap-blended chunking (open item, with small-actor fidelity). |
| Bernini-Diffusers-v2 | Most dramatic weather, but regenerates the scene. Presentation tool only. |
| LTX 0.9.8 2B / 2.3 22B IC-LoRA / 2.5 | Fast; strong effects (2.3 Day-To-Night luma 0.52) but geometry regenerated in every variant; 2.5 ships no control adapters yet. FAIL vs the Qwen bar. |
| Evoke 14B | Not a translator: v2v = continuation/re-imagination of a different street. Genuinely photoreal world model — research direction only. |
| ID-V2V (Eyeline/Netflix) | Cannot run GPU-resident on 40 GB cards (51.7 GB weights/rank; USP replicates weights). Partial run: nice weather, structure below Qwen. SAM3 finds no cars in our stylized renders (only the pedestrian). |
| H3 (incumbent) | **Closed case** — see below. |

## H3 final verdict (2026-08-23)

The website-vs-local gap is NOT a deployment problem. Falsified with evidence:
quantization (BF16, null), wrong weights (official checkpoints), Turbo LoRA
(none), flow shift (matches), steps (50 vs 20 moved recall 0.141 vs 0.127),
resolution (768p arm 0.167, still under half the bar). SGLang at exact vanilla
settings (A7) scored 0.114 vs the website bar 0.354/0.711. Causal divergence:
the hosted product runs closed modules (H3-Context-IR prompt/context
orchestrator + H3-Regenerate-2K second pass) and the released Ref2VA
architecture's references explicitly do not bind generated geometry. Official
open task inventory is exactly t2va/fl2va/ref2va — no identity or
source-binding route exists. Conclusion: open-weights H3 cannot do
structure-faithful video translation regardless of serving. The official
Diffusers loader also cannot run GPU-resident on A100-40GB (61.7 GB
transformer, no TP/USP path). Package:
`seablue:~/Downloads/model-bakeoff/h3-vanilla/`.

## Standing policies (user decisions, 2026-08-23)

- Video models: research scope, licensing explicitly waived by the user.
- Wan 2.2 removed from the project as our teacher/tooling (87.7 GiB purged
  from simforge1); third-party pipelines that internally embed Wan components
  may still be evaluated for functionality.
- Conditioning: full source video as reference, never first/last keyframes
  unless a model has no reference path.
- Execution: never CPU/sequential offload — always fully GPU-resident,
  sharded/component-placed across GPUs; report precise memory breakdowns when
  a model cannot fit resident.

## Standing operational facts

- GPU box: RTX 5080 16 GB locally (user's production V2X twin holds ~9.4 GB —
  read-only); training cluster simforge1 (8×A100-40 GB, shared).
- Artifacts for the user ship via `scp … seablue:~/Downloads/`.
- Frozen scoring instrument: yolo11s @ ultralytics 8.4.126, conf 0.25 /
  IoU 0.5, weights `tools/bridge-fidelity/.corpus/weights/yolo11s.pt`.

## 2026-08-23 (later): SimForge consolidation executed

Rebrand program dispatched and landed on main the same day. Lanes: RebrandCore
(deletions → CLI lib-face + ActorRenderer seam commits → atomic 24→13
merge/rename sweep), DocsRewrite (README storefront + docs refile),
ReleasePrep (publication manifest, 13-tarball audit, SimCloud sync data),
VerifyMerged (full verification incl. Studio browser E2E). Post-merge fixes:
browser-safe "." vs node-only "./node" entries for @simforge/compiler and
@simforge/maps (studio client bundle had pulled fs); restored the
digest-protected authored catalog artifact the sweep had rewritten; dev:worker
made worker-only; studio/.next untracked. CLI suite's 62 remaining failures
reproduce byte-for-byte at the pre-rebrand baseline with the same dev-assets —
pre-existing local dev-assets drift, tracked as an open item, not a rebrand
regression. Frozen wire contract (uniscenario.* schemas, /api/uniscenario/**,
scenario-format ids, scene-state.v1) verified untouched.
