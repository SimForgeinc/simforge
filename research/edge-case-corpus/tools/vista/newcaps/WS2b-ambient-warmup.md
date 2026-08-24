# WS-2b: Ambient warm-up / settle (measure M2.3)

## BOTTOM LINE
**M2.3 MET.** `--ambient-settle <seconds>` (default 20 s when `--ambient` is given) gives the
generated population a real warm-up that advances **only** that population. On the 15-cell
`c15g-red-light-runner-signals` probe (`--all-maps --max-sites 3 --ambient city`), measured with
`audit.py m2_2_2_3_2_5`:

* **M2.3 = 0.933** of cells carry a standing queue of >=2 ambient vehicles at t=0
  (target >=0.50; un-settled baseline on the same command **0.467 FAIL**), and t=0 speeds stay
  **distributed** — median spread **15.20 m/s**, not a frozen road.
* **M2.2 = 4** ambient vehicles within 60 m of the ego at t=0 (target >=3): **no regression**
  (un-settled 5, absolute baseline 0).
* **M2.5 = 0** cells whose closest-approach partner is ambient: **no regression**.
* **M2.4** holds: 15/15 cells reproduce an identical `traceDigest` on a second run.

Authored equivalence: with ambient OFF, 8 archetypes x 5 maps = **40/40 cells identical** (37
byte-identical `traceDigest`s, 3 infeasible in both) against the pre-WS2/pre-WS2b tree. With ambient
ON the ego/challenger tracks are **NOT** bit-identical to the no-warm-up run — but they were already
not identical to the ambient-OFF run before this work (9/30 authored tracks perturbed >0.5 m without
any settle, 12/30 with it, same magnitude regime, same 100 m worst case). The warm-up integrates no
authored actor for a single tick; what it changes is which generated cars are on the road, and the
ego brakes for real cars by WS-2's explicit design. That clause of the acceptance is not satisfiable
without making the ego blind to ambient bodies.

M2.3 number: **0.933** (fraction of junction-type cells with a >=2-vehicle standing queue at t=0).

## The problem (inherited diagnosis, not re-derived)
`choreography.warmupSeconds` is 0.6 s on the corpus templates. Ambient actors spawn already at
cruise, so at t=0 no one has had time to stop. Measured on a 9-cell c15g `--ambient city` run:
0/32 ambient below 0.5 m/s at t=0 (min 5.02, median 13.60 m/s); by the end of the 13 s clip 14/32
are below 0.5 m/s. The queuing BEHAVIOUR is fine; there is no settle window before t=0.

Raising `warmupSeconds` is forbidden: `sim/engine.ts` integrates the WHOLE scene from
`t = -warmupSeconds`, so it also advances the ego and the authored challenger and destroys the
authored conflict timing.

## The design: an ambient-only settle pre-pass (write-back of initial state)
Instead of lengthening the shared prologue, run a SEPARATE, throw-away simulation that contains
ONLY the generated population, then write its final state back as the ambient actors' *initial*
state in the real input. Authored actors are never in the settle sim and their input bytes are
never touched.

Key facts that make this exact and cheap:
* `sim/engine.ts` (~:547-556) derives `routeS` by PROJECTING `initial.pose` onto the route.
  `initial.laneRef` is advisory. So a settled actor is expressed by rewriting
  `initial.pose` (x,z,headingRad), `initial.speedMps` and `initial.laneRef`, keeping the SAME
  `behavior.route.lanes`. No route surgery is needed.
* Signal phase alignment: `SignalBook.stateAt` uses `elapsed = t + warmupSeconds + offsetS`.
  Real run at `t = -warmupSeconds` has `elapsed = offsetS`. Settle run (warmupSeconds = 0) at
  `u = settleSeconds` has `elapsed = settleSeconds + offsetS'`. Therefore the settle sim uses
  `offsetS' = offsetS - settleSeconds`, and the settle ends on exactly the phase the real run
  begins its prologue with. Queues that formed at a red light are still queued when the real
  clip starts.
* Trace frame is xodr-local; `pose.z = -track.y` (`frames.ts`).
* Determinism: same seed + same profile => same settle => same digest, so M2.4 is preserved.
* Ambient OFF => the pre-pass is not called at all => byte-identical authored traces.


## MEASURED (probe A: c15g-red-light-runner-signals, --all-maps --max-sites 3 = 15 cells, --ambient city)

Same command, only `--ambient-settle` differs. Measured with `audit.py m2_2_2_3_2_5` (not rewritten).

