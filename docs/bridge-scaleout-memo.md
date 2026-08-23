# Bridge corpus scale-out memo — from 600 pairs to 100k

WS3, 2026-08-22. All constants measured on this date unless noted. Raw data:
`tools/bridge-student/reports/inventory.json` (regenerate with
`python -m bridge_student.inventory ...`).

## 1. What exists now (measured)

| item | count |
|---|---|
| render clips (POV set, 5 s @ 12 fps, 376×374 + per-frame gt.jsonl) | 10 |
| render frames | 600 |
| Wan 2.2 TI2V-5B teacher translations (frame-extracted) | 10 clips / 600 frames |
| H3 Ref2VA translations (frame-extracted, eval-reference ONLY — license) | 10 clips / 600 frames |
| **aligned (render+G-buffer-conditioning, teacher-RGB) pairs usable for training** | **600** |
| aligned pairs on H3 outputs (forbidden as training signal) | 600 |

Conclusion: **600 pairs ≪ a few thousand ⇒ the committed v0 run is explicitly
a proof-of-scale run** (1500 steps, batch 4 @384², loss curve + samples +
checkpoint on simforge1). It validates plumbing, not scale.

## 2. Measured unit costs

| stage | measured | hardware |
|---|---|---|
| Engine render + GT capture | 4.33 ms/frame RGB+instanceID+depth native (`scripts/renderer-spike/FINDINGS.md`) → 100k frames ≈ **7.3 min total** | local RTX-class GPU; A100s NOT needed for rendering (wgpu raster is slow on datacenter drivers) |
| Teacher translation, Wan 2.2 TI2V-5B | **257.4 s per 121-frame clip** (= ~128 s/60-frame pair-clip), single GPU bf16 | 1× A100-40GB |
| Teacher translation, H3 Ref2VA (reference only) | 895 s/clip warm | 1× A100-40GB (SGLang BF16) |
| Student training (ControlNet on frozen sd-turbo) | 0.285 s/step @ batch 4, 384² (1500 steps in 427 s) | 1× A100-40GB |

## 3. Exact requirements for the 100k-pair target

100k pairs = 1,667 clips of 60 frames.

**Generation (the long pole is teacher inference):**
- Wan 2.2: 1,667 × 257.4 s = **119.3 GPU-h ≈ 1.24 GPU-days on one A100 =
  0.31 days on 4×A100**.
- Rendering/G-buffers on the RTX-class card: negligible (<15 min wall).
- Catalog capacity: 500 authored slots × 60 f = 30k frames per pass; reaching
  100k pairs needs ~3.3 clips/slot via seed re-instantiation + weather/time
  visual overlays (fog/night-rain presets already exist in `render-clip.mjs`)
  + POV/framing variants. Command path per batch:
  `scripts/w0/render-all.sh` (or `render-clip.mjs --camera pov`) →
  `tools/bridge-student/scripts/wan_translate.py` → `detect.py` → `auditor.py`
  auto-reject (budget ~20–30% rejects at current quality ⇒ generate ~125k
  raw pairs to land 100k audited).

**Training:** scaling v0's measured throughput (batch 4, 0.285 s/step):
a full distillation pass over 100k pairs (1 epoch ≈ 25k steps @ batch 4)
≈ 2 h/A100; a realistic recipe (≈8 epochs equivalent, batch 32 via grad accum,
480p) lands at **≈ 3–5 GPU-days on 4×A100**. Training is NOT the bottleneck;
teacher generation and audited-pair yield are.

## 4. Bottleneck ranking

1. **Audited-pair yield** — current auto-reject rates: H3 100%, Wan 70%
   (>20% gate). Conditioning work must drive this below 20% before scale-out;
   otherwise generation cost multiplies by reject rate.
2. Teacher throughput (0.31 days/100k on 4×A100 — cheap).
3. Student training (days, parallelizable).

## 5. Disk budget

Per 100k pairs: render PNGs ~55 GB (delete after conditioning cache),
Wan frames ~30 GB PNG (keep evidence clips as mp4, per Main hygiene rule),
conditioning npz cache ~40 GB. Keep mp4s + auditor JSONs as evidence; raw
PNG sequences are deletable post-measurement.
