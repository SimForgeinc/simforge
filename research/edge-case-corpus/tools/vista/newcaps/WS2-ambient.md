# WS-2 — AMBIENT TRAFFIC (UniScenarios-vista, branch `vista-lane`)

STATUS: **IN PROGRESS** (this file is written early and updated as work lands; assume it may be
the last thing I wrote).

## BOTTOM LINE (provisional — numbers not yet measured)

The corpus pipeline runs on empty roads because **nothing on the `batch` path ever calls the native
ambient generator**. The generator itself (`packages/engine/src/ambient/traffic.ts`) is complete,
deterministic and trace-bearing; it was simply never wired into `materialize()` → `runCell()` →
`batch`. I am wiring exactly that path, plus the safety machinery that stops background traffic from
stealing the scenario's own conflict.

**On M2.5 I have already decided, and the code already implements: ambient actors must be EXCLUDED
from criticality metrics, not merely distinguished.** Distinguishing is not enough because every
consumer that recomputes a "closest approach pair" — including the frozen gate — takes a *minimum
over actors*, and a minimum silently re-attributes itself. Exclusion has to happen at the place the
minimum is taken, in every consumer, or it has not happened.

---

## What was verified about the existing code (not assumed)

* `applyAmbientTraffic(base, graph, profile, options)` → `materializeAmbientCandidatePool` →
  `createAmbientCandidatePool`. Confirmed present, confirmed appends ordinary `SimActor`s to a
  `SimScenarioInput`, confirmed tags them `['ambient','ambient:v1','ambient-profile:…','ambient-seed:…']`
  and ids them `ambient:v1:<16 hex>`.
* Default preset is `off` and `PRESET_DENSITY.off = 0`, so wiring alone changes nothing — a profile
  must be chosen. Confirmed.
* **The CLI never called it.** `grep -rn ambient packages/cli/src` before my change returned only
  `debug --ambient-count` (headless SUMO comparison, separate run, never enters `ticks.actors`) and
  an ASAM export finding string. Confirmed the parent's finding.
* **`AmbientTrafficOptions` has NO warm-up/settle concept.** It carries exactly `reservations` and
  `maxAchievableDecelMps2`. The only warm-up in the system is the engine's own prologue: the
  integrator starts at `t = -input.warmupSeconds` (`solve/nominal.ts`, `sim/engine.ts:515`) and
  ambient actors are `presentAtStart: true`, so they DO settle for `warmupSeconds` before `t=0`.
  Whether 5 s is enough to build standing queues is a measurement, not an assumption — pending.
* **The engine already knows about ambient traffic in one place I did not expect**:
  `sim/engine.ts findConflict()` contains
  `const aIsAmbient = a.tags.includes('ambient'); … if (!aIsAmbient && bIsAmbient) continue;`
  — an authored actor **never yields** to a generated one in the crossing-conflict term, and
  `hasAmbientTraffic` switches on a uniform-grid broadphase (`sim/spatial.ts`). So the crossing term
  is already ambient-safe. The **car-following (leader) term is not**: `findLeader` observes every
  physical body, by design.
* `trace/monitored-pairs.ts` already carried the comment *"future ambient pruning must prove
  equivalence here"*. That is the exact seam I used.

## The hijack mechanism, precisely

`gate.py trace_facts()` loops `for aid, a in ticks['actors'].items(): if aid == 'ego': continue` and
keeps the global minimum OBB clearance as `closestWith`. It has no notion of ambient. Therefore:

1. **C2/C3** (`closestT`, `clearanceM`) would be won by whichever body came nearest, ambient or not.
2. **Q1** (`joint challenger`) picks the same way → the whole quality layer would describe that body.
3. **Q6/`minTTC`** comes from engine `metrics.minTTC.pair`, which is already restricted to pairs
   containing `metricSubject` (ego) — but an *ego↔ambient* pair passes that test, so ambient could
   take `minTTC` too.
4. **C4** reads `metrics.requiredDecelMax.ego`. An ambient car in the ego's lane makes the ego brake
   for real, which is physically correct but would let background traffic *manufacture* C4 demand.

## The fix, in four layers (implemented; measurement pending)

1. **Spawn-time corridor reservation** (`ambient/traffic.ts`). The authored corridor — every lane on
   every authored `lanePath` route plus every authored `initial.laneRef.rsl` — is excluded both as a
   *spawn* lane and as a *route* lane, so a generated car can neither start in the ego's lane nor
   drive into it 60 m later. New `AmbientTrafficOptions.excludedLaneRsls` /
   `allowAuthoredCorridor` (the latter for the robustness evaluator, which wants the opposite).
   New provenance: `authoredCorridorRejects`, `authoredCorridorLaneRsls`.
