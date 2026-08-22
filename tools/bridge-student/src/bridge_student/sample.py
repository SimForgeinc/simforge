"""Generate sample outputs from a trained bridge-student checkpoint.

Produces per-frame comparison strips: [semantic | depth | target | student]
at 1..N inference steps, for chosen clips/frames.

  python -m bridge_student.sample --ckpt runs/v0-proof/ckpt \
      --clips-root ~/w0-data/clips-pov --out runs/v0-proof/samples-eval \
      --clips bus-stop-emergence workzone-lane-shift --steps 1 2 4
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import torch
from PIL import Image
from diffusers import ControlNetModel, DDIMScheduler
from .dataset import BridgePairDataset
from .model import build_controlnet, encode_prompt, load_base


def parse_args(argv=None):
    p = argparse.ArgumentParser()


    p.add_argument("--clips-root", required=True)
    p.add_argument("--teacher-root", default=None)
    p.add_argument("--out", required=True)
    p.add_argument("--base", default="stabilityai/sd-turbo")
    p.add_argument("--prompt", default="photorealistic dashcam footage of an urban street")
    p.add_argument("--clips", nargs="*", default=None)
    p.add_argument("--frames", type=int, nargs="*", default=[10, 30, 50])
    p.add_argument("--steps", type=int, nargs="*", default=[1, 2, 4])
    p.add_argument("--res", type=int, default=384)
    p.add_argument("--seed", type=int, default=20260822)
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    device = "cuda"
    os.makedirs(args.out, exist_ok=True)
    controlnet = build_controlnet(unet).to(device, dtype=torch.float16)
    state = ControlNetModel.from_pretrained(args.ckpt).state_dict()
    controlnet.load_state_dict(state)
    controlnet = controlnet.eval()

    sched = DDIMScheduler.from_config(args.base, subfolder="scheduler", timestep_spacing="trailing")
    prompt_emb = encode_prompt(text_encoder, tokenizer, args.prompt, device)

    ds = BridgePairDataset(clips_root=args.clips_root, teacher_root=args.teacher_root,
                           resolution=args.res)
    by_clip = {}
    for i, (clip, idx, has_t) in enumerate(ds.index.items):
        if clip not in by_clip:
            by_clip[clip] = {}
        by_clip[clip][idx] = i

    gen = torch.Generator(device=device); gen.manual_seed(args.seed)
    clips = args.clips or sorted(by_clip.keys())
    for clip in clips:
        for fidx in args.frames:
            item = by_clip.get(clip, {}).get(fidx)
            if item is None:
                continue
            b = ds[item]
            cond = b["cond"].unsqueeze(0).to(device, dtype=torch.float16)
            target = b["target"].unsqueeze(0).to(device, dtype=torch.float16)
            lat_shape = (1, unet.config.in_channels, args.res // 8, args.res // 8)
            row = []
            c = cond[0].float().cpu()
            sem = (c[1:4].permute(1, 2, 0).numpy() * 255).astype(np.uint8)
            dep = (c[0].numpy()[..., None].repeat(3, -1) * 255).astype(np.uint8)
            tgt_u8 = ((target[0].float().cpu().permute(1, 2, 0).numpy() * 0.5 + 0.5) * 255).astype(np.uint8)
            for n_steps in args.steps:
                sched.set_timesteps(n_steps, device=device)
                latents = torch.randn(lat_shape, device=device, dtype=torch.float16, generator=gen) * sched.init_noise_sigma
                ehs = prompt_emb.expand(1, -1, -1).to(torch.float16)
                for t in sched.timesteps:
                    ts = t.expand(1)
                    with torch.no_grad():
                        down, mid = controlnet(latents, timestep=ts, encoder_hidden_states=ehs,
                                               controlnet_cond=cond, return_dict=False)
                        noise = unet(latents, timestep=ts, encoder_hidden_states=ehs,
                                     down_block_additional_residuals=[r.to(latents.dtype) for r in down],
                                     mid_block_additional_residual=mid.to(latents.dtype),
                                     return_dict=False)[0]
                    latents = sched.step(noise.float(), t, latents.float()).prev_sample.to(torch.float16)
                with torch.no_grad():
                    img = vae.decode(latents / vae.config.scaling_factor).sample
                img_u8 = ((img[0].float().cpu().permute(1, 2, 0).numpy() * 0.5 + 0.5).clip(0, 1) * 255).astype(np.uint8)
                row.append(img_u8)
            strip = np.concatenate([sem, dep, tgt_u8] + row, axis=1)
            out_path = os.path.join(args.out, f"{clip}_f{fidx:05d}.png")
            Image.fromarray(strip).save(out_path)
            print("wrote", out_path, flush=True)


if __name__ == "__main__":
    main()
