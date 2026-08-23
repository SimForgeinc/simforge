# H3 video-translation reproduction — verdict (branch `h3-reproduce`)

Worker: H3Reproduce · 2026-08-22 · simforge1 (8×A100-40GB) + local WS1 instrument.

## Question

The official Hailuo/MiniMax **website** produced a good scene-preserving
translation of a driving clip; our SGLang harness payload (source clip as
`{type:"video", role:"reference"}` beside style images, task `ref2va`) scored
**0.0 spatial binding**. Which invocation binds the source scene — or can the
open-weights variant do it at all?

## 1. Schema enumeration (installed SGLang H3 serving code)

Server: SGLang git-main multimodal_gen, `MiniMaxH3Pipeline`
(`.../sglang/multimodal_gen/runtime/pipelines/minimax_h3_pipeline.py`).
All paths below relative to
`~/h3-teacher/.venv/lib/python3.12/site-packages/sglang/multimodal_gen/`.

### Tasks (exactly three; `task` is mandatory)

| task | partition | conditions | citation |
|---|---|---|---|
| `t2va` | FL2VA | none allowed | `runtime/pipelines_core/stages/model_specific_stages/minimax_h3/task_profiles.py:146-157` |
| `fl2va` | FL2VA | 1–2 `image` **keyframes**, `frame_index` ∈ {(0,), (-1,), (0,-1)} | `task_profiles.py:159-181`, signatures at `:69-73` |
| `ref2va` | Ref2VA | `role:"reference"` with `type` ∈ {`image`, `video`, `video_audio`, `audio`} | `task_profiles.py:183-233` |

- Task gate: `runtime/pipelines_core/stages/model_specific_stages/minimax_h3/video_adapter.py:68`
  (`supported_tasks = frozenset({"t2va","fl2va","ref2va"})`); task required
  (`:71-78`). Partition mapping `task_profiles.py:29-34`.
- Roles are **only** `keyframe` and `reference`
  (`task_profiles.py:21-22`). **There is no `source`/`content`/`video2video`
  role, no per-condition strength/weight/cfg field anywhere in the schema.**
- Allowed condition keys: `{type, uri, role, frame_index, start_time_seconds}`
  (`request_validation.py:41-43`, enforcement `:190`). Unknown keys are
  rejected — a "strength" key cannot be smuggled in.
- Design invariant, stated in code: *"keyframes bind target geometry;
  references remain independent"* (`task_profiles.py:8`). A `reference`
  video is encoded as independent context tokens
  (`reference_encoding.py:1-14`; material chain `video.reference_preserve`,
  `task_profiles.py:66-73`) — it never constrains the target latent grid
  frame-by-frame. `ref2va` geometry comes from `explicit_target`
  (`task_profiles.py:236`), never from the reference.
- CFG knobs are **retired**: `guidance_scale`, `guidance_scale_2`,
  `true_cfg_scale`, `negative_prompt` raise errors — the released checkpoints
  are CFG-distilled single-branch (`video_adapter.py:119-136`).
  `configs/sample/minimax_h3.py` pins `guidance_scale=1.0`.
- Only continuous condition-side knobs: `imgvid_cond_noise_aug_for_inference`,
  `audio_cond_noise_aug_for_inference` (RF noise on condition rows,
  `condition_noise.py`); `quality`, `output_mode`, `audio_flow_shift`,
  `audio_guidance_scale` (`video_adapter.py:55-62`). None is a
  content-binding strength.
- Timing: `target.duration_seconds` 4–15 s, fps 24
  (`constants.py:29-31`); recommended `short_edge=768`
  (`constants.py:38`); aspect `auto` or {21:9,16:9,4:3,1:1,3:4,9:16}
  (`task_profiles.py:56-63`).

### How the website maps onto this

