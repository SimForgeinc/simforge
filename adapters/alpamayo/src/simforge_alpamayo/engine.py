"""Alpamayo 1.5 engine: pinned, quantized, fully GPU-resident.

Quantization recipe (load-time, reproducible — no serialized artifact needed):

* ``nf4``  (default): bitsandbytes 4-bit NF4 + double quantization, bf16 compute.
  Quantizes every nn.Linear in the Cosmos-Reason2 VLM *and* the diffusion
  action expert. Kept in bf16: vision tower (``visual``), token embeddings,
  ``lm_head``, action projections, diffusion head — small and/or sensitive.
* ``fp8``: torchao Float8WeightOnlyConfig (e4m3), same skip list.
* ``bf16``: no quantization (does NOT fit on a 16 GB card; CPU/debug only).

Cosmos-Reason2-8B (gated: auto) supplies only config.json + tokenizer; every
weight comes from the ungated Alpamayo checkpoint. Both are pinned in
``simforge_alpamayo.PINS``.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

os.environ.setdefault("HF_HOME", os.path.expanduser("~/simforge-assets/hf-cache"))
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch  # noqa: E402

from simforge_alpamayo import PINS  # noqa: E402
from simforge_alpamayo.obs import decode_observation  # noqa: E402

logger = logging.getLogger("simforge_alpamayo.engine")

# Modules kept un-quantized (name fragments, matched by HF quantizer plumbing).
SKIP_MODULES = [
    "visual",          # vision tower: sensitive, comparatively small
    "lm_head",
    "embed_tokens",
    "action_in_proj",
    "action_out_proj",
    "diffusion",
]

# FP8 constraints on a 16 GB card (torchao 0.12 weight-only fallback path
# dequantizes with an fp32 scale expanded to the full weight shape):
# * lm_head MUST stay bf16 — its fp8 dequant would expand a 2.4 GB fp32
#   scale every forward step.
# * the vision tower IS quantized (unlike NF4) to claw back ~0.6 GB;
#   without it the weights (~13 GB) leave no activation headroom.
FP8_SKIP_MODULES = [
    "lm_head",
    "embed_tokens",
    "action_in_proj",
    "action_out_proj",
    "diffusion",
]

MIN_PIXELS = 163840
MAX_PIXELS = 196608


def _quant_config(quant: str):
    if quant == "nf4":
        from transformers import BitsAndBytesConfig

        return BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
            llm_int8_skip_modules=SKIP_MODULES,
        )
    if quant in ("fp8", "bf16"):
        return None
    raise ValueError(f"unknown quant mode: {quant}")


class AlpamayoEngine:
    """Long-lived Alpamayo 1.5 inference engine."""

    def __init__(self, quant: str = "nf4", device: str = "cuda"):
        self.quant = quant
        self.device = device
        self.model = None
        self.processor = None
        self.warmed = False
        self.load_seconds: float | None = None

    # -- loading ------------------------------------------------------------

    def load(self) -> None:
        from huggingface_hub import hf_hub_download, snapshot_download

        t0 = time.monotonic()

        # Pin the gated Cosmos repo snapshot (config + tokenizer only).
        cosmos_dir = snapshot_download(
            PINS["cosmos_repo"],
            revision=PINS["cosmos_revision"],
            allow_patterns=[
                "config.json",
                "generation_config.json",
                "tokenizer*",
                "vocab*",
                "merges*",
                "special_tokens_map.json",
                "preprocessor_config.json",
                "video_preprocessor_config.json",
                "chat_template*",
            ],
        )
        proc_dir = snapshot_download(
            PINS["processor_repo"],
            revision=PINS["processor_revision"],
            allow_patterns=[
                "preprocessor_config.json",
                "video_preprocessor_config.json",
                "tokenizer*",
                "vocab*",
                "merges*",
                "special_tokens_map.json",
                "chat_template*",
                "config.json",
            ],
        )

        from simforge_alpamayo import require_vendored

        require_vendored()
        from alpamayo1_5.config import Alpamayo1_5Config
        from alpamayo1_5.models.alpamayo1_5 import Alpamayo1_5
        from transformers import AutoProcessor

        cfg_path = hf_hub_download(
            PINS["model_repo"], "config.json", revision=PINS["model_revision"]
        )
        with open(cfg_path) as f:
            cfg_dict = json.load(f)
        cfg_dict["vlm_name_or_path"] = cosmos_dir
        cfg_dict["attn_implementation"] = "sdpa"  # no flash-attn build required
        config = Alpamayo1_5Config(**cfg_dict)

        qcfg = _quant_config(self.quant)
        kwargs: dict[str, Any] = dict(
            revision=PINS["model_revision"],
            config=config,
            dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        if qcfg is not None:
            kwargs["quantization_config"] = qcfg
            kwargs["device_map"] = {"": 0}  # whole model on GPU 0 — no offload

        logger.info("loading %s [%s]...", PINS["model_repo"], self.quant)
        model = Alpamayo1_5.from_pretrained(PINS["model_repo"], **kwargs)
        if self.quant == "fp8":
            # torchao's on-the-fly GPU quantization spikes ~2.4 GB transients
            # (scale expansion on lm_head-sized tensors) and OOMs a 16 GB
            # card. Quantize on CPU instead — identical numerics — then move
            # the already-quantized model to the GPU in one pass.
            import torch.nn as nn
            from torchao.quantization import Float8WeightOnlyConfig, quantize_

            def _fp8_filter(module: torch.nn.Module, fqn: str) -> bool:
                return isinstance(module, nn.Linear) and not any(
                    skip in fqn for skip in FP8_SKIP_MODULES
                )

            logger.info("quantizing to fp8 (e4m3, weight-only) on CPU...")
            quantize_(model, Float8WeightOnlyConfig(), filter_fn=_fp8_filter)
        if qcfg is None and self.device == "cuda":
            model = model.to("cuda")
        model.eval()

        # Invariants: the substituted/pinned tokenizer must reproduce the ids
        # baked into the Alpamayo checkpoint.
        tok = model.tokenizer
        assert len(tok) == config.vocab_size, (len(tok), config.vocab_size)
        assert tok.convert_tokens_to_ids("<i0>") == config.traj_token_start_idx
        for name, tid in config.traj_token_ids.items():
            got = tok.traj_token_ids[name]
            assert got == tid, (name, got, tid)

        processor = AutoProcessor.from_pretrained(
            proc_dir, min_pixels=MIN_PIXELS, max_pixels=MAX_PIXELS
        )
        processor.tokenizer = tok

        self.model = model
        self.processor = processor
        self.load_seconds = time.monotonic() - t0
        logger.info("model loaded in %.1fs", self.load_seconds)

    # -- inference ----------------------------------------------------------

    @torch.no_grad()
    def act(
        self,
        obs: dict[str, Any],
        seed: int = 0,
        top_p: float = 0.98,
        temperature: float = 0.6,
        num_traj_samples: int = 1,
        max_generation_length: int = 256,
        num_diffusion_steps: int | None = None,
    ) -> dict[str, Any]:
        """Run one closed-loop step: observation -> trajectory + reasoning."""
        if self.model is None:
            raise RuntimeError("engine not loaded")
        from alpamayo1_5 import helper

        timings: dict[str, float] = {}
        t_start = time.monotonic()

        decoded = decode_observation(obs)
        messages = helper.create_message(
            frames=decoded["frames"],
            camera_indices=decoded["camera_indices"],
            nav_text=decoded["nav_text"],
        )
        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=False,
            continue_final_message=True,
            return_dict=True,
            return_tensors="pt",
        )
        model_inputs = helper.to_device(
            {
                "tokenized_data": inputs,
                "ego_history_xyz": decoded["ego_history_xyz"],
                "ego_history_rot": decoded["ego_history_rot"],
            },
            self.device,
        )
        torch.cuda.synchronize()
        timings["preprocess_ms"] = (time.monotonic() - t_start) * 1e3

        # Deterministic seeding: generation + diffusion noise both consume the
        # global RNG streams.
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)

        diffusion_kwargs = {}
        if num_diffusion_steps is not None:
            diffusion_kwargs["inference_step"] = int(num_diffusion_steps)

        t_infer = time.monotonic()
        with torch.autocast("cuda", dtype=torch.bfloat16):
            pred_xyz, pred_rot, extra = self.model.sample_trajectories_from_data_with_vlm_rollout(
                data=model_inputs,
                top_p=top_p,
                temperature=temperature,
                num_traj_samples=num_traj_samples,
                max_generation_length=max_generation_length,
                diffusion_kwargs=diffusion_kwargs,
                return_extra=True,
            )
        torch.cuda.synchronize()
        timings["inference_ms"] = (time.monotonic() - t_infer) * 1e3
        timings["total_ms"] = (time.monotonic() - t_start) * 1e3

        # pred_xyz: (B=1, ns=1, nj, 64, 3); cot: [B, ns, nj]
        traj = pred_xyz[0, 0].float().cpu().numpy()  # (nj, 64, 3)
        cot = [str(c) for c in extra["cot"][0, 0]]
        del pred_rot

        return {
            "trajectories": traj.tolist(),
            "horizon_s": 6.4,
            "dt_s": 0.1,
            "frame": "ego@t0",
            "reasoning": cot,
            "seed": seed,
            "timings": timings,
            "vram": self.vram(),
        }

    # -- introspection --------------------------------------------------------

    def vram(self) -> dict[str, float]:
        if not torch.cuda.is_available():
            return {}
        free, total = torch.cuda.mem_get_info()
        return {
            "allocated_mb": torch.cuda.memory_allocated() / 2**20,
            "reserved_mb": torch.cuda.memory_reserved() / 2**20,
            "peak_allocated_mb": torch.cuda.max_memory_allocated() / 2**20,
            "device_used_mb": (total - free) / 2**20,
            "device_total_mb": total / 2**20,
        }

    def reset_peak(self) -> None:
        torch.cuda.reset_peak_memory_stats()

    def info(self) -> dict[str, Any]:
        return {
            "service": "simforge-alpamayo",
            "quant": self.quant,
            "pins": PINS,
            "loaded": self.model is not None,
            "warmed": self.warmed,
            "load_seconds": self.load_seconds,
            "torch": torch.__version__,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
