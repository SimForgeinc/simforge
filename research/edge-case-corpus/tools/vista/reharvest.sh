#!/usr/bin/env bash
# Central re-harvest: run the FULL pipeline over the re-anchored templates and re-measure everything.
# Fire this only after ws1a (loud predicates) and ws1b (place fit) have both landed.
set -euo pipefail
cd /Users/michaelvu-simforge/Documents/Programming/SimForge-vista/research/edge-case-corpus/tools/vista
PY=/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/.venv/bin/python
OUT=/tmp/vista-harv-final
# Only wipe with --fresh. `batch` resumes from existing cells unless --force, and a blind `rm -rf`
# here already destroyed 1065 computed traces once, costing ~70 minutes.
if [ "${1:-}" = "--fresh" ]; then rm -rf "$OUT"; fi
rm -rf /tmp/vista-dataset-final /tmp/vista-plaus-final

# 1. verify intent + batch + gate (C1-C6) + Q1-Q8 + dedup, over all three author roots
$PY harvest.py --roots /tmp/vista-gen6-blind /tmp/vista-gen3-blind /tmp/vista-user \
  --out "$OUT" --sites 8 --draws 20 --reps 3 --limit 2 --workers 4 --ambient moderate

# 2. dataset, split by archetype
$PY dataset.py --harvest "$OUT/HARVEST.json" --out /tmp/vista-dataset-final --test-frac 0.25

# 3. M1.3 site counts after tightening
$PY sitecount.py --dataset /tmp/vista-dataset-final/train.jsonl /tmp/vista-dataset-final/test.jsonl \
  --out /tmp/vista-sitecounts.json --detail /tmp/vista-sitecounts-detail.json

# 4. M1.4 blind plausibility, same instrument and sample size as the 0.577 baseline
$PY loccritic.py --dataset /tmp/vista-dataset-final/train.jsonl /tmp/vista-dataset-final/test.jsonl \
  --out /tmp/vista-plaus-final --per-archetype 6 --workers 5

# 4b. M1.1 mechanical place fit, RE-RUN on the FINAL corpus. Without this the audit would read the
#     stale /tmp/vista-placefit.json, which grades the OLD corpus against the new requirements and
#     therefore measures the damage rather than the fix.
$PY placefit.py --dataset /tmp/vista-dataset-final/train.jsonl /tmp/vista-dataset-final/test.jsonl \
  --templates "$OUT/../vista-ws1b/templates" --out /tmp/vista-placefit-final.json || \
$PY placefit.py --dataset /tmp/vista-dataset-final/train.jsonl /tmp/vista-dataset-final/test.jsonl \
  --out /tmp/vista-placefit-final.json

# 5. full scorecard M1.1-M4.4
$PY audit.py --dataset /tmp/vista-dataset-final/train.jsonl /tmp/vista-dataset-final/test.jsonl \
  --videos /tmp/vista-3d --sitecounts /tmp/vista-sitecounts.json \
  --plaus /tmp/vista-plaus-final/PLAUSIBILITY.json \
  --placefit /tmp/vista-placefit-final.json --out /tmp/vista-scorecard-final.json
