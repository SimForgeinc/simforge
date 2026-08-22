"""Train the WS3 bridge student v0.

Per-frame stage of plan WS3 item 3: frozen few-step base (sd-turbo) + ControlNet
on trace-derived G-buffer conditioning; RGB target = teacher translation frame
when available, else the render frame (render-only mode is license-safe and
used for the proof-of-scale run).

Usage (see README for full paths):
  python -m bridge_student.train --clips-root ~/w0-data/clips-pov \
      [--teacher-root ~/ws3-bridge/teacher-frames] --out runs/v0-proof \
      --steps 1500 --batch 4 --res 384
"""

from __future__ import annotations

import argparse
import json
import os
import random
import time

import numpy as np
import torch
from PIL import Image

from .dataset import BridgePairDataset, split_index
from .model import build_controlnet, controlnet_forward, encode_prompt, load_base


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--clips-root", required=True)
    p.add_argument("--teacher-root", default=None)
    p.add_argument("--val-clips", nargs="*", default=["bus-stop-emergence", "workzone-lane-shift"])
    p.add_argument("--out", required=True)
    p.add_argument("--base", default="stabilityai/sd-turbo")
    p.add_argument("--prompt", default="photorealistic dashcam footage of an urban street")
    p.add_argument("--steps", type=int, default=1500)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--res", type=int, default=384)
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--log-interval", type=int, default=10)
    p.add_argument("--sample-interval", type=int, default=250)
    p.add_argument("--ckpt-interval", type=int, default=500)
    p.add_argument("--timestep-mode", choices=["uniform", "low"], default="uniform",
                   help="low biases timesteps toward the low-sigma regime used by 1-4 step inference")
    p.add_argument("--seed", type=int, default=20260822)
    p.add_argument("--cache-dir", default=None)
    p.add_argument("--require-teacher", action="store_true")
    p.add_argument("--num-inference-steps", type=int, default=4,
                   help="steps used for preview sampling during training")
    return p.parse_args(argv)


