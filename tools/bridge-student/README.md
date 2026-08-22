# tools/bridge-student — WS3 bridge hardening

Implementation of plan WS3 (docs/rl-platform-hardening-plan.md) work items:
few-step conditional bridge student, trace-derived G-buffer conditioning,
frozen-perception auto-reject auditor, and the pair inventory / scale-out
calculator. Python, uv-managed.

**Teacher license decision:** see `docs/teacher-license-decision.md` — H3 is
NO-GO for training use (§V.3 output-training ban + US Excluded Territory);
Wan 2.2 (Apache-2.0) is the primary teacher. Nothing in this package trains on
H3 outputs.

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

The POV set provides 600 render frames (10 clips x 60); with teacher frames
extracted from Wan 2.2 runs it is 600 full pairs — far below the 100k target,
so this run is explicitly a proof-of-scale: it exercises the entire pipeline
(conditioning generation, few-step distillation loss, previews, checkpoints)
and produces a real checkpoint with loss curves.

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

## Teacher-frame generation command path (Wan 2.2, Apache-2.0)

One-time env (single A100-40GB, TI2V-5B fits):

```bash
uv pip install 'diffusers>=0.36' accelerate imageio[ffmpeg]
hf download Wan-AI/Wan2.2-TI2V-5B --local-dir ~/models/Wan2.2-TI2V-5B
```

Per clip (image = first render frame; caption = scene description from
gt.jsonl manifest; 5 s @ 24 fps, 704x480):

```python
# tools/bridge-student/scripts/wan_translate.py (see scripts/)
from diffusers import WanImageToVideoPipeline  # diffusers >= 0.36
pipe = WanImageToVideoPipeline.from_pretrained("~/models/Wan2.2-TI2V-5B", torch_dtype=torch.bfloat16).to("cuda")
out = pipe(image=first_frame, prompt=caption, num_frames=121, guidance_scale=5.0).frames[0]
# export frames NNNNN.png at 60 frames (subsample 24fps -> 12fps to match clips)
```

Batch wrapper: `scripts/wan_translate.py --clips-root ~/w0-data/clips-pov
--out ~/ws3-bridge/teacher-frames` translates every clip and writes frame-extracted
PNGs in the layout `teacher-frames/<clip>/<NNNNN>.png`.

## Frame-wise AR follow-on (documented, not faked)

Causal Forcing++-style frame-wise AR (1-2 step per frame, previous generated
frame as temporal condition) is the interactive-loop stage AFTER the per-frame
student passes its gate. It requires (a) a causal/temporal backbone (the
per-frame SD-turbo U-Net has no temporal axis), and (b) clip-level training
data with temporal conditioning — neither exists in this pass. The trainer
above deliberately stops at per-frame v0; the AR upgrade lands as
`bridge_student/ar/` once Wan 2.2 video pairs exist at >10k scale.

## Scale-out memo

Run `inventory.py` after each new batch of teacher generations; the committed
`reports/inventory.json` records measured constants (H3 reference latency,
Wan latency once measured) and the GPU-day cost of reaching 100k pairs.
