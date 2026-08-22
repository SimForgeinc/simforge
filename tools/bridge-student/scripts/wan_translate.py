#!/usr/bin/env python
"""Translate W0 render clips to photoreal teacher frames with Wan 2.2 (Apache-2.0).

For each clip: first render frame as the image condition + a caption derived
from gt.jsonl -> WanImageToVideoPipeline (TI2V-5B) -> 121 frames @ 24 fps ->
subsampled to 60 frames matching the render cadence -> <out>/<clip>/<NNNNN>.png.

Usage:
  python scripts/wan_translate.py --clips-root ~/w0-data/clips-pov \
      --model ~/models/Wan2.2-TI2V-5B --out ~/ws3-bridge/teacher-frames \
      [--clips baseline-midblock ...]
"""

from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import torch
from PIL import Image


def clip_caption(clip_dir: str) -> str:
    """Deterministic scene caption from the manifest + first GT record."""
    manifest = os.path.join(clip_dir, "manifest.json")
    if os.path.isfile(manifest):
        with open(manifest) as f:
            m = json.load(f)
        parts = [str(m.get("scenarioId", "urban street"))]
        w = m.get("weatherVisual") or m.get("weather")
        if w:
            parts.append(str(w))
        return ("photorealistic dashcam footage of an urban street scene, "
                + ", ".join(parts))
    return "photorealistic dashcam footage of an urban street"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips-root", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clips", nargs="*", default=None)
    ap.add_argument("--num-frames", type=int, default=121,
                    help="Wan latent frames; 4k+1 for 24fps video")
    ap.add_argument("--out-frames", type=int, default=60)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--width", type=int, default=704)
    ap.add_argument("--guidance-scale", type=float, default=5.0)
    ap.add_argument("--seed", type=int, default=20260822)
    args = ap.parse_args()

    from diffusers import WanImageToVideoPipeline

    pipe = WanImageToVideoPipeline.from_pretrained(
        args.model, torch_dtype=torch.bfloat16
    ).to("cuda")
    pipe.enable_model_cpu_offload()  # fits A100-40GB with headroom

    clips = args.clips or sorted(os.listdir(args.clips_root))
    os.makedirs(args.out, exist_ok=True)

    for clip in clips:
        cdir = os.path.join(args.clips_root, clip)
        frames_dir = os.path.join(cdir, "frames")
        if not os.path.isdir(frames_dir):
            print("skip (no frames):", clip, flush=True)
            continue
        out_dir = os.path.join(args.out, clip)
        done_marker = os.path.join(out_dir, ".done")
        if os.path.isfile(done_marker):
            print("skip (done):", clip, flush=True)
            continue
        os.makedirs(out_dir, exist_ok=True)

        first = Image.open(os.path.join(frames_dir, "frame-00000.png")).convert("RGB")
        first = first.resize((args.width, args.height), Image.LANCZOS)
        caption = clip_caption(cdir)

        t0 = time.time()
        gen = torch.Generator(device="cuda").manual_seed(args.seed)
        with torch.no_grad():
            video = pipe(
                image=first, prompt=caption, num_frames=args.num_frames,
                guidance_scale=args.guidance_scale, generator=gen,
            ).frames[0]  # list/stack of HWC uint8-ish tensors in [0,1]
        dt = time.time() - t0

        nf = len(video)
        idxs = np.linspace(0, nf - 1, args.out_frames).round().astype(int)
        for j, vi in enumerate(idxs):
            arr = (video[vi].float().cpu().numpy().transpose(1, 2, 0) * 255).astype(np.uint8) \
                if hasattr(video[vi], "permute") else np.asarray(video[vi].convert("RGB"))
            Image.fromarray(arr).save(os.path.join(out_dir, f"{j:05d}.png"))
        with open(done_marker, "w") as f:
            json.dump({"seconds": round(dt, 1), "frames_out": int(len(idxs)),
                       "num_frames": nf}, f)
        print(f"{clip}: {nf} frames in {dt:.1f}s -> {out_dir}", flush=True)


if __name__ == "__main__":
    main()