Official model card (huggingface.co/MiniMaxAI/MiniMax-H3): the product
pipeline is **H3-Context-IR → H3-Base → (H3-Regenerate-2K)**. H3-Base is the
open-weights part (FL2VA + Ref2VA checkpoints, CFG-distilled).
**H3-Context-IR — "critical to the quality of the final output" — is a hosted
service and is NOT in the open-source release**; MiniMax exposes it as the
`/video-generation-v2-h3-context-ir` API. Its ref2va example prompt shows what
it emits: structured `subject_definitions:` + *"<Video 1> is the source video
for the editing task"* + `summary:` with per-shot descriptions
(~5-40k prompt tokens). H3-Regenerate-2K is likewise not open-sourced.
So the website's default mode = **ref2va with a Context-IR-rewritten prompt**;
the wire-level condition is the same `role:"reference"` video we already send.

## 2. Payload matrix + scores

Instrument (frozen, from `ws1-reality-anchor/tools/bridge-fidelity`):
yolo11s COCO, weights sha256 `85a76fe8…502d5`, conf 0.25, match IoU 0.5,
CPU, imgsz 640; classes collapsed vehicle/pedestrian/bicycle/motorcycle.
Per-clip source↔output frame alignment from t=0; the website clip (15.08 s)
was time-stretched ×480/362 back to the 20 s source timeline for the aligned
score. Boxes compared in resolution-normalized coords.

| # | arm | vehicle recall | binding IoU | hallucination |
|---|---|---|---|---|
| BAR | **hailuo-conversion.mp4 (website default, user prompt)** vs source, time-aligned | **0.354** | **0.711** | **0.807** |
| BAR-raw | same, raw frame-index alignment (no time stretch) | 0.296 | 0.731 | 0.833 |
| CTRL | prior harness run (`ref2va` video+3 style imgs, W0 prompt, 416p) — different engine clip | 0.004 | 0.656 | 0.997 |
| A1 | video-only + user prompt verbatim, server defaults (50 steps), 416p, seed 44 | 0.141 | 0.692 | 0.809 |
| A2 | video-only + user prompt verbatim, 20 steps, 416p, seed 44 | 0.127 | 0.765 | 0.812 |
| A3 | video-only + W0-style long prompt (image clause neutralized), 20 steps, 416p | 0.165 | 0.796 | 0.770 |
| A4 | current harness control on richmond: video + 3 style imgs + W0 prompt, 20 steps, 416p | **0.000** | n/a | **1.000** |
| A5 | `type:"video_audio"` arm | N/A — both available source clips carry no audio track; schema rejects audio-less `video_audio` ("MiniMax H3 audio material has no audio stream") | | |
| A6 | video-only + user prompt verbatim, 20 steps, **768p** (resolution factor) | 0.167 | 0.809 | 0.796 |
| D1 | real-footage control | N/A — no real driving video exists in the environment (WS1 corpus = BDD stills; simforge1 `nuplan_demo.mp4` is a BEV visualization render, not camera footage; first attempt scored vacuously: 0 vehicle dets in source) | | |
| E1 | fl2va first-frame keyframe only + user prompt, 20 steps, 416p | 0.149 | 0.811 | 0.682 |
| E2 | **fl2va first+last keyframes** of source clip + user prompt, 20 steps, 416p | **0.375** | **0.750** | **0.620** |
| A7 | **website-replica**: video-only reference + exact user prompt, 50 steps, 15 s, 768p | **0.114** | **0.841** | **0.810** |
| E3-H3 | candidate `905f752e…` supplied for restyled-keyframe scoring (see identity finding below), 8 s, 416p | **0.149** | **0.813** | **0.682** |
| E3-Wan | Wan 2.2 I2V, graded first keyframe, 8 s | **0.115** | **0.713** | **0.502** |

Matrix arms A1–A6, D1, and E1–E2 used the first 8 s of the richmond-20s
chase render (1280×720@24), `target {short_edge 416→or 768, aspect 16:9,
duration 8 s}`, `flow_shift 12`, `audio_flow_shift 3`, `seed 44`, one output.
A7 and E3 are described separately below.

