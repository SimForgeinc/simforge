# rl-env environment benchmark

Phase-1 harness: `src/bench/env-bench.ts` (`npx tsx src/bench/env-bench.ts`
from this directory). It measures **end-to-end decision throughput** of
`EnvSession` — engine ticks plus observation build, reward assembly, event
drain, LOS gating, and causal-channel collection — over full episodes of the
force-based `dynamic-v1` backend on the same synthetic two-lane scenario the
sim-engine Phase-0 harness uses (5 actors, mixed cruise speeds, dt = 20 ms,
clip 20 s, warm-up 2 s). "Reset" is `new EnvSession(...)` + `reset()`
including warm-up consumption; "Decisions/s" counts policy decisions at
10 Hz (10 engine ticks each) across the whole episode. Each cell is the
median of 3 runs.

Committed numbers, measured 2026-08-21 (Intel Core Ultra 9 285K, Node 22):

| Observation config | Reset (ms) | Decisions/s (5 actors, 10 Hz) |
|---|---:|---:|
| state-vector only | ~36 | ~600–700 |
| state + object list | ~26 | ~630–670 |
| state + objects + BEV (0.25 m/cell, 160×200×3) | ~32 | ~305 |

Observations:

- Without BEV the env layer costs ~25% over raw engine stepping
  (~2,100 ticks/s at 5 actors from the Phase-0 table): observation + reward +
  causal collection add ~0.1 ms per decision.
- The BEV raster roughly halves decision throughput at the default 40×50 m /
  0.25 m grid. Lane-surface stamping culls by an axis-aligned bbox around the
  ego, so cost scales with raster area, not map size; coarser resolutions or a
  smaller extent scale linearly.
- Reset is dominated by first-episode engine construction (feasibility guards,
  occluder build), not by env-layer work — consistent with the <100 ms
  episode-bank reset budget, which the settled-input provider interface
  reserves for pre-settled banks.

The rl-plan Phase-1 aspiration of ≥5k *engine ticks*/s/core with BEV remains
bounded by the kernel itself (2.1k ticks/s at 5 actors); the env layer's share
is the delta between this table and the Phase-0 numbers.

## Env-server transport (Phase 2)

`src/bench/env-server-bench.ts` (`npx tsx src/bench/env-server-bench.ts`)
measures framed round trips over a real unix socket against an in-process
server hosting 4 sessions of the same 5-actor `dynamic-v1` scenario with
state-vector observations. Each cell is the median of 3 runs × the in-run
distribution; measured 2026-08-21, same machine:

| Operation | Median | p95 |
|---|---:|---:|
| `batch_step`, K = 8 | ~1.4 ms | ~17 ms |
| per decision inside a batch | ~0.17 ms | — |
| single `step` | ~63 µs | — |
| `ping` round trip (framing floor) | ~14 µs | — |

The framing layer costs ~14 µs per round trip; a K = 8 batch is dominated by
8 × 5 `dynamic-v1` engine ticks (~0.17 ms per decision including obs/reward/
causal), so batching amortizes transport to noise while preserving one
synchronous request/reply per rollout step.
