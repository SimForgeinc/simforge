"""Few-step conditional student: frozen few-step diffusion base + ControlNet.

Established baseline (plan WS3 item 3, per-frame stage): a frozen CFG-distilled
few-step base (SD-turbo class, 1-4 step inference) steered by a ControlNet
conditioned on our 6-channel G-buffer stack. The teacher frame is the RGB style
target; geometry authority is pinned by the conditioning (MoVieDrive/CoGen/
Panacea pattern of dense multi-modal conditioning).

Conditioning channels (fixed contract):
  0 depth/max_depth   1-3 semantic palette rgb   4 instance norm   5 valid mask
"""

from __future__ import annotations

import inspect

import torch
from diffusers import AutoencoderKL, ControlNetModel, UNet2DConditionModel
from transformers import CLIPTextModel, CLIPTokenizer

CONDITION_CHANNELS = 6


def load_base(base_id: str = "stabilityai/sd-turbo", device: str = "cuda", dtype=torch.float16):
    unet = UNet2DConditionModel.from_pretrained(base_id, subfolder="unet").to(device, dtype=dtype)
    vae = AutoencoderKL.from_pretrained(base_id, subfolder="vae").to(device, dtype=dtype)
    text_encoder = CLIPTextModel.from_pretrained(base_id, subfolder="text_encoder").to(
        device, dtype=dtype
    )
    tokenizer = CLIPTokenizer.from_pretrained(base_id, subfolder="tokenizer")
    unet.requires_grad_(False)
    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)
    return unet, vae, text_encoder, tokenizer


def build_controlnet(unet: UNet2DConditionModel) -> ControlNetModel:
    """ControlNet mirroring the base UNet's blocks, with our condition stack."""
    sig = inspect.signature(ControlNetModel.__init__).parameters
    raw = dict(unet.config)
    cfg = {
        k: v for k, v in raw.items()
        if k in sig and k not in {"self", "kwargs"}
    }
    cfg["conditioning_channels"] = CONDITION_CHANNELS
    cfg["conditioning_embedding_out_channels"] = (16, 32, 96, 320)
    return ControlNetModel(**cfg)


@torch.no_grad()
def encode_prompt(text_encoder, tokenizer, prompt: str, device: str = "cuda"):
    ids = tokenizer(
        [prompt], padding="max_length", max_length=tokenizer.model_max_length,
        truncation=True, return_tensors="pt",
    ).input_ids.to(device)
    return text_encoder(ids)[0]


def controlnet_forward(controlnet, unet, latents, timesteps, encoder_hidden_states, cond):
    """One training forward through ControlNet + frozen UNet."""
    down_block_res, mid_block_res = controlnet(
        latents,
        timestep=timesteps,
        encoder_hidden_states=encoder_hidden_states,
        controlnet_cond=cond,
        return_dict=False,
    )
    noise_pred = unet(
        latents,
        timestep=timesteps,
        encoder_hidden_states=encoder_hidden_states,
        down_block_additional_residuals=[
            r.to(dtype=latents.dtype) for r in down_block_res
        ],
        mid_block_additional_residual=mid_block_res.to(dtype=latents.dtype),
        return_dict=False,
    )[0]
    return noise_pred
