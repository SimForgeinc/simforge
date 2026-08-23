#!/usr/bin/env bash
# WS7 Poutine-shape GRPO smoke — the one documented command.
#
# Runs >=50 real GRPO optimizer steps on simforge1 (A100-40GB) with QLoRA on
# Qwen/Qwen2.5-VL-3B-Instruct, trajectory-only output, reward = drive (exp(-ADE))
# + format, per arXiv 2506.11234 eqs. 5-6.
#
# Prereqs (once):
#   ssh ubuntu@216.151.21.122
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#   cd ~/vla-posttrain && uv venv --python 3.12 .venv && \
#     uv pip install --python .venv/bin/python torch torchvision transformers trl \
#        peft accelerate bitsandbytes qwen-vl-utils datasets pillow numpy
#   # dataset + W0 frames: build locally then rsync, or reuse ~/w0-data + data/prompts.jsonl
set -euo pipefail
cd "$(dirname "$0")/.."
export HF_HOME="${HF_HOME:-$HOME/hf-cache}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

exec .venv/bin/python train_grpo.py \
  --model Qwen/Qwen2.5-VL-3B-Instruct \
  --w0-root "$HOME/w0-data" \
  --dataset data/prompts.jsonl \
  --out-dir runs/grpo3b-r1 \
  --max-steps 60 \
  --prompts-per-step 4 \
  --num-generations 8 \
  --max-completion-tokens 100 \
  --learning-rate 5e-5 \
  --beta 0.01 \
  --save-adapter