def set_seed(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


@torch.no_grad()
def encode_images(vae, images: torch.Tensor) -> torch.Tensor:
    """images in [-1,1], (B,3,H,W) -> latents scaled."""
    posterior = vae.encode(images).latent_dist.sample()
    return posterior * vae.config.scaling_factor


@torch.no_grad()
def decode_latents(vae, latents: torch.Tensor) -> torch.Tensor:
    latents = latents / vae.config.scaling_factor
    return vae.decode(latents).sample


def make_preview_grid(images: torch.Tensor, conds: torch.Tensor, targets: torch.Tensor) -> Image.Image:
    def to_u8(t):
        x = ((t.float().cpu() * 0.5 + 0.5).clamp(0, 1).numpy().transpose(0, 2, 3, 1) * 255)
        return x.astype(np.uint8)
    pred = to_u8(images)
    tgt = to_u8(targets)
    rows = []
    for i in range(min(len(pred), 4)):
        c = conds[i].float().cpu()
        depth = (c[0].numpy() * 255).astype(np.uint8)
        sem = (c[1:4].permute(1, 2, 0).numpy() * 255).astype(np.uint8)
        d3 = np.stack([depth] * 3, axis=-1)
        row = np.concatenate([sem, d3, tgt[i], pred[i]], axis=1)
        rows.append(row)
    return Image.fromarray(np.concatenate(rows, axis=0))


def sample_preview(controlnet, unet, vae, prompt_emb, batch, args, device, generator):
    """Few-step deterministic preview using the frozen base's scheduler family."""
    from diffusers import DDIMScheduler

    sched = DDIMScheduler.from_config(
        "stabilityai/sd-turbo", subfolder="scheduler",
        timestep_spacing="trailing", rescale_betas_zero_snr=False,
    )
    sched.set_timesteps(args.num_inference_steps, device=device)
    latents = torch.randn(
        (batch["cond"].shape[0], unet.config.in_channels,
         batch["target"].shape[2] // 8, batch["target"].shape[3] // 8),
        device=device, dtype=torch.bfloat16, generator=generator,
    )
    latents = latents * sched.init_noise_sigma
    cond = batch["cond"].to(device=device, dtype=torch.bfloat16)
    encoder_hidden_states = prompt_emb.expand(latents.shape[0], -1, -1).to(torch.bfloat16)
    for t in sched.timesteps:
        timesteps = t.expand(latents.shape[0])
        with torch.no_grad():
            down, mid = controlnet(latents, timestep=timesteps,
                                   encoder_hidden_states=encoder_hidden_states,
                                   controlnet_cond=cond, return_dict=False)
            noise = unet(latents, timestep=timesteps,
                         encoder_hidden_states=encoder_hidden_states,
                         down_block_additional_residuals=[r.to(latents.dtype) for r in down],
                         mid_block_additional_residual=mid.to(latents.dtype),
                         return_dict=False)[0]
        latents = sched.step(noise.to(torch.float32), t, latents.to(torch.float32)).prev_sample.to(torch.bfloat16)
    imgs = decode_latents(vae, latents.float())
    return (imgs / 2 + 0.5).clamp(0, 1)


def main(argv=None):
    args = parse_args(argv)
    set_seed(args.seed)
    device = "cuda"
    dtype = torch.float16
    os.makedirs(args.out, exist_ok=True)
    samples_dir = os.path.join(args.out, "samples")
    ckpt_dir = os.path.join(args.out, "ckpt")
    os.makedirs(samples_dir, exist_ok=True)
    os.makedirs(ckpt_dir, exist_ok=True)

    ds = BridgePairDataset(
        clips_root=args.clips_root, teacher_root=args.teacher_root,
        resolution=args.res, cache_dir=args.cache_dir,
        require_teacher=args.require_teacher,
    )
    train_ds, val_ds = split_index(ds.index, set(args.val_clips))
    # rebuild datasets with filtered indices
    ds.index.items = train_ds.items
    print(f"pairs total={len(ds.index.items)} (train), val={len(val_ds.items)}", flush=True)

    loader = torch.utils.data.DataLoader(
        ds, batch_size=args.batch, shuffle=True, num_workers=4, drop_last=True,
        pin_memory=True, persistent_workers=True,
    )

    unet, vae, text_encoder, tokenizer = load_base(args.base, device, dtype)
    controlnet = build_controlnet(unet).to(device, dtype=torch.float32)
    controlnet.train()

    prompt_emb = encode_prompt(text_encoder, tokenizer, args.prompt, device)

    opt = torch.optim.AdamW(controlnet.parameters(), lr=args.lr, weight_decay=1e-2)
    n_trainable = sum(p.numel() for p in controlnet.parameters() if p.requires_grad)
    print(f"trainable params: {n_trainable/1e6:.1f}M", flush=True)

    loss_path = os.path.join(args.out, "loss.jsonl")
    log_f = open(loss_path, "a")

    gen = torch.Generator(device=device); gen.manual_seed(args.seed)
    step, t_start = 0, time.time()
    running = []
    while step < args.steps:
        for batch in loader:
            if step >= args.steps:
                break
            target = batch["target"].to(device, non_blocking=True)
            cond = batch["cond"].to(device, non_blocking=True)
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                latents = encode_images(vae, target.to(dtype))
                noise = torch.randn_like(latents, dtype=torch.float32)
                if args.timestep_mode == "low":
                    # sqrt-uniform toward low sigmas (few-step regime)
                    u = torch.rand((latents.shape[0],), device=device)
                    ts = (u ** 2 * 980 + 20).long().clamp(0, 999)
                else:
                    ts = torch.randint(20, 981, (latents.shape[0],), device=device)
                noisy = (latents.float() + noise).to(dtype)
                ehs = prompt_emb.expand(latents.shape[0], -1, -1).to(dtype)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                pred = controlnet_forward(controlnet, unet, noisy, ts, ehs, cond.to(dtype))
                loss = torch.nn.functional.mse_loss(pred.float(), noise)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(controlnet.parameters(), 1.0)
            opt.step(); opt.zero_grad(set_to_none=True)

            running.append(loss.item()); step += 1
            if step % args.log_interval == 0:
                rec = {"step": step, "loss": float(np.mean(running)),
                       "lr": args.lr, "elapsed_s": round(time.time() - t_start, 1)}
                log_f.write(json.dumps(rec) + "\n"); log_f.flush()
                running = []
            if step % args.sample_interval == 0 or step == args.steps:
                controlnet.eval()
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    grid = sample_preview(controlnet, unet, vae, prompt_emb, batch, args, device, gen)
                grid_np = (grid.float().cpu().numpy().transpose(0, 2, 3, 1) * 255).astype(np.uint8)
                Image.fromarray(np.concatenate(list(grid_np), axis=1)).save(
                    os.path.join(samples_dir, f"step_{step:06d}.png"))
                controlnet.train()
            if step % args.ckpt_interval == 0 or step == args.steps:
                controlnet.save_pretrained(ckpt_dir, safe_serialization=True)

    meta = {
        "args": vars(args),
        "base": args.base,
        "condition_channels": 6,
        "train_pairs": len(ds.index.items),
        "final_step": step,
        "trainable_params_m": round(n_trainable / 1e6, 2),
    }
    with open(os.path.join(args.out, "run-meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("done:", args.out, flush=True)


if __name__ == "__main__":
    main()
