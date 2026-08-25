# simforge-policy-runner

Reference client for the policy_step protocol (`docs/policy-step.md`):
spawns an env-server, runs seeded episodes against a scripted policy or a
small PyTorch MLP, records per-step inference timing and deadline misses,
and writes a digested JSONL episode trace.

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

The bundled fixture is the gym adapter's synthetic two-car episode with
`physics.mode = 'dynamic-v1'` so control actions actually drive the ego.

Dependencies: `msgpack`, `numpy`; `torch` only for `--policy torch`.
