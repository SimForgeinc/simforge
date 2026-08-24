"""Single GRPO-style optimizer-step footprint probe (QLoRA, any HF VLM).

Measures, per (model, group size N):
  peak allocated/reserved VRAM and wall time of one full step =
    generate N completions (HF generate) -> teacher-forced policy logprobs ->
    GRPO loss (group-normalized advantages, beta=0 no separate ref model) ->
    backward -> AdamW step on LoRA params.

Mirrors GRPOTrainer(use_vllm=False, beta=0) memory behavior without needing
per-model TRL integration, so 3B/7B/~10B footprints are comparable.
`sweep` runs an OOM-aware ladder + bisection in one process per model.
"""
from __future__ import annotations

import argparse
import gc
import json
import time

import torch
from PIL import Image

DEFAULT_PROMPT = (
    "You are planning for an autonomous vehicle. The image is the front dashcam view. "
    "Predict the ego trajectory for the next 3 seconds as 7 waypoints in the ego frame "
    "(x forward, y left, meters). Answer ONLY with waypoints like <0.00,0.00> <x.xx,y.yy>.")


def cleanup() -> None:
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.ipc_collect()


class ModelCtx:
    def __init__(self, model_id: str):
        from peft import LoraConfig, get_peft_model
        from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

        self.model_id = model_id
        self.device = "cuda:0"
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
        self.processor = AutoProcessor.from_pretrained(model_id, padding_side="left")
        model = AutoModelForImageTextToText.from_pretrained(
            model_id, quantization_config=quant, dtype=torch.bfloat16,
            attn_implementation="sdpa", device_map={"": self.device},
        )
        lora = LoraConfig(
            r=32, lora_alpha=64, lora_dropout=0.0, bias="none",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
            task_type="CAUSAL_LM",
        )
        self.model = get_peft_model(model, lora)
        self.pad_id = self.processor.tokenizer.pad_token_id or self.processor.tokenizer.eos_token_id
        # Poutine keeps the vision encoder frozen at RL time; freezing also
        # drops its autograd graph. Gradient checkpointing only engages when
        # module.training is True, so the update phase must call .train().
        base = self.model.base_model.model
        vis = getattr(base, "visual", None) or getattr(getattr(base, "model", base), "visual", None)
        if vis is not None:
            for p in vis.parameters():
                p.requires_grad_(False)
            vis.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})


def measure_step(ctx: ModelCtx, image_path: str, prompt_text: str,
                 group_size: int, completion_tokens: int, seed: int = 0) -> dict:
    """One generate -> loss -> backward -> optimizer step cycle. Raises on OOM."""
    torch.manual_seed(seed)
    device = ctx.device
    model, processor = ctx.model, ctx.processor

    images = [Image.open(image_path).convert("RGB") for _ in range(group_size)]
    messages = [[{"role": "user", "content": [
        {"type": "image"}, {"type": "text", "text": prompt_text}]}]] * group_size
    prompts_text = [
        processor.apply_chat_template(m, tokenize=False, add_generation_prompt=True)
        for m in messages
    ]
    enc = processor(text=prompts_text, images=images, return_tensors="pt", padding=True)
    enc = {k: v.to(device) if hasattr(v, "to") else v for k, v in enc.items()}
    plen = enc["input_ids"].shape[1]

    t0 = time.perf_counter()
    torch.cuda.reset_peak_memory_stats(device)

    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=completion_tokens,
                             do_sample=True, temperature=1.0, top_p=1.0,
                             pad_token_id=ctx.pad_id)
    gen_time = time.perf_counter() - t0
    comp_ids = out[:, plen:]

    t1 = time.perf_counter()
    model.train()   # gradient checkpointing only engages in training mode
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    try:
        full_ids = torch.cat([enc["input_ids"], comp_ids], dim=1)
        attn = torch.cat([enc["attention_mask"], torch.ones_like(comp_ids)], dim=1)

        # Full forward over prompt(+expanded image tokens)+completion. Qwen/GLM
        # processors expand image placeholders inside input_ids, so the merged
        # ids are directly consumable by model.forward.
        # GLM-style models need mm_token_type_ids for M-RoPE; completions are
        # pure text, so their columns are 0.
        extra = {}
        if "mm_token_type_ids" in enc:
            mtt = enc["mm_token_type_ids"]
            extra["mm_token_type_ids"] = torch.cat(
                [mtt, torch.zeros(mtt.shape[0], comp_ids.shape[1],
                                  dtype=mtt.dtype, device=device)], dim=1)
        outputs = model(input_ids=full_ids, attention_mask=attn,
                        pixel_values=enc.get("pixel_values"),
                        image_grid_thw=enc.get("image_grid_thw"),
                        use_cache=False, **extra)
        logits = outputs.logits[:, :-1, :]
        labels = full_ids[:, 1:].clone()
        labels[~attn[:, 1:].bool()] = -100
        labels[:, : comp_ids.shape[1] - 1] = -100   # supervise completion only

        # Memory-matched to TRL's selective log-softmax: logsumexp keeps only
        # the bf16 logits alive (no full-vocab fp32 copy), so probe OOM
        # boundaries track GRPOTrainer footprints.
        lse = torch.logsumexp(logits, dim=-1)
        token_lp = logits.gather(2, labels.clamp(min=0).unsqueeze(-1)).squeeze(-1) - lse
        token_lp = token_lp.float()
        valid = labels != -100
        seq_lp = (token_lp * valid).sum(dim=1)

        gen = torch.Generator(device=device)
        gen.manual_seed(seed)
        adv = torch.randn(group_size, generator=gen, device=device)
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        loss = (-adv.detach() * seq_lp).mean()
        loss.backward()

        opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-6)
        opt.step()
        opt.zero_grad(set_to_none=True)
    finally:
        model.zero_grad(set_to_none=True)
    upd_time = time.perf_counter() - t1

    metrics = {
        "model": ctx.model_id,
        "group_size": group_size,
        "completion_tokens_target": completion_tokens,
        "prompt_len": plen,
        "gen_peak_alloc_gib": round((torch.cuda.max_memory_allocated(device)) / 2**30, 2),
        "step_peak_alloc_gib": round(torch.cuda.max_memory_allocated(device) / 2**30, 2),
        "step_peak_reserved_gib": round(torch.cuda.max_memory_reserved(device) / 2**30, 2),
        "gen_time_s": round(gen_time, 2),
        "update_time_s": round(upd_time, 2),
        "step_time_s": round(time.perf_counter() - t0, 2),
        "oom": False,
    }
    # free autograd graph before next ladder point
    model.zero_grad(set_to_none=True)
    cleanup()
    return metrics