### A7 — 15 s website-replica arm: **FAIL**

A7 used the exact 15 s source trim, the user's prompt verbatim, Ref2VA at
768p/50 steps, and output `7fc15b64-2093-41a9-97c5-6b3903a65b77.mp4`.
Against that same trim it scores **0.114 vehicle recall / 0.841 binding IoU /
0.810 hallucination** (180 stride-2 frames). Recall is only 32% of the
website bar (**0.354**) and well below the prior E2 keyframe recipe
(**0.375**), though its few accepted matches are tight (IoU exceeds both
0.711 and 0.750 bars). Visual review of the four-frame contact sheet finds a
convincing photoreal midnight grade—dark sky, head/tail lights, practical
building light—but the camera/road trajectory and vehicle layout diverge.
Thus base Ref2VA + reference + prompt does **not** reproduce the website's
combination of style and scene preservation.

**Reference wiring was not dropped.** `req_A7.json` contains
`richmond15s.mp4` as a `type:"video", role:"reference"` condition. The Ref2VA
worker accepted the request, then spent **88.8193 s** in
`MiniMaxH3VisualEncodingStage` before denoising and wrote the named output.
That is positive ingestion evidence: poor binding is model/path behavior, not
a silently omitted video reference.

### E3 — restyled-keyframe transfer

| arm | aligned frames | vehicle recall | binding IoU | hallucination | output/source luma | vs graded-keyframe target |
|---|---:|---:|---:|---:|---:|---|
| H3 candidate `905f752e…` | 96 stride-2 / 192 decoded | 0.149 | 0.813 | 0.682 | **0.277** | 33% darker than 0.41–0.42 |
| Wan 2.2 (production teacher) | 97 stride-2 / 193 decoded | 0.115 | 0.713 | 0.502 | **0.335** | 18% darker than 0.41–0.42 |

Luminance is mean 8-bit grayscale over decoded output frames divided by the
mean of the index-aligned source frames from t=0. Both outputs transfer a
strong night look, but overshoot the graded endpoints' 0.41–0.42
midnight-depth target. Wan visibly retains the chase-car viewpoint and road
axis, but detector recall is poor and extra motorcycles/pedestrians appear;
it is **DEGRADED**, not a production-ready structure-preserving teacher.

The H3 inventory also closes an important provenance problem: candidate
`87d3b9e3…` is byte-identical to prior A4
`A4_control_styleimgs_w0_20st.mp4`, while `905f752e…` is byte-identical to
prior E1 `E1_fl2va_firstframe_20st.mp4`. The new
`fl2va_worker_e3.log` contains model startup through “ready” but no POST,
job ID, visual encoding, denoising, or completion. Therefore there is **no
distinct completed H3 restyled-keyframe artifact** in the stated candidates.
The scored `905f752e…` result is the old source-first-frame arm (its exact
0.149 recall also reproduces E1), so it cannot establish transfer from the
graded E3 keyframes. H3 E3 is **FAIL (artifact/provenance)**, not a positive
or negative model-quality result.

## 3. Verdict

**Both hypotheses were half-right. The 0.0 binding was a payload error, AND the
naive fix (video-only ref2va) still doesn't reach the website bar. The
invocation that reaches it with open weights is first+last-frame FL2VA.**

1. **Payload error confirmed (harness artifact).** A4 — the exact harness
   payload (source video `role:"reference"` + 3 style images + W0 edit prompt,
   task `ref2va`) — scores **0.000 recall / 1.000 hallucination** on the same
   richmond clip, reproducing IsolationX's 0.0 exactly. The style images +
   edit-framing cause the model to generate a fresh scene in the style of the
   images instead of translating the source. This is consistent with the code
   design invariant: references are independent context tokens and *never*
   bind target geometry (`task_profiles.py:8`).
