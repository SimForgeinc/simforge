# sim-engine stepping benchmark

Phase-0 harness: `src/bench/step-bench.ts` (`npx tsx src/bench/step-bench.ts`
from this directory). It times full fixed-step episodes of the force-based
`dynamic-v1` backend over a synthetic two-lane straight, for several actor
counts and `advance(batch)` sizes. The stepping path builds no trace per
batch — the final trace is built once at episode completion, which is the
RL-rollout / playback-refill pattern. "Reset" is session construction
(`createFixedStepSimulation`, including feasibility guards); "steps/s" counts
engine ticks across the whole episode (warm-up included) divided by wall time.
Each cell is the median of 3 runs.

Committed numbers, measured 2026-08-21:

| Actors | Advance batch | Reset (ms) | Steps/s |
|---:|---:|---:|---:|
| 1 | 1 | 0.6 | 11,374 |
| 1 | 10 | 0.6 | 13,231 |
| 1 | 50 | 0.6 | 13,193 |
| 5 | 1 | 0.5 | 2,125 |
| 5 | 10 | 0.5 | 2,149 |
| 5 | 50 | 0.5 | 2,105 |
| 10 | 1 | 0.7 | 945 |
| 10 | 10 | 0.7 | 900 |
| 10 | 50 | 0.7 | 908 |
| 20 | 1 | 1.2 | 320 |
| 20 | 10 | 1.2 | 316 |
| 20 | 50 | 1.2 | 312 |

Phase 2.5 added opt-in reactive ambient traffic (`RunOptions.ambientReactivity:
'reactive'`). The same populations tagged `ambient`, planned with the default
scripted path and with live re-evaluation over a per-tick uniform-grid
broadphase (`src/bench/step-bench.ts`, ambient rows):

| Actors | Advance batch | Reset (ms) | Steps/s |
|---:|---:|---:|---:|
| ambient-scripted 5 | 1 | 0.3 | 2,335 |
| ambient-scripted 5 | 10 | 0.3 | 2,400 |
| ambient-scripted 5 | 50 | 0.3 | 2,424 |
| ambient-scripted 10 | 1 | 0.5 | 1,113 |
| ambient-scripted 10 | 10 | 0.5 | 1,105 |
| ambient-scripted 10 | 50 | 0.5 | 1,106 |
| ambient-reactive 5 | 1 | 0.3 | 2,335 |
| ambient-reactive 5 | 10 | 0.3 | 2,316 |
| ambient-reactive 5 | 50 | 0.3 | 2,406 |
| ambient-reactive 10 | 1 | 0.5 | 1,113 |
| ambient-reactive 10 | 10 | 0.5 | 1,106 |
| ambient-reactive 10 | 50 | 0.5 | 1,102 |

Delta: reactive re-evaluation is free within measurement noise (<1%) at 5 and
10 actors. The grid rebuild is O(actors) per tick and each ambient actor
queries only its scan window (`O(actors × nearby-actors)`); the leader loop
rejects far bodies on squared Euclidean range before any route algebra, so
reactive planning costs the same as the scripted full-population scan it
replaces at these densities.

Environment: Intel Core Ultra 9 285K, Node 22, dt = 20 ms, clip 20 s,
warm-up 2 s, scenario `synthetic-straight` (400 m + 400 m two-lane road),
actors distributed over both lanes with mixed cruise speeds so car-following
is exercised.

Observations:

- Throughput is batch-size independent within noise, confirming no per-batch
  trace construction in the stepping path.
- Cost scales roughly linearly in actor count (dynamic-v1 integration plus
  pairwise conflict/collision scans dominate), from ~13k ticks/s single-actor
  to ~320 ticks/s with 20 interacting vehicles — far above the 20x-real-time
  acceptance gate (≥50 ticks/s at 10 actors).