2. **Engine metric exclusion** (`trace/monitored-pairs.ts`, `trace/metrics.ts`, `sim/engine.ts`).
   `MonitoredPairPolicy.ambientActorIds`; any pair touching an ambient actor is `scored: false`
   (`reason: 'ambient-excluded'`) unless it is an explicitly authored monitor pair. This removes
   ambient from `minTTC`, `minPathTTC`, `minPET`, `minDistance` and `criticalitySamples`.
   **Collision detection stays global** — an ambient body the ego actually hits still fails the clip.
   Equivalence: with an empty set the branch is unreachable, so authored-only traces are unchanged.
3. **`requiredDecelMax` attribution** (`sim/controllers.ts`, `sim/engine.ts`). `governorCap` now also
   returns `requiredDecelExcludingLeader`. The ego still *brakes* for a generated leader (`accel` is
   untouched, the physics is real), but the evidence figure `requiredDecelMax` no longer credits it.
   Ambient actors keep their own full figure.
4. **Trace-header channel + gate patch.** `trace.header.ambientActorIds?: string[]` (optional, so
   ambient-free traces are byte-identical and every historical digest still reproduces) publishes the
   set so any external recomputation can subtract it. **`gate.py` needs a change and I am not making
   it** — the exact patch is specified below.

## THE GATE PATCH I NEED (specified, NOT applied — gate.py is yours)

In `research/edge-case-corpus/tools/vista/gate.py`, function `trace_facts(trace)`, the per-challenger
loop currently reads:

```python
    for aid, a in ticks['actors'].items():
        if aid == 'ego':
            continue
```

It must become:

```python
    ambient = set(hdr.get('ambientActorIds') or [])
    for aid, a in ticks['actors'].items():
        if aid == 'ego' or aid in ambient:
            continue
```

That is the whole change: two lines, in one function. Properties:

* **It is inert on every existing trace.** `ambientActorIds` is absent from every trace written before
  this work, so `ambient` is the empty set and the loop is byte-identical. The 293 delivered
  scenarios re-gate to exactly the same numbers.
* **It can only ever tighten.** Removing actors from the candidate set can only make `clearanceM`
  larger (or `None`) and can never turn a failing cell into a passing one.
* It uses the engine's own published set, not a string-prefix guess. If you prefer belt-and-braces,
  the equivalent tag test is
  `hdr.get('actorMetadata', {}).get(aid, {}).get('tags', [])` containing `'ambient'`, or
  `aid.startswith('ambient:')`. All three agree by construction.
* `quality()` needs nothing: `Q1` iterates `facts['perChallenger']`, which this loop builds, and `Q6`
  reads `metrics.minTTC.pair`, which the engine already filters in layer 2.

---

## THE FIVE MEASURES

| id | measure | status |
|----|---------|--------|
| M2.1 | ambient reachable from the `batch` path harvest.py uses | wiring in progress |
| M2.2 | median ≥3 ambient vehicles within 60 m of ego at t=0 (baseline 0) | not yet measured |
| M2.3 | settled warm-up: ≥50% of junction sites show a ≥2-vehicle standing queue at t=0; t=0 speeds distributed | not yet measured |
| M2.4 | same seed ⇒ identical trace digest | not yet measured |
| M2.5 | authored ego/challenger remains the metric-subject pair in 100% of accepted cells; hijack count without the fix | not yet measured |

## Test-suite baselines (measured BEFORE any change, on this worktree)

* `@simforge/engine`: **313 passed, 8 skipped, 0 failed** (43 files passed, 1 skipped).
* `@simforge/cli`: **299 passed, 70 failed, 1 skipped** (29 files failed, 11 passed, 1 skipped).
  Note: the parent said ~67 pre-existing failures; the measured figure on this worktree is **70**.
  Post-change counts must be compared against 70, not 67.

## Files touched so far

* `packages/engine/src/trace/monitored-pairs.ts` — ambient exclusion in the pair policy.
* `packages/engine/src/trace/metrics.ts` — accumulator carries `ambientActorIds`.
* `packages/engine/src/sim/engine.ts` — collects ambient ids, feeds the accumulator, publishes
  `header.ambientActorIds`, applies the `requiredDecelMax` attribution.
* `packages/engine/src/sim/controllers.ts` — `governorCap` returns `requiredDecelExcludingLeader`.
* `packages/engine/src/ambient/traffic.ts` — authored-corridor exclusion.
* `packages/compiler/src/materialize.ts` — `MaterializeOptions.ambient`, applied after
  the authored feasibility verdict and before `inputHash`; `ReplayKey.ambientProfileHash`;
  `manifest.ambient` provenance.
* `packages/cli/src/batch-cell.ts`, `packages/cli/src/commands/batch.ts`, `packages/cli/src/main.ts`
  — flags and the worker hand-off (in progress).

## Rules I am holding to

* `gate.py` is not modified by me.
* Nothing is written to `/Users/maikyon/...`. Scratch output goes to `/tmp/vista-ws2/`.
* Typecheck is per package: `npx tsc --noEmit -p packages/<pkg>/tsconfig.json`. A bare
  `npx tsc --noEmit` prints help and exits 1 and must not be mistaken for success.
