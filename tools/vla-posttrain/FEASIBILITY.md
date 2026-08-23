# WS7 ComputeDerisk — VLA post-training feasibility memo

Date: 2026-08-22 · Hardware: simforge1 (NVIDIA A100-SXM4-40GB, single-GPU runs,
CUDA 13.0 / torch 2.13 / transformers 5.15 / TRL 1.10) · Recipe shape:
[Poutine, arXiv 2506.11234](https://arxiv.org/abs/2506.11234)

**Question.** Can GRPO/QLoRA post-training of a VLA planner actually run on our
4×A100-40GB budget, at what batch/group sizes, and which model size should the
RL program target?

**Answer.** Yes. The full Poutine-shape GRPO loop ran end-to-end on real
UniScenarios data and *learned* within 53 steps. All three candidate model
sizes (3B, 7B, ~10B-class GLM-4.1V-9B) fit group size N=32 comfortably on one
shared A100-40GB; N=40 fits when the card is dedicated. Recommendation: **RL
time at 3B (Qwen2.5-VL-class)** — proven competitive by Poutine, cheapest per
step, leaves headroom for the WS2 faithfulness term — with **7B as a
drop-in scale-up** (same recipe, +1.5× step time) since it measurably fits.

---

## 1. What was run

- **Data.** 40 decision points from the real W0 dashcam-POV clip set
  (`~/w0-data/clips-pov`, 10 clips × 60 frames @12 fps, engine GT per frame):
  image + speed + intent → predict 7 ego-frame waypoints over 3 s
  (Δt = 0.5 s). Reference trajectories come from the engine trace ego poses.
  32 train / 8 eval prompts (`evidence/prompts.jsonl`).
- **Recipe (Poutine §3.3).** GRPO on trajectory-only output — no CoT at RL
  time. Reward `r = r_drive + r_format` with `r_drive = exp(-ADE/2m) ∈ [0,1]`
  (L2 to reference trajectory), `r_format ∈ {0,1}` (parses as exactly 7
  waypoints). QLoRA: nf4 double-quant base, LoRA r=32 α=64 on all attention +
  MLP projections of the language model, vision tower frozen.
- **Training config.** P=4 prompts × G=8 generations = 32 sequences/step,
  ≤100 completion tokens, lr 5e-5 (constant w/ warmup), KL β=0.01 vs frozen
  base via the PEFT adapter-disable trick, temperature 1.0.

## 2. Measured results

### 2.1 Real GRPO run — 53 optimizer steps (target ≥50)

`Qwen/Qwen2.5-VL-3B-Instruct`, single A100-40GB, evidence in
`evidence/grpo3b-r1.metrics.jsonl`. The run was terminated at step 53 by an
external kill on the shared host; all steps are real optimizer steps.

| step | reward | drive | format rate | wall s | VRAM alloc GiB |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.314 | 0.033 | 0.28 | 28.5 | 16.4 |
| 10 | 0.819 | 0.087 | 0.73 | 26.9 | 16.2 |
| 20 | 0.995 | 0.133 | 0.86 | 25.8 | 15.7 |
| 40 | 1.112 | 0.181 | 0.93 | 39.0 | 15.7 |
| 53 | 1.150 | 0.202 | 0.95 | 39.5 | 15.7 |

- Reward curve first-5 vs last-5 mean: **0.437 → 1.146**; drive term
  **0.039 → 0.200** (~5×); format compliance **28% → 95%**. The base model had
  never seen this output format — GRPO taught it, then improved ADE.
- Mean step time **33.5 s** (26–29 s early, ~39 s late — late-run slowdown
  tracks co-tenant GPU load, not our process).
- Peak VRAM: **16.7 GiB allocated / 18.9 GiB reserved** (includes 4-bit weights,
  LoRA optimizer state, KV cache for generation, one full update forward).
- Throughput: ≈ **82 completion tokens/s** per GPU inside training steps
  (≈2 770 completion tokens per 33.5 s step).

### 2.2 OOM boundary table — binary-searched group size N (P=1, ≤100 completion tokens)

Probe = generate N completions → teacher-forced policy logps (TRL-style
logsumexp, no fp32 vocab copy) → GRPO loss → backward → AdamW step, in-process
per model (`probe_step.py`). "Peak" = `torch.cuda.max_memory_allocated`.

| model | 4-bit weights | peak @ N=8 | peak @ N=32 | validated max N | first OOM |
|---|---|---:|---:|---:|---|
| Qwen2.5-VL-3B-Instruct | ~2.5 GiB | 7.5 GiB | 22.3 GiB | **40** (27.3 GiB) | by 48 |
| Qwen2.5-VL-7B-Instruct | ~6 GiB | 11.0 GiB | 26.3 GiB | **40** (31.4 GiB) | > 40 |
| GLM-4.1V-9B-Thinking (~10B class) | ~6.5 GiB | 11.8 GiB | 26.1 GiB | **40** (30.8 GiB) | > 40 |

Caveats, stated honestly:
- The first sweep pass ran while another tenant held ~6.5–7 GiB on the card;
  that pass reported an artificially sharp boundary (OOM at N=33). The table's
  N=40 points were re-measured on a quiet card; the 3B N=48 attempt OOMed even
  with ~38 GiB free, so the true 3B boundary is (40, 48].
- Probe footprints track the real trainer from above: TRL's actual step at 32
  sequences used 16.7 GiB vs the probe's 22.3 GiB at the same sequence count,
  because TRL chunks the logprob computation. Probe boundaries are therefore
  conservative.
- Raw probe records: `evidence/probe_{3B,7B,GLM9B}_N.jsonl`,
  `evidence/probe_refine.jsonl`.

### 2.3 Wall-clock projection for 100k decisions

A "decision" = one prompt → trajectory rollout (~87 completion tokens).
Measured rollout economics per A100-40GB:

| configuration | measured basis | decisions/s | 100k decisions |
|---|---|---:|---|
| HF-generate rollouts inside GRPO (as run) | N=32–40 gen phase ≈ 12–14 s ⇒ ~2.7 rollouts/s/GPU | 2.7 | **≈ 10 h rollout-only**; full GRPO over 100 k decisions (12 500 steps × 33.5 s) **≈ 4.9 GPU-days** |
| Same, 4×A100 data-parallel | ×4 | 10.9 | **≈ 1.2 days** |
| With vLLM colocated rollouts (TRL `use_vllm`, standard next step) | generation is 36–45% of step time today; vLLM typically 5–10× on decode | est. 13–27/s/GPU | **≈ 1–2 h rollout**, full GRPO ≈ 0.6–1.2 GPU-days |

Interpretation: 100 k GRPO decisions at 3B is a **days-scale, not
weeks-scale**, job on existing hardware — and the dominant cost is rollout
decoding, not the optimizer, so vLLM rollouts are the highest-leverage
upgrade before any bigger model is considered.

## 3. Model-size recommendation

**Choose 3B (Qwen2.5-VL-3B-Instruct class) for RL post-training; hold 7B as
the measured fallback.**

Rationale:
1. Poutine demonstrates the 3B VLM tops the WOD-E2E leaderboard after
   GRPO — capability is not the constraint; the reward signal is.
2. Measured: 3B trains at 33.5 s/step using only 16.7/40 GiB, leaving room to
   double group size or add the faithfulness term's extractor-in-the-loop cost
   later. 7B fits the identical recipe (+4 GiB peak, ~1.4–1.6× step time) —
   the escape hatch costs nothing to keep open.
3. The ~10B-class option (GLM-4.1V-9B) also fits (26.1 GiB @ N=32) and shows
   the fastest update phase of the three, but brings a different processor /
   M-RoPE integration surface for no demonstrated quality gain at this stage.

## 4. Staged plan for the WS2 faithfulness reward term

The interface is already in code (`rewards.make_reward_fn`):

```python
reward_fn = rewards.make_reward_fn(
    n_points=7,
    grader=ws2_grader,        # Callable[[list[str]], list[float]] -> scalar in [0,1] per completion
    grader_weight=w_f,        # ramped 0.0 -> target weight
)
```

Staging gates, in order:
1. **w_f = 0 (today).** Programmatic core only: outcome (drive L2) + format,
   exactly Poutine eqs. 5–6. No learned component touches the reward.
2. **WS2 gate passes** (grader benchmark: ≥90% recovery of injected errors on
   the known-error perturbation set, human agreement measured). Until then no
   faithfulness signal gets any weight — plan doc WS7.3 and the AD-R1
   (2511.20325) caution against optimistic reward models both require the
   pessimistic/programmatic core to stay authoritative.
3. **Shadow mode.** Run grader alongside training with w_f = 0; log its scores
   per completion in the metrics stream; check correlation with drive term and
   hack-rate under the auditor red-team loop (ARA) before weighting.
4. **Ramp.** w_f: 0 → 0.05 → 0.1 (cap ~0.2 of total reward scale), always with
   r_drive + r_format ≥ 80% of the achievable reward so the policy can never
   profit by satisfying the critic against the outcome terms.

Practical notes: the grader adds inference cost per completion; at 3B with
N=32 there is ~23 GiB of VRAM headroom at N=40-scale budgets to co-locate a
small extractor, or it runs CPU-side between steps (reward fns already run
outside the CUDA graph).

## 5. Reproduce

One command (prereqs in the script header):

```sh
tools/vla-posttrain/configs/train-3b-poutine-smoke.sh
```

Scale probes:

```sh
.venv/bin/python probe_step.py --model <hf_id> --image <frame.png> \
    --mode sweep-N --lo 8 --hi 128 --json-out runs/probe_<id>.jsonl
```

## 6. Scope note

Per program reframe, this memo + runnable config is the shelf-ready endpoint:
no further training scaffolding was built. When RL resumes, start from §5.
