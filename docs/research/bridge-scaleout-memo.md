# Bridge corpus scale-out memo — H3-only research path
> **Historical research memo:** Pre-rebrand tool paths are retained verbatim
> below.


WS3, updated 2026-08-23 by user directive. H3 (MiniMax) is the only video
model for research tasks, and the user explicitly waived the documented H3
license concern for that scope. Raw inventory:
`tools/bridge-student/reports/inventory.json` (regenerate with
`python -m bridge_student.inventory ...`).

## 1. Current measured inventory

| item | count |
|---|---|
| render clips (POV set, 5 s @ 12 fps, 376×374 + per-frame gt.jsonl) | 10 |
| render frames | 600 |
| H3 translations (frame-extracted) | 10 clips / 600 frames |
| **aligned research pairs (render + G-buffer conditioning + H3 RGB)** | **600** |

Conclusion: **600 pairs ≪ a few thousand**. The committed v0 experiment is
only a historical plumbing proof; it does not validate the H3-only scale-out.

## 2. Measured unit costs

| stage | measured | hardware |
|---|---|---|
| Engine render + GT capture | 4.33 ms/frame RGB+instanceID+depth native (`scripts/renderer-spike/FINDINGS.md`) → 100k frames ≈ **7.3 min total** | local RTX-class GPU; A100s not needed for rendering |
| H3 translation | **895 s per 60-frame clip, warm** | 1× A100-40GB (SGLang BF16) |
| Student training (ControlNet on frozen sd-turbo; historical v0 throughput) | 0.285 s/step @ batch 4, 384² | 1× A100-40GB |

## 3. Exact requirements for the 100k-pair target

100k pairs = 1,667 clips of 60 frames.

**Generation:** 1,667 × 895 s = **414.4 GPU-h = 17.27 GPU-days on one
A100, or 4.32 wall-days on 4×A100**. Rendering and G-buffer capture on the
RTX-class card remain negligible (<15 min wall).

Catalog capacity is 500 authored slots × 60 frames = 30k frames per pass.
Reaching 100k pairs requires about 3.3 clips per slot via seed
re-instantiation, weather/time overlays, and POV/framing variants. The batch
path is:

`scripts/w0/render-all.sh` (or `render-clip.mjs --camera pov`) → H3 research
generation → frame extraction → `detect.py` → `auditor.py`.

Budget extra generations according to measured rejection rate rather than
assuming every translated clip is usable.

**Training:** scaling the historical throughput, one pass over 100k pairs
(about 25k steps @ batch 4) is about 2 h/A100. A realistic recipe (about eight
epochs equivalent, batch 32 via gradient accumulation, 480p) is approximately
3–5 GPU-days on 4×A100.

## 4. Bottleneck ranking

1. **Audited-pair yield** — the measured H3 set rejected 100% of clips at the
   frozen detector gate. Conditioning or invocation work must lower rejection
   below 20% before scale-out.
2. **H3 throughput** — 4.32 wall-days per 100k raw pairs on 4×A100 before
   rejection overhead.
3. **Student training** — days, parallelizable, and downstream of the yield
   gate.

## 5. Disk budget

Per 100k pairs: render PNGs about 55 GB, H3 frames about 30 GB, and
conditioning cache about 40 GB. Keep evidence MP4s and auditor JSONs; raw PNG
sequences are deletable after measurement and cache validation.