| measure | settle 0 (baseline) | settle 20 (v1) | settle 20 (v4, shipped) |
|---|---|---|---|
| **M2.3** fraction of cells with >=2 ambient stopped at t=0 | 0.467 FAIL | 0.667 | **0.933 PASS** (target >=0.50) |
| M2.3 median t=0 speed spread | 17.82 m/s | 13.00 | **15.20 m/s, distributed** |
| **M2.2** median ambient within 60 m at t=0 | 5 PASS | 0 REGRESSED | **4 PASS** (target >=3) |
| **M2.5** cells whose closest partner is ambient | 0 PASS | 0 | **0 PASS** |

Per-cell delivered populations are unchanged (32/32, 9/9, ...); only their state at t=0 differs.

### What v1 and v2/v3 got wrong (kept because it is the load-bearing part of the design)
* **v1** settled the already-selected population. 20 s at 13 m/s is 260 m of travel, so the whole
  population drove off the site: median near-ego 5 -> 0. It also invalidated the spawn-time
  authored clearance (new `spawn_overlap ... overlaps ambient:v1:...` issues), because
  `exclusionRadiusM` was enforced at spawn, which after a settle is the wrong instant.
* **v2/v3** fixed the selection order (settle a cohort, then re-select) but sized the cohort by
  requiring every candidate to own `cruise x (warmup + clip + settle)` of downstream route
  (~480 m). On these maps that is unaffordable: the cohort collapsed to 7-43 candidates because the
  candidate pool ran out of long-enough routes, and the delivered population fell with it
  (yale/10f16d: 32 -> 5 actors). M2.2 stayed at 0.
* **v4** drops the extra runway requirement (an actor that runs out of route during the settle just
  despawns and is dropped; the oversized cohort absorbs it) and sizes the cohort as
  `4 x min(maxActors, eligibleLaneKm(radius + 15 m/s x settle) x density)`.
  That is ~24 veh/km of settle flow (a normal urban headway, not a jam) thinned back to the
  profile's own budget after settling.

## EQUIVALENCE PROOFS

### 1. Ambient OFF is byte-identical (the strong claim, and it holds)
Ran 8 archetypes x 5 maps x `--max-sites 1` = **40 cells**, no ambient flags, twice:
once on this branch, once with my six changed files reverted to commit `43fe99f`
(pre-WS2 *and* pre-WS2b) and `ambient/settle.ts` deleted.

**40 of 40 cells agree; 37 traceDigests byte-identical, 3 cells infeasible in both.**
Archetypes: c1-lead-stopped, c2-ramp-merge, c3-allway-stop, c5-cpna, c6-dooring, c7-hedge-corner,
c8-narrowing, c9-debris. So neither the ambient wiring nor the warm-up can touch an empty-road
scenario: `settleAmbientTraffic` is never called and `applyAmbientTraffic` is never called.