def sweep(model_id: str, image_path: str, prompt_text: str, completion_tokens: int,
          fixed_prompts_group: int | None, lo: int, hi: int) -> dict:
    """Bisect the largest feasible size in [lo, hi]; `fixed_prompts_group`
    None => vary group size N at P=1; else vary prompts P at G=fixed."""
    results: list[dict] = []
    best_ok = None
    first_fail = None

    def attempt(n: int) -> dict:
        m = measure_step(ctx, image_path, prompt_text, n, completion_tokens)
        if fixed_prompts_group is None:
            m["group_size"] = n
        else:
            m["prompts"] = n
            m["group_size"] = fixed_prompts_group
        results.append(m)
        print(json.dumps(m), flush=True)
        return m

    ctx = ModelCtx(model_id)
    # exponential ramp from lo until failure or hi
    n = lo
    last_ok = None
    while n <= hi:
        try:
            m = attempt(n)
            last_ok = n
            best_ok = m
        except torch.cuda.OutOfMemoryError:
            first_fail = n
            break
        if n == hi:
            break
        n = min(hi, n * 2 if n > lo else lo * 2)
    if first_fail is None:
        first_fail = None  # never OOMed within [lo, hi]
    elif last_ok is not None and first_fail - last_ok > 1:
        a, b = last_ok, first_fail
        while b - a > 1:
            mid = (a + b) // 2
            try:
                attempt(mid)
                a = mid
                best_ok = _last_of(results)
            except torch.cuda.OutOfMemoryError:
                b = mid
        first_fail = b
    key = "group_size" if fixed_prompts_group is None else "prompts"
    return {"model": model_id, "mode": "max_N_at_P1" if fixed_prompts_group is None else f"max_P_at_G{fixed_prompts_group}",
            "feasible_max": last_ok, "first_oom": first_fail, "points": results}


def _last_of(results):
    return results[-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--prompt-text", default=DEFAULT_PROMPT)
    ap.add_argument("--completion-tokens", type=int, default=100)
    ap.add_argument("--mode", choices=["single", "sweep-N", "sweep-P"], default="single")
    ap.add_argument("--group-size", type=int, default=8, help="single mode")
    ap.add_argument("--lo", type=int, default=4)
    ap.add_argument("--hi", type=int, default=256)
    ap.add_argument("--fixed-group", type=int, default=8, help="G for sweep-P")
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    def emit(obj: dict) -> None:
        print(json.dumps(obj))
        if args.json_out:
            with open(args.json_out, "a") as f:
                f.write(json.dumps(obj) + "\n")

    if args.mode == "single":
        ctx = ModelCtx(args.model)
        try:
            emit(measure_step(ctx, args.image, args.prompt_text,
                              args.group_size, args.completion_tokens))
        except torch.cuda.OutOfMemoryError as e:
            cleanup()
            emit({"model": args.model, "group_size": args.group_size, "oom": True,
                  "error": str(e)[:200]})
    else:
        res = sweep(args.model, args.image, args.prompt_text, args.completion_tokens,
                    fixed_prompts_group=args.fixed_group if args.mode == "sweep-P" else None,
                    lo=args.lo, hi=args.hi)
        emit(res)


if __name__ == "__main__":
    main()
