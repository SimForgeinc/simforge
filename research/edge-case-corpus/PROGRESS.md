# Edge-case corpus — progress log

## Verified methodology: 3 levers took a portable template from 5.4% to 64.2% critical yield

| Version | Change | Yield | Maps w/ accept | Sites | occlusion_unproven | physically_unavoidable |
|---|---|---:|---:|---:|---:|---:|
| v1 | as authored by scene-first agent | 5.4% | 4 | 7 | 153/240 | 62 |
| v2 | mechanism-preserving `gapM`/`dartLeadM` ranges | 9.6% | 4 | 8 | 30/240 | 49 |
| v3 | + `invariants[].window=[5,12]` on criticality | 41.2% | **5** | 31 | 30/240 | 49 |
| v4 | + yield-solved tier-1 parameter box | **64.2%** | **5** | 26 | 31/240 | **0** |

154 verified critical instances, 0 collisions, all five maps.

### Lever 1 — mechanism-preserving ranges
The LLM declares parameter ranges by intuition; most of the declared range is **not the accident**.
Measured: `gapM` 1.2-1.56 m -> 11% occlusion failure; 2.63-2.99 m -> **91%** (monotone). A wide gap
between the parked rows lets the ego see through, so the occlusion mechanism never establishes.
Ranges must be *solved*, not guessed.

### Lever 2 — the windowed-criticality trap (highest single lever: 9.6% -> 41.2%)
`evaluate` and template `invariants` measure **different numbers**. `evaluate` uses a mechanism-aware
minimum inside a proportional edge-guard window; an un-windowed `pet` invariant reads global minPET,
which on any collision-course clip contains a spurious ~0 s sample seconds before the physical
conflict. Observed: PET 0.00-0.03 s at t=3-6 s with the real conflict at ~6.9 s and **zero collisions**.
The same trace is simultaneously "ACCEPT (critical)" and "min PET 0.00 s, wanted [0.2,3]".
Both independent agents (EXP-A and this run) lost most of their effort to this. It should be an
engine fix, not a per-template workaround.

### Lever 3 — yield-solved parameter box
Data-driven, from quartile response curves over 240 cells:
`arrivalTtc` [1.4,2.4]->[1.95,2.40] (yield 0.20->0.68 monotone),
`childSpeedKph` [7,12]->[7.0,9.4], `gapM`->[1.42,1.62], `dartLeadM`->[2.6,3.0].
This alone removed all 49 `physically_unavoidable` rejections.

## Open issues
- **el-camino-road yields 6/48** while yale is 48/48 — needs per-map diagnosis (likely speed limit -> ego speed).
- Child actor is instantiated at **h=1.75 m** (adult stature) against a 1.78 m SUV occluder. Occlusion
  is 2-D so height is ignored today; the moment G3 is fixed this scenario's vertical argument breaks.
  There is no child class in the actor catalog.
- Ego controller brakes with omniscient perception, decoupled from the occlusion metric: the passing
  trace's driver reacts to a child it cannot see. **This is a correctness bug for ML training data.**
- `invariant_unchecked` (17) is still a silent hole: a missing metric leaves a required invariant
  neither held nor violated.


---

# Session 2 — engine defects fixed, judge calibrated, LTAP unblocked

## Two engine defects found and fixed (both were corrupting scenario labels)

### D1 — `minPET` is a *prediction*, not post-encroachment time
`readPathConflict` extrapolates both actors along constant-velocity future paths every tick and
reports how nearly simultaneous their arrivals would be. Minimising that over a clip is not PET.
For an **arrival-solved near miss it is ~0 by construction**, because the arrival solver deliberately
aims the challenger at the conflict point in sync with the ego.

Proof on `easterbrook-discovery-school/09561123f54cf3fe` draw 4: engine minPET **0.007 s** at
t=5.50 s, zero collisions; **realized PET 0.940 s** — inside the authored band [0.2, 3.0].
Across one 240-cell batch, **63 of 110 `pet` invariant rejections were false rejections**
(58 with zero collisions).

Fix: `packages/engine/src/trace/realized-pet.ts` (+ 4 tests). Implements the textbook
definition, and follows Westhofen et al. in reporting PET as **undefined** when both actors occupy
the conflict area at once (that case is an encroachment; path-TTC describes it).