### 2. Ambient ON: authored tracks are NOT unchanged, and they were not unchanged before the settle either
This is the one acceptance clause I must report as **not satisfiable as written**, and it is not a
property my change removed. Ambient traffic is real physics by design (WS-2 kept collision detection
global and kept the ego's braking real; only the *metric attribution* is excluded). Max |xy|
deviation of the authored `ego` and `violatingVan` tracks against the SAME cell run with ambient OFF,
over the 15-cell c15g probe (30 authored tracks):

| | exactly 0 | > 0.5 m | median | max |
|---|---|---|---|---|
| ambient ON, settle 0 (the pre-existing behaviour) | 21/30 | 9/30 | 0.000 m | 100.28 m |
| ambient ON, settle 20 (this work) | 18/30 | 12/30 | 0.000 m | 101.22 m |

The settle changes WHICH cells are perturbed; it does not change the magnitude regime, and it does
not introduce the perturbation. The honest statement is: **the warm-up advances only the generated
population — no authored actor is integrated for one extra tick — but the generated population it
produces is a different population, and authored actors respond to real cars.** If authored
trajectories must be bit-stable under ambient traffic, that is a separate (and larger) piece of work
than the warm-up: it needs the ego's controller to ignore ambient bodies, which contradicts WS-2's
deliberate decision to keep the physics real.

### 3. M2.4 determinism survives the settle
Same command run twice with `--force`: **15 of 15 cells reproduce an identical `traceDigest`.**
The settle is a pure function of the population, the seed and the settle length, and the settle
length is folded into `replayKey.ambientProfileHash` as `<profileHash>+settle<seconds>` so a resumed
batch can never serve a differently-settled cell as fresh.

## REGRESSION STATUS
* `npx tsc --noEmit -p packages/{sim-engine,scenario-materializer,cli}/tsconfig.json` — all three clean.
  (Per package; a bare `npx tsc --noEmit` prints help and exits 1 and is NOT a pass.)
* `@simforge/engine`: **313 passed, 8 skipped, 0 failed** — exactly the WS-2 baseline.
* `@simforge/compiler`: **75 passed, 0 failed.**
* `@simforge/cli`: **71 failed, 298 passed, 1 skipped** against a baseline of 70 failures.
  The one extra name is
  `campaign 688dd78d ... 'reversing-pedestrian' keeps all preserved draws truthful and collision-free`
  (`expected undefined to be defined` — the exact site no longer matches). **It is not mine**: I
  re-ran that file with my six files checked out at `43fe99f` and `settle.ts` deleted and it fails
  identically. It is the reversing-pedestrian golden already recorded as an OPEN item in `bb0a4ee`.
* `gate.py` is untouched by this work, and the ambient-OFF path is byte-identical (40/40 above), so
  the frozen gold regression cannot move.

## HOW TO RUN IT
```
uniscenarios batch <template> --all-maps --draws N --out DIR \
  --ambient city --ambient-settle 20      # 20 s is the DEFAULT when --ambient is given
uniscenarios batch ... --ambient city --ambient-settle 0   # exact pre-warm-up behaviour
```
`--ambient-settle` without `--ambient` (or with `--ambient off`) is a loud error, not a silent no-op.

## FILES
* `packages/engine/src/ambient/settle.ts` — NEW. `settleAmbientTraffic(base, graph, options)`.
* `packages/engine/src/ambient/traffic.ts` — `AmbientTrafficOptions.targetMultiplier`,
  `.cohortRadiusBonusM`, `.extraTravelSeconds`; `AmbientTrafficProvenance.placementTarget`.
* `packages/engine/src/index.ts` — exports.
* `packages/compiler/src/materialize.ts` — `MaterializeOptions.ambientSettleSeconds`,
  the cohort constants, the settle call, `manifest.ambientSettle`, the replay-key stamp.
* `packages/cli/src/main.ts`, `commands/batch.ts`, `batch-cell.ts` — `--ambient-settle` end to end.

## KNOWN LIMITATIONS (do not let these be discovered later)
1. **Authored trajectories are not bit-stable under ambient traffic**, with or without the warm-up
   (section 2 above). The warm-up does not integrate authored actors, but it does change which
   generated cars exist near them, and the ego brakes for real cars. Fixing that is a different
   decision — make the ego blind to ambient bodies — and it contradicts WS-2's design.
2. **The settle flow is denser than the delivered population.** The cohort is ~4x the profile's
   density (~24 veh/km for `city`) and is thinned back to the profile's budget after settling, so
   queue lengths formed during the warm-up are a little longer than 8 veh/km alone would produce.
   Measured effect on the delivered t=0 state: median speed spread 15.20 m/s, i.e. still a live road.
3. **Small maps still deliver small populations** (easterbrook: 9 actors). That is the map, not the
   warm-up; it is the same figure the un-settled run delivers.
4. `AmbientTrafficOptions.extraTravelSeconds` exists and is deliberately NOT used by the settle path
   (see the comment in `materialize.ts`); it is retained for callers that want spawn-time runway to
   cover a settle.

## CAVEAT ON THE COMMIT HISTORY
Commit `253df16` ("FINDINGS s34", another workstream) reverted all six of my source files and deleted
`ambient/settle.ts`: it ran `git add -A` during the ~4-minute window in which I had those files
checked out at `43fe99f` to produce the ambient-OFF equivalence baseline. `f6bd736` restores them,
verified byte-identical to `93c7083`. **Anyone re-running this must be on `f6bd736` or later.**

## Status log
- [t0] Stub created.
- [t1] Design fixed (ambient-only settle sim + write-back of initial state).
- [t2] v1 implemented; M2.3 0.667 but M2.2 regressed 5 -> 0.
- [t3] v2/v3 settle-then-select; cohort starved by the settle runway requirement.
- [t4] v4 shipped: no extra runway, cohort = 4 x density over radius + 15 m/s x settle.
       M2.3 0.933 PASS, M2.2 4 PASS, M2.5 0 PASS, M2.4 15/15.
- [t5] Equivalence, determinism and regression suites measured; doc complete.
