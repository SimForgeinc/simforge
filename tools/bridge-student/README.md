# tools/bridge-student — WS3 bridge hardening

Implementation of plan WS3 (docs/rl-platform-hardening-plan.md) work items:
few-step conditional bridge student, trace-derived G-buffer conditioning,
frozen-perception auto-reject auditor, and the pair inventory / scale-out
calculator. Python, uv-managed.

**Teacher decision:** see `docs/teacher-license-decision.md`. By user directive
dated 2026-08-23, H3 (MiniMax) is the only video model for research tasks.
The user explicitly waived the documented license concern for that research
scope; this package contains no alternate video-teacher implementation.

## Layout

```
src/bridge_student/
  gbuffer.py    trace-derived G-buffers: depth/semantic/instance/valid maps
                rasterized from gt.jsonl with the W0-audit camera conventions
  dataset.py    aligned-pair dataset + train/val split by clip
  model.py      frozen few-step base (sd-turbo) + ControlNet assembly
  train.py      training loop -> loss.jsonl, samples/, ckpt/
  sample.py     comparison strips [semantic | depth | target | student@1..4 steps]
  auditor.py    frozen-perception auto-reject vs engine GT; rejection-rate report
  inventory.py  corpus inventory + 100k-pair scale-out cost model
```

Conditioning contract (fixed): 6 channels = [depth/80m, semantic palette RGB,
instance/256, valid mask]. Geometry authority lives in the conditioning;
teacher frames are only the style target.

## Setup (simforge1)

```bash
ssh ubuntu@216.151.21.122
export PATH=$HOME/.local/bin:$PATH
cd ~/ws3-bridge/tools/bridge-student
uv venv --python 3.12 && uv pip install -e '.[train]'
```

## Student v0 training (proof of scale)

The POV set provides 600 render frames (10 clips x 60). A complete H3
frame-extraction pass provides 600 full pairs — far below the 100k target, so
this run is explicitly a proof-of-scale: it exercises conditioning generation,
few-step distillation loss, previews, checkpoints, and produces a real
checkpoint with loss curves.

```bash
python -m bridge_student.train \
  --clips-root ~/w0-data/clips-pov \
  --teacher-root ~/ws3-bridge/teacher-frames   # omit => render-only targets
  --out ~/ws3-bridge/runs/v0-proof --steps 1500 --batch 4 --res 384 \
  --cache-dir ~/ws3-bridge/cache/gbuffers
```

Sampling:

```bash
python -m bridge_student.sample --ckpt <run>/ckpt --clips-root ~/w0-data/clips-pov \
  --out <run>/samples-eval --clips bus-stop-emergence workzone-lane-shift --steps 1 2 4
```

## Auditor

Consumes cached W0 audit artifacts read-only (projected GT boxes +
YOLO-World v2 detection dumps), re-implements matching independently, and
emits per-clip verdicts plus aggregate rejection rate against the plan's <20%
gate:

```bash
python -m bridge_student.auditor \
  --gt-boxes-dir ~/w0-audit/gt_boxes/pov --dets-dir ~/w0-audit/det \
  --set-tag _pov --out ~/ws3-bridge/reports/auditor-pov.json
```

## Teacher-frame inputs (H3-only research scope)

H3 generation is performed by the research workflow outside this package.
Extract each H3 output to the layout
`teacher-frames/<clip>/<NNNNN>.png`, aligned to the 60 render frames, then pass
that directory through `--teacher-root`. There is intentionally no alternate
video-model branch or local translation script in this package.

## Frame-wise AR follow-on (documented, not faked)

Causal Forcing++-style frame-wise AR (1-2 step per frame, previous generated
frame as temporal condition) is the interactive-loop stage AFTER the per-frame
student passes its gate. It requires (a) a causal/temporal backbone (the
per-frame SD-turbo U-Net has no temporal axis), and (b) clip-level training
data with temporal conditioning — neither exists in this pass. The trainer
above deliberately stops at per-frame v0; the AR upgrade lands as
`bridge_student/ar/` once H3 video pairs exist at >10k scale.

## Scale-out memo

Run `inventory.py` after each new batch of H3 teacher generations; the
committed `reports/inventory.json` records measured H3 latency and the GPU-day
cost of reaching 100k pairs.

## Retired v0 run findings (2026-08-22, historical record)

**[RETIRED — prior video model removed from the project 2026-08-23.]** The
historical `runs/v0-wan-teacher` experiment used 480 train / 120 val pairs,
1500 steps @ batch 4, 384², lr 1e-5. Its recorded loss curve was 0.056 -> 0.005
(eps-MSE), ~0.285 s/step on A100. The scores below remain as experiment history;
the run is not an operative teacher path.

Outcome: per-step eps predictions validate on held-out clips
(t=750 mse 0.023, t=500 0.103, t=250 0.347), BUT multi-step few-step
sampling collapses to a flat field. Controls performed:
- canonical `StableDiffusionControlNetPipeline` (4/8/30 steps, capped
  timesteps): same collapse;
- RANDOM-INIT ControlNet through our own manual DDIM/EulerA loop:
  perfect sd-turbo street scene => sampler and wiring are correct;
  the trained adapter itself causes the collapse.

Diagnosis (ranked): eps-MSE-only objective on 600 near-duplicate frames
lets the adapter satisfy the loss by memorized x0-regression that is
unstable off the training manifold; no val-loss gate was wired; bf16-autocast
train / fp16-infer mismatch unverified. Next levers (in order):
paired single/few-step REGRESSION distillation against teacher frames
(L2+LPIPS, DMD/CausVid-family) instead of pure eps-MSE; min-SNR timestep
weighting; val-loss early stop; mixed-precision parity check.