### D2 — `minDistance` reports a collision broad-phase proxy as a clearance metric
`readPair` computes `max(0, centreDistance - (r_a + r_b))` over **circumscribed circles**.
Car r=2.58 m + pedestrian r=0.42 m = 3.00 m, so every encounter closer than three metres reports
exactly **0 m clearance alongside zero collisions**. True footprint clearance on that cell: **0.421 m**.
This makes `clearance` intent criteria unfalsifiable at close range and would export false
near-miss distances as ML training labels.

Fix: `packages/engine/src/trace/min-clearance.ts` (+ 4 tests). Exact oriented-footprint separation.

Both modules are additive, exported from `sim-engine`, 8/8 tests pass, `tsc --noEmit` clean.

## Judge calibration — the answer to "how do we measure quality"
Full detail in `JUDGE-FINDINGS.md`.

- **Mechanism agreement 0.950** with **zero false positives** (54 TP / 3 TN / 3 FN / 0 FP).
  The judge never claimed a mechanism operated when it had not.
- Binary accept/reject agreement was only 0.60-0.70 — but the disagreement is a *consistent
  threshold choice*, not noise: on 30 verified cells it returned `mechanism_operated=True` 29 times
  while returning `genuinely_critical=False` 22 times, always citing the same quantities.
  Re-scoring the **same** judgments moves agreement to **0.867** at `clearance <= 0.6 m`.
- The judge independently rediscovered defect D2 from the trace alone.

**Rule adopted: deterministic gates own criticality thresholds (published catalog values); the LLM
judge owns mechanism and coherence.** Never show a judge a metric that has not been verified —
round 1's higher agreement was partly manufactured by the misleading `minDistance` field.

## LTAP/OD unblocked (named regression G1a)
`examples/ltap-opposing.template.json` matched **1 site across all 5 maps**. Cause was not the
matcher: the anchor required `control: signalized`, and the maps hold only 23 signalized junctions
total (yale 16, el-camino 6, richmond 1, belmont 0, easterbrook 0).

LTAP/OD at stop-controlled and uncontrolled junctions is a real NHTSA pre-crash type, so broadening
is archetype-faithful rather than a relaxation. Broadening alone produced `signal_unbindable` on
180/194 cells — precisely the failure `docs/research/retargeting.md` predicts when a signal trigger
survives onto a junction with no signal head. Split into two variants instead:

| Variant | Sites | Cells | Critical | Maps | Gates |
|---|---:|---:|---:|---:|---|
| `ltap-od-unsignalized-v2` | 33 | 198 | 12 | 3 | **PASS** |
| `ltap-od-signalized-v2` | 6 | 60 | 1 | 1 | fail (map inventory) |

Also required: clip 16 s -> 12 s and lower speeds (actors covered 242 m in 16 s against 172-205 m of
available route), and `requiredUpstreamRunwayM` 90 -> 60 so the arrival solver has slack.

## Corpus state
| Template | Cells | Critical | Yield | Maps | Sites | Gates |
|---|---:|---:|---:|---:|---:|---|
| `expB-child-parked-gap-v4` | 240 | 154 | 0.642 | 5 | 26 | PASS |
| `expA-child-dartout-two-cars` | 48 | 32 | 0.667 | 2 | 7 | PASS |
| `ltap-od-unsignalized-v2` | 198 | 12 | 0.061 | 3 | 4 | PASS |
| `ltap-od-signalized-v2` | 60 | 1 | 0.017 | 1 | 1 | fail |

**199 engine-accepted critical instances; all five maps covered.**
For `expB-v4`, all **154** were independently re-verified (occlusion `revealed_before_conflict`,
realized PET in band, true clearance > 0, zero collisions); **89** also meet the strict severity gate
(minTTC <= 3.0 s, clearance <= 2.5 m). Stratified severe/high/moderate = 23/20/111.

## Next
- LTAP yield is 6%: dominated by `invariant_unchecked` (66) and `no_interaction` (41) — the
  `conflicting_gate` binding is selecting gates that never actually conflict. This is the next
  matcher-level lever.
- Archetype diversity is still thin (2 mechanisms). Need cut-in, lead-brake, VRU-cyclist.
- `catalog verify` still exits 2.
- Occlusion remains 2-D (G3); the child is still instantiated at 1.75 m.


---

# Session 3 — pre-registered rubric enforced, gold corpus established

## The pre-registered rubric rejected my own tuning (and it was right)
`rubrics/occluded-child.rubric.json` is encoded verbatim from
`artifacts/agent/phase1-scene-model.md` section (c) — written by the scene-first agent **before it
read any JSON Schema or ran any simulation**. Bands were deliberately NOT relaxed to fit results.
SHA-256 registered in `occluded-child.preregistration.json`.

