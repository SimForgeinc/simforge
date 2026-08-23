"""Poutine-shape GRPO smoke trainer (WS7): trajectory-only output, no CoT.

r = r_drive (exp(-ADE/scale) vs engine reference) + r_format ({0,1}),
per arXiv 2506.11234 eqs. 5-6. QLoRA (nf4 base + LoRA adapters).

Logs per-step metrics to <out>/metrics.jsonl:
  reward curve (drive/format decomposition), VRAM peak per GPU,
  wall-clock step time.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import time
from pathlib import Path

import torch
from datasets import Dataset

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("rewards", HERE / "rewards.py")
rewards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rewards)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-VL-3B-Instruct")
    ap.add_argument("--dataset", type=Path, default=HERE / "data" / "prompts.jsonl")
    ap.add_argument("--w0-root", type=Path, default=Path(os.environ.get("W0_ROOT", "/home/path/w0-data")))
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--split", choices=["train", "all"], default="train")
    ap.add_argument("--max-steps", type=int, default=60)
    ap.add_argument("--num-generations", type=int, default=8)
    ap.add_argument("--prompts-per-step", type=int, default=4)
    ap.add_argument("--max-completion-tokens", type=int, default=100)
    ap.add_argument("--learning-rate", type=float, default=5e-5)
    ap.add_argument("--beta", type=float, default=0.01, help="KL coef to frozen base (PEFT: adapter-disable trick)")
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--logging-steps", type=int, default=1)
    ap.add_argument("--save-adapter", action="store_true")
    return ap.parse_args()


def load_dataset(args) -> Dataset:
    rows = [json.loads(l) for l in open(args.dataset) if l.strip()]
    if args.split == "train":
        rows = [r for r in rows if r["split"] == "train"]
    for r in rows:
        img = str((args.w0_root / r["_image_rel"]).resolve())
        assert Path(img).is_file(), f"missing frame {img}"
        r["images"] = [img]          # TRL VLM convention
        r.pop("_image_rel")
    return Dataset.from_list(rows)


def main() -> None:
    args = parse_args()
    from trl import GRPOConfig, GRPOTrainer
    from transformers import AutoProcessor, BitsAndBytesConfig, TrainerCallback
    from peft import LoraConfig

    out = args.out_dir
    parts_log: list[dict] = []
    step_times: list[float] = []
    out.mkdir(parents=True, exist_ok=True)

    ds = load_dataset(args)
    (out / "run_config.json").write_text(json.dumps({**vars(args), "n_prompts": len(ds)}, default=str, indent=2))

    processor = AutoProcessor.from_pretrained(args.model, padding_side="left")

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    peft_config = LoraConfig(
        r=args.lora_r, lora_alpha=2 * args.lora_r, lora_dropout=0.0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
    )

    reward_fn = rewards.make_reward_fn(n_points=len(ds[0]["ref_traj"]))

    def wrapped_reward(prompts, completions, **kw):
        rs = reward_fn(prompts, completions, **kw)
        parts_log.extend(getattr(reward_fn, "last_parts", []))
        return rs

    class MetricsCB(TrainerCallback):
        """Per-step wall time + per-GPU VRAM peak -> metrics.jsonl."""

        def on_train_begin(self, a, s, control, **kw):
            self.t0 = time.perf_counter()
            return control

        def on_step_begin(self, a, s, control=None, **kw):
            torch.cuda.reset_peak_memory_stats()
            self.t0 = time.perf_counter()
            return control

        def on_log(self, a, s, control=None, logs=None, **kw):
            if logs is None:
                return control
            dt = time.perf_counter() - self.t0 if hasattr(self, "t0") else float("nan")
            step_times.append(dt)
            parts = [p for p in parts_log]
            n = max(1, len(parts))
            row = {
                "step": s.global_step,
                "wall_s": round(dt, 2),
                "vram_alloc_gib": {i: round(torch.cuda.max_memory_allocated(i) / 2**30, 2)
                                   for i in range(torch.cuda.device_count())},
                "vram_reserved_gib": {i: round(torch.cuda.max_memory_reserved(i) / 2**30, 2)
                                      for i in range(torch.cuda.device_count())},
                "reward_mean": round(sum(p["drive"] + p["format"] for p in parts) / n, 4),
                "drive_mean": round(sum(p["drive"] for p in parts) / n, 4),
                "format_rate": round(sum(p["format"] for p in parts) / n, 4),
                "raw": {k: v for k, v in logs.items() if isinstance(v, (int, float))},
            }
            with open(out / "metrics.jsonl", "a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"[step {row['step']}] r={row['reward_mean']} drive={row['drive_mean']} "
                  f"fmt={row['format_rate']} wall={row['wall_s']}s "
                  f"vram={list(row['vram_alloc_gib'].values())}GiB", flush=True)

    cfg = GRPOConfig(
        output_dir=str(out / "ckpt"),
        max_steps=args.max_steps,
        learning_rate=args.learning_rate,
        lr_scheduler_type="constant_with_warmup",
        warmup_steps=min(5, args.max_steps // 10),
        per_device_train_batch_size=args.prompts_per_step * args.num_generations,
        gradient_accumulation_steps=1,
        num_generations=args.num_generations,
        max_completion_length=args.max_completion_tokens,
        temperature=args.temperature,
        beta=args.beta,
        logging_steps=args.logging_steps,
        bf16=True,
        report_to=[],
        use_vllm=False,
        log_completions=False,
        seed=42,
    )
    cfg.model_init_kwargs = {
        "quantization_config": quant,
        "torch_dtype": torch.bfloat16,
        "attn_implementation": "sdpa",
    }

    trainer = GRPOTrainer(
        model=args.model,
        reward_funcs=[wrapped_reward],
        args=cfg,
        train_dataset=ds,
        processing_class=processor,
        peft_config=peft_config,
    )
    trainer.add_callback(MetricsCB())

    torch.cuda.reset_peak_memory_stats()
    t_start = time.perf_counter()
    trainer.train()
    total_s = time.perf_counter() - t_start

    summary = {
        "model": args.model,
        "total_train_seconds": round(total_s, 1),
        "steps": args.max_steps,
        "mean_step_seconds": round(sum(step_times[1:]) / max(1, len(step_times) - 1), 2),
        "peak_vram_alloc_gib": {i: round(torch.cuda.max_memory_allocated(i) / 2**30, 2)
                                for i in range(torch.cuda.device_count())},
    }
    if args.save_adapter:
        trainer.save_model(str(out / "adapter"))
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
