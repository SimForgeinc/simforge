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
| A4 | current harness control on richmond: video + 3 style imgs + W0 prompt, 20 steps, 416p | (pending) | | |
| A5 | `type:"video_audio"` arm | N/A — both available source clips carry no audio track; schema rejects audio-less `video_audio` ("MiniMax H3 audio material has no audio stream") | | |
| A6 | video-only + user prompt verbatim, 20 steps, **768p** (resolution factor) | (pending) | | |
| D1 | real-footage control | N/A — no real driving video exists in the environment (WS1 corpus = BDD stills; simforge1 `nuplan_demo.mp4` is a BEV visualization render, not camera footage; first attempt scored vacuously: 0 vehicle dets in source) | | |
| E1 | fl2va first-frame keyframe of the source clip + user prompt, 20 steps | (pending) | | |
| E2 | fl2va first+last keyframes + user prompt, 20 steps | (pending) | | |

All arms: engine clip = first 8 s of richmond-20s chase render (1280×720@24),
`target {short_edge 416→or 768, aspect 16:9, duration 8 s}`, `flow_shift 12`,
`audio_flow_shift 3`, `seed 44`, single output.

## 3. Verdict

(filled at end of run)

## 4. Reproduction

- `tools/h3-reproduce/score_binding.py` — frozen-instrument per-clip scorer.
- `tools/h3-reproduce/run_matrix.sh` — payload matrix runner (simforge1).
- `results/*.json` — raw per-arm scores.
