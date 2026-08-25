#!/usr/bin/env python
"""E3 arm: restyle source keyframes in IMAGE space with sd-turbo img2img.

Sweep 1 (default): strengths x {distilled no-CFG, CFG+negative}.
Sweep 2 (--night): night-heavy prompt + CFG negatives at moderate strengths,
to force an actual midnight look while keeping structure.
Usage:
  python e3_restyle_sd.py --frames src_frame0.png --out restyled
  python e3_restyle_sd.py --frames ... --out restyled_night --night \
      --strengths 0.5 0.6 0.7
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import torch
from PIL import Image

PROMPT = ("photorealistic midnight driving scene on an urban street at night, "
          "headlights and streetlights, keep every object and its position, "
          "ultra realistic live-action dashcam footage, hyper realism")
NIGHT_PROMPT = ("photo of a city street at midnight, dark night, deep blue "
                "night sky, scene lit only by orange streetlights and car "
                "headlights, photorealistic live-action dashcam footage, "
                "hyper realism, keep every object and its position")
NEGATIVE = ("cgi, cartoon, 3d render, low poly, video game, computer graphics, "
            "daytime, bright sky, sun, blue sky, illustration")

W, H = 736, 416  # matches fl2va target short_edge 416, aspect 16:9


def mean_lum(img: Image.Image) -> float:
    return float(np.asarray(img.convert("L"), dtype=np.float32).mean())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="stabilityai/sd-turbo")
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--seed", type=int, default=44)
    ap.add_argument("--night", action="store_true",
                    help="night-heavy prompt + CFG on all variants")
    ap.add_argument("--strengths", type=float, nargs="+",
                    default=[0.45, 0.60, 0.75])
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    from diffusers import StableDiffusionImg2ImgPipeline
    pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, safety_checker=None,
        requires_safety_checker=False).to("cuda")
    pipe.set_progress_bar_config(disable=True)

    if args.night:
        variants = [(f"n_s{int(s*100)}", s, 7.5, NEGATIVE)
                    for s in args.strengths]
        prompt = NIGHT_PROMPT
    else:
        variants = []
        for s in args.strengths:
            variants.append((f"s{int(s*100)}", s, 0.0, None))
            variants.append((f"s{int(s*100)}cfg", s, 7.5, NEGATIVE))
        prompt = PROMPT

    manifest = {}
    for path in args.frames:
        name = os.path.splitext(os.path.basename(path))[0]
        init = Image.open(path).convert("RGB").resize((W, H), Image.LANCZOS)
        tag = "first" if "frame0" in name else "last"
        manifest[tag] = {"source_lum": round(mean_lum(init), 2)}

        for vtag, strength, gs, neg in variants:
            g = torch.Generator("cuda").manual_seed(args.seed)
            out = pipe(prompt=prompt, negative_prompt=neg, image=init,
                       strength=strength, num_inference_steps=args.steps,
                       guidance_scale=gs, generator=g).images[0]
            fn = f"{tag}_{vtag}.png"
            out.save(os.path.join(args.out, fn))
            lum = round(mean_lum(out), 2)
            manifest[tag][vtag] = {
                "file": fn, "strength": strength, "guidance_scale": gs,
                "lum": lum}
            print(tag, vtag, "lum", lum, flush=True)

    mpath = os.path.join(args.out, "restyle_manifest.json")
    merged = {}
    if os.path.isfile(mpath):
        merged = json.load(open(mpath))
    merged.update(manifest)
    with open(mpath, "w") as f:
        json.dump(merged, f, indent=2)


if __name__ == "__main__":
    main()