2. **No hidden content-binding mode exists.** The schema admits only
   keyframe (image, frame 0/-1) and reference roles; there is no
   source/strength/cfg knob (`request_validation.py:41`, CFG fields rejected,
   `video_adapter.py:119-136`). Video-only ref2va arms (A1/A2/A3/A6) recover
   partial binding (0.13–0.17 recall) but plateau at ~half the website bar.
   Resolution (A6 768p vs A2 416p: 0.167 vs 0.127) and steps (A1 50 vs A2 20)
   are second-order; the long W0 prompt is mildly helpful (A3 0.165).
3. **Winning invocation: fl2va with BOTH endpoint keyframes (E2)** —
   vehicle recall **0.375 ≥ BAR 0.354**, binding IoU **0.750 ≥ BAR 0.711**,
   hallucination **0.620 < BAR 0.807** (fewer unanchored detections than the
   website output itself). First+last keyframes pin the target's temporal arc;
   first-frame-only (E1, 0.149) drifts like reference-only arms.
4. **Trade-off:** E2 preserves scene/motion but largely *ignores* the
   global style instruction (stayed daytime; user asked for midnight):
   endpoint keyframes pin appearance. Website-grade *style* translation with
   binding needs the closed H3-Context-IR rewriting feeding ref2va — that
   module, not the weights, is the missing piece on the open-weights path.
5. **Teacher decision:** per WS3's license analysis the community weights are
   legally unusable as a distillation teacher regardless (§V.3 ban, USA an
   Excluded Territory). Technically, if a bindable teacher were ever needed:
   fl2va-first-last is the only open-weights H3 mode that carries scene
   content through. The commercial MiniMax/Hailuo API is licensed separately
   from the community weights — its terms need an independent check before
   assuming the NO-GO transfers (no API key exists in the MichaelAgents
   vault, so no product-API arm was run).

### Winning payload JSON (verbatim)

```json
{
  "model": "MiniMaxAI/MiniMax-H3",
  "prompt": "<user style/edit instruction>",
  "seconds": 8,
  "task": "fl2va",
  "conditions": [
    {"type": "image", "uri": "file://.../kf_first.jpg", "role": "keyframe", "frame_index": 0},
    {"type": "image", "uri": "file://.../kf_last.jpg",  "role": "keyframe", "frame_index": -1}
  ],
  "target": {"short_edge": 416, "aspect_ratio": "16:9", "duration_seconds": 8.0},
  "num_outputs_per_prompt": 1,
  "num_inference_steps": 20,
  "flow_shift": 12.0,
  "audio_flow_shift": 3.0,
  "seed": 44
}
```

(`kf_first.jpg` = source frame 0; `kf_last.jpg` = source last frame.
Served by a `--model-variant fl2va` worker. Signature constraint
`(0,-1)` per `task_profiles.py:69-73`; >2 keyframes rejected.)

## 4. Reproduction

- `tools/h3-reproduce/score_binding.py` — frozen-instrument per-clip scorer.
- `tools/h3-reproduce/run_matrix.sh` — payload matrix runner (simforge1).
- `results/*.json` — raw per-arm scores.
- `results/evidence/` — aligned source/output frame pairs backing the scores.
- Ops: an fl2va worker on simforge1 is required for E-arms
  (`--model-variant fl2va`, port 30040 in our run). Launch with
  `SGLANG_USE_RUNAI_MODEL_STREAMER=0` — the default Run:ai model streamer
  deadlocks this box's loader (0 % CPU after "Loading safetensors"; fallback
  reader loads all 33 B weights in ~25 s). The three ref2va workers were
  unaffected (loaded before this regression).
- Website-bar alignment: hailuo-conversion.mp4 is 15.08 s/362 frames from a
  20 s/480-frame source → the website compressed the clip ~1.326×; fair
  comparison time-stretches it back (`setpts=480/362*PTS`), see BAR vs BAR-raw.
