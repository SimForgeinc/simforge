# Closed-Loop Evaluation Campaigns (P4)

Scenario × seed × policy episode grids run **sequentially** through the
policy_step reference runner (`adapters/policy-runner`), scored with
SimForge-native metrics, persisted as immutable artifact directories with
an append-only ledger, and deterministically rerunnable.

Model-independent: everything speaks `docs/policy-step.md` — Alpamayo (or
any registered model endpoint) plugs in through the same client that runs
the scripted and torch-mlp reference policies.

- Scoring: `packages/evaluation/src/scoring.ts`
- Campaigns: `packages/evaluation/src/campaign.ts`, CLI
  `simforge-eval-campaign` (`campaign-cli.ts`)
- Example config: `packages/evaluation/fixtures/mini-w3.campaign.json`

## CLI

```sh
simforge-eval-campaign run    --config campaign.json   # run / resume
simforge-eval-campaign rerun  --config campaign.json --episode <id>
simforge-eval-campaign report --config campaign.json   # report.json + report.md
```

During development: `pnpm --filter @simforge/evaluation exec tsx src/campaign-cli.ts …`.

## Campaign config

```jsonc
{
  "campaignId": "mini-w3",
  "runsRoot": "~/simforge-assets/runs",
  "decisionHz": 10,
  "suite": [{
    "scenarioId": "synthetic-leadcar",       // [a-z0-9-]
    "spec": "synthetic-leadcar.episodes.json", // env-server form-A episode spec, relative to this file
    "session": 0,                             // instance index inside the spec
    "steps": 120,                             // decision budget
    "expectedRouteM": null,                   // null → ego cruiseSpeed × clipSeconds
    "speedLimitMps": null                     // null → authored lane speedLimitKph (topology), engine default 13.4
  }],
  "seeds": [101, 202, 303],
  "policies": [{
    "policyId": "scripted", "runnerPolicy": "scripted",   // or "torch"
    "policySeed": 0, "deadlineMs": 50, "fallback": "zero-control", "forceMissAt": []
  }]
}
```

## Artifact layout

Under `<runsRoot>/<campaignId>/`:

| file | content |
|---|---|
| `campaign.json` | frozen resolved spec; fixture sha256s pin immutability — resuming with changed inputs is refused |
| `ledger.jsonl` | append-only, one line per completed episode; readers take the last line per `episodeId` |
| `report.json` / `report.md` | aggregation (per-scenario table, aggregate driving score, infraction histogram) |
| `<episodeId>/` | `episodeId = <scenarioId>__<policyId>__seed<seed>` |

Per episode: `trace.jsonl` (rich policy-runner trace: decoded `sv`, `objs`,
reward `terms`, chained digests), `events.json` (per-event records with tick
+ position), `score.json`, `provenance.json` (checkpoint digest, adapter
version + git sha, seed, schedule, episode digest, fixture digest),
`runner-summary.json`, and a `COMPLETE` marker written last.

## Kill / resume

Resume is idempotent by construction: episodes with a `COMPLETE` marker are
skipped untouched; an episode directory without one is wiped and rerun.
Killing the runner at any instant loses at most the in-flight episode.
The ledger is append-only across resumes.

## Determinism

`rerun` re-executes a completed episode into `<campaign>/.rerun/<episodeId>`
and compares the chained `episode_digest` plus a sha256 over the trace with
wall-clock `timing` stripped. Deterministic policies (scripted, and torch-mlp
on one machine) must match byte-for-byte; a mismatch exits non-zero.

## Scoring

`drivingScore = routeCompletion × Π penaltyFactor^eventCount`, in [0, 1].

| infraction | default factor | trigger (exact boundaries unit-tested) |
|---|---|---|
| collision-vehicle / -pedestrian / -static | 0.60 / 0.50 / 0.65 | terminal collision (shared rule with eval-server `col`); partner = nearest perceived object, typed by authored actor kind |
| off-road | 0.75 | \|lateral offset\| > 3.0 m (strict), hysteresis clears at 2.5 m |
| wrong-way | 0.70 | ≥ 1.0 m cumulative reverse route-arc while speed > 0.5 m/s |
| red-light | 0.70 | stop-line crossing while red (`sig` trace annotations; inert without signals) |
| stuck | 0.80 | speed < 0.3 m/s for ≥ 8 s continuously |
| speeding | 0.90 | speed > limit × 1.1 sustained ≥ 1 s |

Route completion = clamp(Δ route-arc / expectedRouteM, 0, 1); an explicit
goal termination forces 1. Reported without score impact: TTC minima over
closing perceived objects (`ttc-critical` warnings below 1.5 s), comfort
accel/jerk bound violations (3.5 m/s², 8 m/s³), and deadline misses.
All thresholds and factors are per-scenario overridable (`suite[].scoring`).
