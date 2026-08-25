# simforge-policy-runner

Reference client for the policy_step protocol (`docs/policy-step.md`):
spawns an env-server, runs seeded episodes against a scripted control
policy, a scripted-trajectory policy, or a small PyTorch MLP, records
per-step inference timing and deadline misses, and writes a digested JSONL
episode trace with per-act reasoning text and the server's trajectory-
executor telemetry.

Determinism contract: two runs with the same `--seed`, policy, and
`--force-miss-at` steps produce identical `episode_digest`s — wall-clock
timing is recorded but excluded from digests, and deadline misses are
forced (deterministic), never left to scheduling noise.

## Usage

Build the server once (`pnpm --filter @simforge/training-env build`), then:

```sh
python -m simforge_policy_runner \
    --spec fixtures/synthetic-episode-dynamic.json \
    --policy torch --seed 42 --policy-seed 7 --steps 30 \
    --deadline-ms 50 --fallback zero-control --force-miss-at 9 \
    --out /tmp/trace.jsonl
```

Prints the episode summary (digest, steps, misses, checkpoint digest,
infer/roundtrip percentiles) as JSON; the trace file carries a `reset`
record, one record per decision (with the decoded `sv` state vector and the
`terms` reward breakdown for downstream scoring — see
`packages/evaluation` `scoring.ts`), and a final summary line. `--session`
selects the env session (scenario instance) inside the spec.

`--policy trajectory` drives the ego with *scripted* ego-frame S-curve
trajectories replanned at 0.5 Hz against 10 Hz decisions (the Alpamayo
cadence; identical points are resent between replans so the server's
zero-order hold keeps one anchor per plan). Each digested trace record then
carries `reasoning` (plan label; a model policy would store its
chain-of-causation here) and `ex` — the executor's pose, signed cross-track
error, applied setpoints and preview point — so the trace shows the ego
following the curves. Use the long-clip fixture:

```sh
python -m simforge_policy_runner \
    --spec fixtures/synthetic-episode-trajectory.json \
    --policy trajectory --seed 42 --steps 120 --out /tmp/trace.jsonl
```

The summary adds `cross_track_m` percentiles over the episode.

The bundled fixture is the gym adapter's synthetic two-car episode with
`physics.mode = 'dynamic-v1'` so control actions actually drive the ego.

Dependencies: `msgpack`, `numpy`; `torch` only for `--policy torch`.
