#!/usr/bin/env bash
# Start the simforge-alpamayo act() server.
#   scripts/run_server.sh [--quant nf4|fp8] [--socket PATH] [--warmup-cams N]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HF_HOME="${HF_HOME:-$HOME/simforge-assets/hf-cache}"
export PYTHONPATH="$ROOT/src:$ROOT/vendor/alpamayo1.5/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$ROOT/vendor/alpamayo1.5/.venv/bin/python" -m simforge_alpamayo.server "$@"
