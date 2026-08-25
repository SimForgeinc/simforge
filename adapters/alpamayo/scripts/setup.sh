#!/usr/bin/env bash
# One-shot setup: vendor the pinned upstream inference code, build the venv,
# and pre-fetch pinned HF snapshots into ~/simforge-assets/hf-cache.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_COMMIT="7a8f1c781a826f09be53e1e211f26e947ec18019"
MODEL_REV="7aba8293c09993f2e125c6819df05d7fa3e873ea"

export HF_HOME="${HF_HOME:-$HOME/simforge-assets/hf-cache}"
mkdir -p "$HF_HOME"

# 1. Vendor upstream inference code at the pinned commit (Apache-2.0).
if [ ! -d "$ROOT/vendor/alpamayo1.5/.git" ]; then
  git clone https://github.com/NVlabs/alpamayo1.5 "$ROOT/vendor/alpamayo1.5"
fi
git -C "$ROOT/vendor/alpamayo1.5" fetch --quiet origin
git -C "$ROOT/vendor/alpamayo1.5" checkout --quiet "$VENDOR_COMMIT"

# 2. Python env: upstream lockfile minus flash-attn (SDPA fallback, no nvcc
#    build), plus quantization/serving deps.
cd "$ROOT/vendor/alpamayo1.5"
uv venv --python 3.12 --allow-existing .venv
VIRTUAL_ENV="$PWD/.venv" uv sync --active --no-install-package flash-attn
VIRTUAL_ENV="$PWD/.venv" uv pip install bitsandbytes==0.49.2 'torchao>=0.12' msgpack

# 3. Pre-fetch pinned weights (~22 GB) + gated config/tokenizer repos.
#    nvidia/Cosmos-Reason2-8B is gated:auto -> requires `hf auth login` first.
PY="$ROOT/vendor/alpamayo1.5/.venv/bin/python"
"$PY" - <<EOF
from huggingface_hub import snapshot_download
snapshot_download("nvidia/Alpamayo-1.5-10B", revision="$MODEL_REV")
snapshot_download("nvidia/Cosmos-Reason2-8B",
                  revision="a9fae2cf89dc64db96b12860417f0eb403013bb9",
                  allow_patterns=["config.json","generation_config.json","tokenizer*",
                                  "vocab*","merges*","special_tokens_map.json",
                                  "preprocessor_config.json","video_preprocessor_config.json",
                                  "chat_template*"])
snapshot_download("Qwen/Qwen3-VL-2B-Instruct",
                  revision="89644892e4d85e24eaac8bacfd4f463576704203",
                  allow_patterns=["preprocessor_config.json","video_preprocessor_config.json",
                                  "tokenizer*","vocab*","merges*","special_tokens_map.json",
                                  "chat_template*","config.json"])
print("snapshots ready under", "$HF_HOME")
EOF

echo "setup complete. Start the server with scripts/run_server.sh"