Run against v4 (the 64.2%-yield version): **223 of 240 cells REJECTED**, almost entirely on R3
(criticality). R1 trigger-fired 240/240, R4 no-collision 240/240, R2 occlusion 227/240 — but the
authored criticality target `minTTC in [0.5,1.5] s` failed 198/240, because v4's corpus sits at
minTTC 2.6-3.3 s.

**I had walked into the anti-goal.** Maximising `evaluate` yield optimised toward the permissive
gate — the postmortem's exact warning that iterative feedback "converges on passing the test".
Retuning against the *rubric* instead (`arrivalTtc` 1.95-2.40 -> 1.70-1.95, criticality invariant
switched from `pet` to `ttc` [0.5,1.6]) moved rubric-accept **17/240 -> 35/240**.

## Three independent signals converged on "the corpus is too safe"
1. the pre-registered rubric (minTTC <= 1.5 s),
2. the blind LLM judge (clearance <= 0.6 m),
3. and neither agreed with `evaluate`'s permissive accept band.
Only the deterministic `evaluate` gate was satisfied. Two of three independent checks said no.

## The judge found a gap in my own gate
Requirement 4 says reveal-to-conflict must be **in band**. I never enforced it. The judge did,
unprompted and repeatedly: *"the child is revealed about 6.1 seconds before the conflict... not
shortly before as required"*. Measured: only **25 of 240** v5 cells had reveal-to-conflict inside
the doc's 0.4-1.5 s band (median 3.14 s, max 12.8 s).

Attempted fix v6 (child waits hidden in the gap, `initialSpeedKph=0`) failed 240/240 with
`arrival_unconverged` — **the arrival solver bisects on spawn s and cannot solve for a stationary
actor.** A shortened hidden approach (start s=112, inside the park-a shadow at 107.6-123.0 m) ran,
but barely moved reveal-to-conflict: it is bounded below by the ego's own braking inflating
`conflictT`, not by the walk length.

## Judge calibration improved as ground truth improved
| Round | Ground truth | Agreement | kappa |
|---|---|---:|---:|
| 1 | engine verdict, misleading `minDistance` shown | 0.700 | 0.400 |
| 2 | engine + strict severity, corrected clearance | 0.600 | 0.200 |
| 3 | engine + pre-registered rubric | 0.560 | 0.120 |
| 4 | **full gate (all 6 requirements)** | **0.767** | **0.521** |

Decomposition matters: in round 3 the judge's *stated verdict* scored 0.560/0.120 while its
decomposed `mechanism AND critical` answers scored **0.680/0.360** on identical data.
**Ask a judge decomposed, objectively-checkable sub-questions; do not ask it for an overall verdict.**

## GOLD CORPUS — 9 instances passing every requirement
`gold/MANIFEST.json`, one directory per instance with trace, instance, result and evidence.

Gates each instance clears: portable template v2; engine ACCEPT band critical; pre-registered
rubric accept; reveal-to-conflict in [0.4,1.5] s; realized PET in [0.2,3.0] s; true footprint
clearance > 0; zero collisions; occlusion `revealed_before_conflict`; blind trace-judge reviewed.

- 4 maps (yale, belmont, easterbrook, richmond), **7 distinct sites**
- reveal-to-conflict 1.218-1.472 s · minTTC 1.386-1.498 s · realized PET 0.84-1.26 s · clearance 0.497-1.503 m
- blind judge: mechanism_operated **9/9**, genuinely_critical 8/9, accept 8/9
  (the single rejection is the 1.503 m clearance boundary case — a consistent standard, not an error)

## Still open
- `catalog verify` still exits 2 — **not addressed**.
- el-camino-road is absent from the gold set (its sites yield low criticality; needs per-map tuning).
- LTAP passes the engine gates but has not been through a pre-registered rubric or the judge.
- Archetype diversity remains thin: 2 mechanisms (occluded VRU, LTAP).
- Arrival solver cannot solve stationary actors — blocks the cleanest occlusion construction.
- Occlusion still 2-D; child still 1.75 m.


## `catalog verify` diagnosed (named regression)
Exit 2 with 6 `invalid_provenance` + 1 `catalog_digest_mismatch`, all on
`lane-change.lane-drop-late-merge`. Root cause is **matcher drift, not corruption**: the stored
`matcherSiteId` `2282b44455e98df3` is no longer what the matcher produces (`0a8fc7e0ff2a6cad`), and
`catalogDesignDigest` covers site bindings.

The 7 issues are the visible tip — **378 of 500 slot identities no longer reproduce** under the
current matcher, across 37 incident types. `catalog verify` failing is *correct behaviour*;
recomputing the 6 digests would be the silent re-bind `retargeting.md` explicitly forbids and would
hide the other 372.

`simforge catalog create` re-derives cleanly (verify exit 0, 0 issues). Re-derived catalog and a
full drift report are in `catalog-drift/`. **Not applied automatically** — the committed catalog is a
provenance artifact. Nothing downstream depends on it (`generated 0, simulated 0, visuallyAccepted 0`).


---

# Session 4 — second archetype, all five maps, harness defect fixed

## A verification-harness defect I shipped and then caught
My `verify()` counted collisions from `evaluate` findings. `evaluate` defaults to
`rejectCollisions: false`, so contact produces **no finding** — the harness reported
`collisions: 0` for `lead-hard-brake` while **159 of 288 cells actually had contact**.

Fixed: collisions are now read from `trace.metrics.collisions` directly. Re-audited every batch:

| batch | cells with contact |
|---|---:|
| expB-v4 (occluded child) | **0 / 240** |
| expB-v5 | 2 / 240 |
| lead-hard-brake | 159 / 288 |
| ltap-od-unsignalized-v2 | 34 / 168 |

The gold set was never affected — `full_gate` always read collisions from the trace. But the
lesson is the same one this whole project keeps relearning: **a gate that reads a summary instead of
the evidence will silently pass bad scenarios.**

## Archetype 2 — `lead-hard-brake` (NHTSA C1 / Euro NCAP CCRb)
Rubric pre-registered *before the template was ever run*, bands taken from
`docs/research/interactions-and-edge-cases.md` (TTC critical band, headway 0.6-4 s, lead decel
0.5-9 m/s^2), sha256 registered.

Out of the box it transferred to **all five maps**: 81/288 critical (28.1%), 25 sites.
Pre-registered rubric over 288 cells: L1 lead-brakes 244 pass, L2 ego-responds 205,
L3 event-order 205, L4 criticality 75, **L5 no-contact 129 pass / 159 fail**, L6 clearance 163.
75 cells passed both the engine gate and the rubric.

Under the full gate (engine critical + rubric + zero contact + TTC in [0.5,2.5] + clearance > 0 +
no never-fired trigger): **11 instances**, 3 maps, 9 sites, minTTC 0.617-1.001 s,
clearance 1.417-3.188 m. Includes **el-camino-road**, which the occlusion archetype never reached.

Blind judge: agreement **0.788**, kappa **0.533** — closely reproducing the occlusion archetype's
0.767 / 0.521 on a structurally different mechanism. On the 11 verified: mechanism 10/11,
genuinely_critical 8/11, accept 8/11.

## LTAP — passes engine gates, fails its pre-registered rubric
168 cells: `ego-turns-left` 168/168 pass, but `opposing-arrives` **0/168**, `no-contact` 134/168,
`opposing-does-not-stop` 91/168, criticality unchecked on 109.

`opposing-arrives` fails for a **representation reason, not a scenario reason**: `oncoming-commits`
is an `at t=0` `set` verb, and t=0 interactions are *folded into initial state* — recorded in
`manifest.initialInteractionOutcomes` as `outcome: executed`, never emitted as a trace
`trigger_fired` event. The rubric's `trigger` criterion therefore cannot verify any t=0 interaction.
**Representation gap worth fixing in `intent-rubric.ts`.**

The real failures remain: 34 cells with contact and 77 where the opposing vehicle stops despite
`yieldToVehicles=false` and `collisionAvoidance=false`. LTAP is **not** admitted to the gold corpus.

## GOLD CORPUS — 20 instances, 2 archetypes, all five maps, 16 sites
| Archetype | Instances | Maps | Judge agreement | Judge on gold |
|---|---:|---:|---:|---|
| C5 occluded child dart-out | 9 | 4 | 0.767 / k 0.521 | 9/9 mechanism, 8/9 accept |
| C1 lead hard brake | 11 | 3 | 0.788 / k 0.533 | 10/11 mechanism, 8/11 accept |

Union covers **all five maps**. Every instance carries its replay key, input hash, drawn parameters,
pre-registered rubric verdict, deterministic metrics, and blind-judge result.
