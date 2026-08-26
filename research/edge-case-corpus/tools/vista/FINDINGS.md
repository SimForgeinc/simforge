# FINDINGS — a VISTA-style visual harness for driving-scenario authoring

Lane 2 (visual). Worktree `SimForge-vista`, branch `vista-lane`.
Model: `gpt-5.6-luna`, reasoning effort `medium`, for every authoring, repair and judging call.
Frozen admission gate `1a08698e95fca4bc`, never relaxed. Independent evaluation lane ran in parallel
and is credited inline.

---

## 0. The short version

**Sight did not beat blindness.** Two independent DEV runs over the same 32 briefs, the same frozen
surface, and an *identical* numeric diagnosis — the only difference being whether the repair step also
received a rendered image — gave:

| | run 1 frozen | run 1 HQ | run 2 frozen | run 2 HQ |
|---|---|---|---|---|
| **sight** | 9/32 = 0.281 | 6/32 = 0.188 | 8/32 = 0.250 | 6/32 = 0.188 |
| **blind** | 10/32 = 0.312 | 9/32 = 0.281 | **15/32 = 0.469** | 11/32 = 0.344 |

Pooled over both runs: sight 17/64 = 0.266 vs blind 25/64 = 0.391, Fisher exact **p = 0.187**.
Consistent in direction across two runs, never significant. The honest statement is:
**sight did not help, and was directionally worse; the image did not pay for itself.**

Sight was genuinely exercised — 23/32 briefs saw at least one rollout render, 37/88 iterations — so this
is a real test of the hypothesis, not a harness that failed to show the picture.

**The biggest single result is not about sight at all.** The process is stochastic, and resampling it
is worth more than anything else measured here: across the first four DEV runs, **21 of 32 briefs (0.656) were
admitted at least once** (24/32 = 0.750 over all five DEV runs re-scored in §16), against a best
single-run rate of 0.469 — and the scenarios that resampling
buys are **no worse** than the ones it finds reliably (0.476 vs 0.451 judged-good, p = 1.0).

---

## 1. D1 resolved: the "placement defect" is the unrecorded warm-up

The brief's highest-value open question. Both prior measurements were correct; they measured different
instants, and neither was a materializer bug.

`trace t=0` is the state **after** `warmupSeconds` of simulation. During warm-up the ego closes on the
challenger at the relative closing speed, so an authored gap `G` is, at recorded t=0,

    G - warmupSeconds * (v_ego - v_challenger * cos(dHeading))

| map | authored gap | gap at t=0 | lost | predicted loss |
|---|---|---|---|---|
| yale-street | 82.00 m | 73.06 m | 8.94 m | **8.94 m** |
| yale-street | 80.44 m | 71.84 m | 8.60 m | **8.60 m** |
| belmont-research-center | 63.96 m | 57.23 m | 6.73 m | **6.75 m** |

Agreement within 0.02 m on 3/3 cells, reproduced independently by the evaluation lane
(|t0 − instance| = warmup·v₀ to 0.001 m).

This reconciles every symptom in the D1 report: placement *is* exact at instance level (the sub-agent
was right); it *is* compressed at trace t=0 (the author was right); the "cap near 13.6 m" is not a cap
but the loss scaling with v_ego; the 0.16 correlation follows because the loss depends on
(v_ego − v_chal), which is uncorrelated with the requested gap; and C2 failures starting a median 8.1 m
ahead versus 11.0 m for passes is the same arithmetic.

**The fix is authoring-side and general — no `packages/` change.** The reverted `coverTarget()` patch
addressed a cause that does not exist; leaving it reverted is correct.

**Effect on the brief's headline prediction.** C2 (closest approach at spawn) was 29.3% of admission
loss in the census. After the warm-up rule entered the authoring surface, C2 fell to **12–14%** of
clause failures, and C5 became dominant at 43–45%. So the predicted C2 recovery is real and largely
mechanical — but it was recovered by *arithmetic in the prompt*, not by looking at a picture. A blind
author given the same rule recovers it just as well. This is the cleanest example of the run's overall
shape: the wins were mechanism-level and modality-independent.

---

## 2. What actually decides admission

Measured over 552 (then 1083) simulated cells. These are properties of the evaluator, not opinions.

1. **A cell is accepted if and only if its findings list is empty.** 20/20 accepted cells had
   `findings == []`; every rejected cell had ≥1. There is no partial credit. (Independently confirmed
   by the evaluation lane: 19/19 and 9/9, a clean biconditional.)
2. **`required` invariants are the expensive kind.** A violated `required` invariant emits
   `invariant_violated` and loses the cell; 66 cells were accepted while carrying violated `preferred`
   invariants — including a `preferred` `near_miss` that recorded an actual collision. Demotion
   silences the *invariant*, not the *physics*: an impossible deceleration still emits
   `physically_unavoidable` on its own account. After this rule entered the surface, every template in
   the corpus used zero `required` invariants.
3. **minTTC must land ≤ 3.0 s**, and the common failure was landing at 3.2–4.1 s: just outside.
4. **A declared `occludes` you cannot prove is a rejection** (`occlusion_unproven`), and it cost 157 of
   549 otherwise-perfect cells.

### The dominant authoring error is overshoot, not timidity
Of 549 cells whose physics was otherwise perfect and which died on C5 alone:

| cause | cells |
|---|---|
| `physically_unavoidable` (ego needed more than the **7.85 m/s²** friction ceiling) | 110 |
| a real collision | 46 |
| `occlusion_unproven` | 157 |
| `materialization_infeasible` | 116 |

So **156 cells were too dangerous, not too safe**. An edge case has to be survivable; a guaranteed crash
is rejected exactly as firmly as a boring clip. This produced the survivable-band rule
(`d = v²/11` comfortable, `v²/16` impossible; at the 64 kph that dominates these maps, 29 m and 20 m).

---

## 3. The environment is a hard ceiling on some briefs

Measured from `topology-index.json.gz` and `derived/locations.json.gz`, and independently confirmed:

- **Speed limits are 64 kph almost everywhere** (960/1141 lanes on yale, 964/970 belmont, 563/563
  easterbrook). The shipped gold template asks for 25–60 kph and is therefore *degraded* at nearly every
  site it matches.
- **Adjacent parking lanes barely exist**: 18 / 1 / 0 / 0 / 3. "Emerges from between parked cars" is
  structurally hard on two of five maps.
- **`occlusion_zone` features are abundant** (61/87/96/7/24) — hidden-hazard scenarios are the best
  supported kind on these maps.
- **No map has a rail crossing at all.** `school_zone` exists only on easterbrook (2);
  `work_zone_suitable` only on el-camino (2).

Because admission requires **≥ 3 sites across ≥ 2 maps**, briefs that need those features are
**unadmittable by construction, at any authoring quality**. `c13-rail-crossing` and
`c8-construction-junction` are the two clearest cases in DEV. The four empty taxonomy categories in the
lane-1 baseline are very likely the same effect. Denominators should be quoted both ways:
**21/32 = 0.656, or 21/30 = 0.700 excluding the structurally impossible.**

---

## 4. Sight: where it helped, where it hurt

**It did not improve admission.** Two runs, matched briefs, identical surface hash, identical numeric
diagnosis: 9 and 8 (sight) against 10 and 15 (blind), pooled p = 0.187.

**It did not improve judged quality either.** The independent judge, controlling for the category-mix
confound it flagged *before* the numbers landed:

- run 1 pooled looked like a gap (sight 0.481 vs blind 0.633) but was entirely a category artifact.
  Category-matched: 0.458 vs 0.444, p = 1.0. Paired on the 4 briefs both modes admitted: 0.583 vs
  0.500, p = 1.0.
- run 2 reverses the sign (category-matched sight 0.476 vs blind 0.364). Two runs, opposite signs,
  nothing significant.
- Trajectory-derived difficulty: 62.7 (95% CI 55.9–69.3) vs 63.7 (57.3–70.0); difference −1.0 with a
  bootstrap CI of (−9.8, +8.1), spanning zero. An earlier eye-catching 57.8 vs 35.6 was n = 3 and was
  correctly withdrawn.

**The one asymmetry worth recording — run 1 only.** *Intent-not-realised* was more common under sight
(7/27 = 0.259) than blind (3/30 = 0.100): a genuine ego-vs-reversing-van conflict with no pedestrian in
it at all; a "tailgated brake" in which nothing tailgates; a stationary-animal pass-by instead of a
crossing. The mechanism is plausible and matches the failure the evaluation lane predicted in advance:
**a seeing author repairs what is visible — placement, geometry, whether boxes are on the road — and
does not notice that the brief's mechanism is missing.** Sight makes geometry right and semantics no
better. Run 2 does not replicate it (0.125 vs 0.178, reversed), so it is reported as run-1-only, not as
an established fact.

**Why sight plausibly costs something.** The image is expensive in attention and adds nothing the
numeric diagnosis does not already state more precisely. Clearance, closest-approach time, minTTC,
required deceleration and the evaluator's own reject codes are *exact*; a 64 m-wide top-down render is
not the way to read any of them. Sight is the wrong instrument for a problem whose ground truth is
already numeric and complete.

---

## 5. What did work

1. **Fixing the information the author receives.** Three of my own bugs each silently starved the repair
   step, and each was worth more than the imaging hypothesis:
   - the validator reports under `issues`, not `findings` — the repair prompt was being sent an *empty*
     finding list and could never converge;
   - `arrival_unconverged` and the other `error.code` / `reason` fields were being discarded, so the
     author was told only "error";
   - the evaluator's own reject codes (`trivially_safe`, `occlusion_unproven`, invariant residuals) were
     not being surfaced at all.
2. **Telling the author what the world contains** (section 3). Before this, ~1 iteration in 3 was spent
   discovering that an anchor matched nothing.
3. **A cheap anchor pre-check.** `sites match` before `batch` turns "no sites" into a fast sub-loop
   instead of a wasted authoring iteration.
4. **Keeping the best attempt.** Repairs make things worse often enough to matter (a measured
   1 passing cell → 0 in one step). Carrying the best template forward and expanding *it* across more
   sites at the end converted near-misses into admissions — one brief went 1/10 → 10/76 across 3 maps.
5. **Best-of-N resampling** — see section 7. This is the largest single lever found.

---

## 6. The sampling hypothesis, tested and rejected

Because only ~8% of cells pass, a 10-cell probe might plausibly be *undersampling* good templates.
Tested directly: every non-admitted DEV template re-run over ~150 cells (10 sites × 3 draws × 5 maps),
no re-authoring. **Only 2 of 22 recovered.** Most produced 0 passing cells out of 150.
The failures are real; the probe size was not the bottleneck.

---

## 7. Best-of-N: the one lever that buys yield without costing quality

The loop is stochastic. Across four DEV runs:

| N | mean union (frozen) | max |
|---|---|---|
| 1 | 0.328 | 0.469 |
| 2 | 0.500 | 0.594 |
| 3 | 0.602 | 0.625 |
| 4 | **0.656** | 0.656 |

Union of all four: **frozen 21/32 = 0.656, HQ 20/32 = 0.625** — i.e. **95.2% of everything best-of-N
admits also clears the tightened quality gate.**

Reliability spectrum: 11 briefs never admitted, 7 in 1/4 runs, 9 in 2/4, 3 in 3/4, 2 in 4/4.

**And the extra briefs are not junk.** Independently checked: briefs admitted in only 1 of 4 runs scored
0.476 judged-good, versus 0.451 for briefs admitted in ≥3 of 4 (p = 1.0). Resampling buys real
archetypes.

Two caveats, both honest:
- the four runs span **two** surface hashes, so the union confounds resampling with the run-2 surface
  change. Decomposed: within run-1 surface 15/32, within run-2 surface 18/32. **Resampling alone gets
  ~15–18; the full 21 needs both.**
- a best-of-N rate is a **max statistic** and is only comparable to the 0.312 baseline if lane 1 also
  got N attempts. It must be applied identically to HELDOUT or the generalisation gap is manufactured.

---

## 8. Admission is not quality: the run-2 lesson

Run 2's surface changes lifted blind admission 0.312 → 0.469, comfortably past the lane-1 baseline.
The independent judge then showed what it cost:

| | admitted | judged good | quality-adjusted yield |
|---|---|---|---|
| blind run 1 | 10 | 0.633 | **6.33** |
| blind run 2 | 15 | 0.400 | **6.00** |
| sight run 1 | 9 | 0.481 | 4.33 |
| sight run 2 | 8 | 0.542 | 4.33 |

**The +50% admission was paid for one-for-one in quality. The number of scenarios that survive an
independent judge did not move.** Reporting 0.469 as progress without this line would be misleading.

The mechanism is instructive and was predicted-against: giving the author an explicit *impossible*
threshold (`d = v²/16`) turned that threshold into a **target**. Cells previously rejected as
`physically_unavoidable` came back as admitted-but-marginal. `NEAR_COLLISION_BY_TIMING` rose from 0.333
to 0.536 of judged cells.

**A regression I introduced.** "Do not declare `occludes` unless hiding the hazard *is* the scenario"
removed the only constraint keeping props out of the ego's path — the occlusion solver. `EGO_INTERSECTS_PROP`
rose from 0.067 to 0.333 of blind's admitted cells (p = 0.01); my own counter of `Q3_noPropOverlap`
failures rose 17 → 77 (blind) and 18 → 53 (sight). Props are `collidable:false` **and** absent from
`ticks['actors']`, so **neither the engine nor the frozen gate ever objects to the ego driving straight
through a parked SUV.** Only the added Q3 clause catches it. This is the clearest demonstration in the
run that the frozen gate alone is not a sufficient definition of a good scenario.

---

## 9. The gate: audited, and tightened where it was wrong

The frozen C1–C5 gate is left **exactly** as pre-registered so the head-to-head stays comparable. It was
independently audited; my OBB clearance was verified exact against three implementations (worst
disagreement 3.4e-13 m) and against the engine's own `exact-sampled-obb-clearance` (0.000 m, same tick).

The audit found real holes, all closed by an **additional** quality layer (tightening is permitted;
loosening is not). `passHQ = pass AND Q1..Q7`:

| clause | what it closes |
|---|---|
| Q1 joint challenger | C2, C3 and C4 were never required to name the *same* actor, so any slow vehicle within 5 m of the corridor was a free pass |
| Q2 ego really responded | measured from the ego's own speed trace; `metrics.requiredDecelMax` reported 3.0 for an ego with an observed peak deceleration of 0.0000 |
| Q3 no prop overlap | the ego driving through a non-collidable prop — invisible to the engine and to the frozen gate |
| Q4 heading sane | `headingRad` must agree with `atan2(vy,vx)` |
| Q5 not clipped | `metrics.clippedCriticality` |
| Q6 TTC pair is the ego | `minTTC.pair` was never checked to involve the ego |
| Q7 contested space | 9/57 frozen-gate-admitted cells had paths that never overlapped *even with timing removed* |

Q7 uses `pathSeparationM` — the minimum true-OBB clearance over **all pairs** of tick indices, which
cleanly separates spatial separation from temporal separation. The measure and its implementation
(`judge/conflict.py`) are the evaluation lane's work.

**A frame convention worth recording, because it is a trap aimed straight at a visual harness.** Instance
files store position as `(x, z)` with `z = −y`, but `headingRad` is *already* in the `(x, y)` frame and
must **not** be negated. A mirrored oriented bounding box renders completely plausibly in a top-down PNG,
so a seeing author would confidently "repair" a fault that does not exist. Sight makes this failure mode
worse, not better.

**One methodological note against interest:** the evaluation lane's initial headline —
"the min-clearance instant is never the actual conflict", firing on 28/28 cells — was **its own bug**, a
bearing test rather than a path test, and it was retracted with a corrected instrument. Under the correct
measure, 28/28 cells are genuine encroachments and **C3 is scoring the right instant**. A flag that fires
on everything is an alarm about the flag.

---

## 10. Honest limits

- Every sight-vs-blind comparison here is n = 32 per cell. Nothing reached significance; the direction
  was consistent across two runs but the pooled p is 0.187.
- The corpus is not ~100 archetypes. DEV best-of-N reaches 21/32 distinct briefs.
- Best-of-N confounds resampling with a surface change; the clean version is N independent runs at one
  frozen surface on both splits.
- Run 2's surface raises admission and does not raise quality-adjusted yield. It should not be presented
  as an improvement to the corpus.
- The prop-overlap regression is live in the surface frozen for HELDOUT. It is caught by Q3, so HQ
  numbers remain trustworthy, but the frozen-gate HELDOUT number is inflated by it.

---

## 11. HELDOUT — authored once, through a surface frozen by hash

Surface frozen at `sha256 b634be8042cf2cd02f3fea39b2d3391bd86f25cb7b999528df42164f8e7f8484` **before**
the HELDOUT run and not modified afterwards. Identical hash to DEV run 2. Zero per-brief tuning.
Both arms run on all 60 HELDOUT briefs.

| | DEV (run 2) | HELDOUT | gap |
|---|---|---|---|
| sight, frozen gate | 0.250 (8/32) | **0.333** (20/60) | −0.083 |
| sight, HQ gate | 0.188 (6/32) | 0.150 (9/60) | +0.038 |
| blind, frozen gate | 0.469 (15/32) | **0.367** (22/60) | +0.102 |
| blind, HQ gate | 0.344 (11/32) | 0.167 (10/60) | +0.177 |

**Sight and blind converge on HELDOUT** (0.333 vs 0.367). Blind's large DEV-run-2 advantage did not
generalise — it fell from 0.469 to 0.367 — which is further evidence that the run-2 surface change
bought admission rather than capability. Both arms exceed the lane-1 HELDOUT baseline of 0.317.

### Best-of-N applied identically to both splits
The one honest way to quote a max statistic. N = 2 (sight ∪ blind), same frozen surface, same procedure
on DEV and HELDOUT:

| | DEV | HELDOUT | **gap** |
|---|---|---|---|
| frozen gate | 0.562 (18/32) | **0.600** (36/60) | **−0.037** |
| HQ gate | 0.438 (14/32) | 0.250 (15/60) | +0.188 |

**Whole corpus, 92 briefs: 54 admitted = 0.587 under the frozen contractual gate**, against the lane-1
baseline of **29/92 = 0.315**. That is 1.86× the archetypes at a generalisation gap of **−0.037**, i.e.
no overfitting — HELDOUT is very slightly *better* than DEV.

Under the strictly tighter HQ gate (frozen gate **plus** Q1–Q7): **29/92 = 0.315**. That equals the
lane-1 corpus count while clearing seven additional quality clauses that the frozen gate does not test.

### Correction: the apparent HQ generalisation gap was an instrument change
The +0.188 in the table above is **not** a generalisation failure and should not be read as one.
`Q7_contestedSpace` was added *after* DEV run 2 and *before* HELDOUT, so the two splits were scored with
different gates — visible directly in the records, where DEV `qualityLoss` has six keys and HELDOUT has
seven. Recomputed from the traces with a single gate applied to both splits:

| | HQ **with** Q7 | HQ **without** Q7 |
|---|---|---|
| DEV best-of-2 | 9/32 = 0.281 | 14/32 = 0.438 |
| HELDOUT best-of-2 | 15/60 = 0.250 | 27/60 = 0.450 |
| **gap** | **+0.031** | **−0.012** |

Both are ≈ 0. **The quality layer generalises fine.** This was caught by the evaluation lane, which
reproduced each published number and identified which gate had produced it. The lesson is procedural:
adding a clause mid-study silently made two numbers incomparable, and it looked exactly like a real
scientific finding.

### Which Q clauses actually carry weight
Per-cell loss over frozen-passing cells (DEV-sight / DEV-blind / HELD-sight / HELD-blind):

| clause | loss rate | verdict |
|---|---|---|
| **Q7 contested space** | .208 / .275 / .421 / .203 | dominant on both splits; rescues 3/4/7/5 briefs on leave-one-out |
| Q3 no prop overlap | .188 / .158 / .075 / .123 | real and load-bearing |
| Q6 TTC pair is ego | .042 / .075 / .045 / .145 | modest |
| Q2 ego really responded | .036–.058 | modest |
| Q1, Q4, Q5 | .000 everywhere | **never bind — they cost nothing and prove nothing.** Demote to diagnostics |

So the audit clause that mattered was not the one I expected: it is Q7, the requirement that the two
actors ever contest the same ground.

### A bug in Q7 worth recording
`contested_space()` originally caught `ImportError` and returned `None`, and `quality()` mapped `None`
to `Q7 = True`. Running the gate from any working directory where `judge.conflict` was not importable
therefore **silently disabled the clause and inflated the HQ rate — no error, no log line.** It was
found when the evaluation lane's own attribution run hit exactly that path and measured Q7 loss as
0.000 everywhere. Now fixed to fail closed: the import is deliberately unguarded, so a missing measure
raises instead of vanishing. **A quality clause that quietly turns itself off is worse than no clause,
because it looks like it ran.**

---

## 12. Recommendation

Given the objective — the best achievable rate **without** trading away quality — the evidence supports
a deliberately simple method, and specifically **not** the imaging hypothesis this lane was built to test:

1. **Author blind.** The image did not pay for itself in either admission or judged quality, cost wall
   clock, and in run 1 made the author more likely to satisfy the geometry while dropping the brief's
   mechanism. Keep the renderer — it is invaluable for *human* inspection and it is how several of the
   defects here were found — but do not put it in the repair loop.
2. **Spend the effort on the information the author receives instead.** Surfacing the evaluator's own
   reject codes, the real error codes, and a measured inventory of what the maps contain was worth far
   more than sight, and all three were originally bugs or omissions in the harness.
3. **Resample.** Best-of-N is the largest lever measured, and it is the only one with **no** quality
   penalty (0.476 vs 0.451 judged-good, p = 1.0). N = 2 nearly doubles the corpus over a single run.
4. **Gate on quality-adjusted yield, not admission.** Run 2 is the cautionary case: +50% admission,
   zero gain in scenarios that survive an independent judge.
5. **Keep the Q layer, and fix the prop regression.** `Q3_noPropOverlap` is the only thing standing
   between the corpus and scenarios in which the ego drives through a parked SUV, because props are
   `collidable:false` and absent from `ticks['actors']`.
6. **Accept the environmental ceiling.** Rail, school-zone and work-zone briefs cannot reach two maps.
   Either add map inventory or drop those briefs from the denominator explicitly.

---

## 13. The corpus that was actually produced

Collected from all six runs (DEV ×4, HELDOUT ×2), keeping the best version of each brief:

| | this lane | lane-1 baseline |
|---|---|---|
| archetypes admitted (frozen gate) | **57** | 29 |
| of those, passing the tightened HQ gate | **35** | not measured |
| taxonomy categories covered | **14 / 15** | 11 / 15 |
| portability violations | **0 / 57** | — |
| replay determinism | **40 / 40 bit-identical** | 156/156 |
| wall clock | ~210 s per brief | ~35 s per brief |

Category spread: C2 cut-in-merge 8, C5 pedestrian 7, C8 workzone 6, C9 hazard 6, C1 car-following 5,
C7 occlusion 5, C3 intersection 4, C6 cyclist-ptw 4, C11 parking 3, C10 oncoming 2, C12 school 2,
C14 loss-of-control 2, C15 adversarial 2, C4 roundabout 1.

**The single empty category is C13.control.** I originally attributed this to authoring — that a signal
phase change is not by itself an encounter — and that was wrong, or at least not the binding reason.
Measured later by the independent capability workstream: **0 of 16 cells had a signal stop line on the
ego's actually-driven route.** The phase changes, it is recorded in the trace, `SignalBook.authorityAt`
returns the correct authority, and `distanceToStopLine` finds nothing, because the bound programs put
their stop lines on lanes the ego never drives (ego on `612:0:-1, 0:0:-3, 775:0:-3, 1:0:-3`; programs on
`26:*, 72:*, 128:*, 74:*`). **A signal scenario can be authored, materialised, simulated and ACCEPTED
while the signal governs nobody.** That is the worst class of defect in this project, because it looks
like it worked. Recorded as Defect 4 in `newcaps/DEFECT-signal-authority.md` with two reproducers.

**Portability was verified mechanically, not assumed** (`collect.py:portability_check`): no `anchor.pin`,
no `sourceMap`, no `scene_absolute` role, no baked map name, no road/lane/site identifier. 0 violations
in 57 templates. Requirement A holds — the emitted artifact is a logical anchor over road structure, and
every scenario materialises at ≥ 3 sites across ≥ 2 maps it was never authored against.

**Cost.** ~210 s per brief against the baseline's ~35 s, roughly 6×. Most of it is model latency across
up to three authoring iterations plus a final multi-site expansion; the simulation itself is seconds.

---

## 14. The one place sight ever looked better — and how much weight it can carry

On HELDOUT, restricted to the **6 briefs both arms admitted** (same sentence, same gate, same frozen
surface), the judged-good rate was:

| | good / cells | rate |
|---|---|---|
| **sight** | 17/18 | **0.944** |
| blind | 9/18 | 0.500 |

Fisher exact **p = 0.0072** — the only significant result in the study. Driven by `c3-ev-crossing`
(3/3 vs 0/3), `c2-parking-cut-in` (3/3 vs 1/3), `c2-blind-spot` (2/3 vs 1/3).

**How much weight this can carry, stated so it is not over-claimed:** n = 6 briefs; it is one of roughly
20 comparisons run in this study, so a Bonferroni-corrected threshold puts it at ≈ 0.14 and it is **not
significant after correction**; and it did **not** replicate on either DEV run (paired 7/12 vs 6/12, and
6/15 vs 7/15). Pooled across all three runs, paired: sight 30/45 = 0.667 vs blind 22/45 = 0.489,
p = 0.13.

The defensible sentence is: *on the held-out split, restricted to briefs both arms admitted, the seeing
arm produced markedly better scenarios (0.94 vs 0.50, p = 0.007 uncorrected); this did not replicate on
either DEV run and should be treated as a hypothesis for a powered rerun.*

It is nevertheless the shape the rest of the evidence predicts: **sight does not get more briefs through
the gate, but when both arms clear the same brief, the seeing arm's version tends to be the better
scenario.** Quality-adjusted yield on HELDOUT is dead level — sight 20 × 0.450 = 9.00, blind
22 × 0.409 = 9.00.

---

## 15. Is this corpus fit for training data? No — it is a candidate pool

The independent judge's blunt assessment, over 252 judged cells, and I agree with it:

- **45–60% of frozen-gate-admitted cells are rejected by an independent quality judge in every run.**
  On HELDOUT, 55% of sight cells and 59% of blind cells are boring, intent-not-realised, or invalid.
- **~24% never realise their brief.** Their taxonomy *label is wrong*, which is worse than a missing
  scenario, because it teaches the wrong association.
- **Mean novelty (R3) is 2.1–2.4 across every run and never moved under any intervention.** The corpus
  is not novel; it is *competent*. Nothing done here made scenarios more distinctive — a fair result
  given that no intervention targeted novelty.
- Coverage ceiling: 21/32 DEV briefs admitted at least once; 11 never admitted at all.

**The three numbers should be reported separately and never conflated.** All three are best-of-2,
one gate, applied identically to both splits:

| tier | count | meaning |
|---|---|---|
| gate-admitted (candidate) | **54 / 92 = 0.587** | passes the frozen contractual gate |
| quality-gated | **24 / 92 = 0.261** | also passes Q1–Q7 |
| judged fit | **≈ 15** | also survives an independent judge at high/acceptable (measured, §17) |

**Do not call any of this a training corpus until the intent-not-realised rate is under ~10%.** The
honest description of the 57 is a *candidate pool* that a judge must still filter. That is a real
improvement on a baseline of 29 whose corpus-layout judge called it "inadequate" — but it is an
improvement in yield, not a solution to the quality problem.

### What would actually raise quality, on this evidence
Nothing measured here moved novelty or intent-realisation. The two concrete leads are:
1. **Verify intent, don't just verify physics.** ~24% of admitted scenarios do not contain the mechanism
   their brief names. The judge can detect this; the gate structurally cannot, because the gate only
   reads trajectories. Putting an intent check *inside* the loop — reject and re-author when the named
   mechanism is absent — is the highest-value untested change.
2. **Novelty needs an explicit objective.** R3 never moved because nothing ever optimised it. Diversity
   against the already-admitted corpus, rather than against the brief alone, is the obvious mechanism.

---

## 16. Definitive numbers — every run re-scored with ONE gate

Because `Q7` was added mid-study, the tables above mix two instruments. Every run was therefore
re-gated from the raw traces with a single current gate (`regate.py`). **These are the numbers of
record.**

| run | n | frozen | HQ (Q1–Q7) |
|---|---|---|---|
| DEV run 1 sight | 32 | 0.281 | 0.156 |
| DEV run 1 blind | 32 | 0.312 | 0.156 |
| DEV run 2 sight | 32 | 0.250 | 0.094 |
| DEV run 2 blind | 32 | **0.469** | 0.219 |
| DEV run 3 blind (prop rule) | 32 | 0.406 | 0.219 |
| HELDOUT sight | 60 | 0.333 | 0.150 |
| HELDOUT blind | 60 | 0.367 | 0.167 |

### Generalisation, like-for-like (best-of-2, same N and same frozen surface on both splits)

| gate | DEV | HELDOUT | **gap** |
|---|---|---|---|
| frozen (contractual) | 0.562 (18/32) | **0.600** (36/60) | **−0.037** |
| HQ (Q1–Q7) | 0.281 (9/32) | 0.250 (15/60) | **+0.031** |

**Both gaps are ≈ 0: neither the authoring surface nor the quality layer is overfitted to DEV.**
HELDOUT is very slightly *better* than DEV on the frozen gate.

### Against the baseline — one N, applied identically everywhere

An earlier draft of this section paired the *largest available* count (a union over five DEV runs and
two HELDOUT runs) with a gap computed at N = 2, which breaks the rule stated in §11. Corrected: **every
number below is best-of-2, the same procedure on both splits, one gate.**

| | this lane | lane-1 baseline |
|---|---|---|
| HELDOUT rate, frozen gate | **0.600** | 0.317 |
| whole corpus, frozen gate | **54/92 = 0.587** | 29/92 = 0.315 |
| whole corpus, HQ gate (strictly harder) | **24/92 = 0.261** | not measured |
| of those, expected to survive an independent judge | **≈ 15** (measured, §17) | not measured |
| generalisation gap, frozen | **−0.037** | −0.004 |
| generalisation gap, HQ | **+0.031** | — |

**The comparison against the baseline is not like-for-like and should not be quoted as 1.86×.**
Lane 1's 29 is *one arm, one run*; best-of-2 is a max over two arms. Single-arm, same frozen surface,
whole corpus:

| arm | corpus | vs baseline |
|---|---|---|
| sight | 28/92 = 0.304 | **0.97×** — at or slightly below it |
| blind | 37/92 = 0.402 | **1.28×** |
| best-of-2 | 54/92 = 0.587 | 1.86×, but the baseline never got a second attempt |

**The defensible claim is 1.28× single-arm, or 1.86× with best-of-2 against a baseline given one
attempt.** Running the baseline surface twice would settle it and has not been done.

They are also **candidate** archetypes, not archetypes: 45–60% are rejected by an independent judge
(§15). The baseline's 29 were never judged either, so this does not undermine the count comparison —
it undermines the word.

### A negative result on my own fix
DEV run 3 added the prop-placement rule ("keep props out of the ego's driving line") to address the
regression in §8. It **did not work**: frozen admission 0.406 vs 0.469, HQ identical at 0.219, and
per-cell `Q3_noPropOverlap` failures rose from 0.069 to 0.132. Telling the author where *not* to put
props appears to have made it place more of them. The prop problem remains open, and `Q3` remains the
only thing catching it.

### Reproducibility from the committed artifacts
Six templates drawn at random from the committed corpus were re-run from a clean state at a *reduced*
site budget (`--max-sites 4` against the 8–10 used originally): **4/6 still admit**. The two that did
not each produced 2 passing cells and missed only the "≥ 3 distinct sites" clause — a sampling artifact
of the smaller budget, not a defect in the template. Replay determinism was separately verified at
**40/40 bit-identical** via `evidence verify`.

---

## 17. External validation: the physics-only quality layer predicts an independent LLM judge

The strongest evidence that the Q layer is measuring something real, rather than my own preferences.
Over all **252 judged cells**, with `passHQ` recomputed independently by the evaluation lane:

| | HQ-pass | HQ-fail | Fisher |
|---|---|---|---|
| judged **good** | 80/130 = **0.615** | 37/122 = 0.303 | **p < 1e-6** |
| judged **invalid** | 2/130 = **0.015** | 30/122 = 0.246 | **p < 1e-6** |

Two independently built instruments — mine physics-only, theirs an LLM with vision — agree strongly.
**The Q layer doubles the judged-good rate and all but eliminates `invalid`.** This is a better argument
for the tightening than any admission count, because the two instruments share no code, no inputs beyond
the trace, and no author.

It also converts the earlier extrapolated "≈ 13 judged fit" into a measured figure:
0.615 × 24 ≈ **15** like-for-like.

### The one thing the quality layer cannot do — and it is the important one

| | HQ-pass | HQ-fail | Fisher |
|---|---|---|---|
| intent-not-realised | 0.185 | 0.164 | **p = 0.74** |

**Identical.** Every clause in the gate and in the Q layer is a physics clause, and no physics clause
can tell whether the brief's *mechanism* is present. A clip in which a car is simply already in the
ego's lane has exactly the same trajectory statistics as one in which a car cuts in. **The quality layer
has taken physics as far as physics goes.**

This is the direct motivation for the critic (§18), and it is why the remaining ~18% intent failure rate
cannot be fixed by tightening the gate further.

---

## 18. The critic in the loop — application (b) from the brief, built and measured

A second agent watches the **rendered rollout** and rules on one question only: *does the clip contain
the mechanism the brief names?* It never sees the template, the gate result, or the author's reasoning —
only the brief and the pictures — so its verdict is independent of the thing it is checking.

This is the one place where sight is the right instrument. The repair loop's question ("is the clearance
small enough?") is numeric, and the trace answers it exactly; an image is strictly worse. The critic's
question is *semantic*, and **no number in the trace answers it** — §17 shows intent-not-realised is
statistically identical for cells that pass and fail every physics clause I have (0.185 vs 0.164,
p = 0.74).

Validated against ground truth before use: it accepts the gold dart-out (confidence 0.94) and rejects a
brief whose mechanism is absent from the same clip (confidence 0.98, *"There is no oncoming vehicle
turning left across the ego path"*), while still correctly noting the clip contains a genuine conflict.

### Critic-vs-gate agreement — the requested deliverable

Run in-loop over DEV (blind arm, 32 briefs):

| | |
|---|---|
| gate-admitted | 8/32 |
| critic **agreed** the brief's mechanism is present | **4/8 = 0.500** |
| critic **vetoed** | 4/8 = 0.500 |
| final admitted (gate **and** critic) | 4/32 = 0.125 |

**The critic rejected half of what the frozen gate admitted — but on n = 8 briefs**, Wilson 95% CI
(0.215, 0.785). That interval is far too wide to quote 0.50 as a point estimate; the defensible claim is
that a large fraction fails, not that it is exactly half. Applied to the full 60-scenario corpus:
**19/60 = 0.317 intent-verified**, of which **10** also clear the physics quality gate, across 11
categories.

**Two independent intent checks, built from different evidence, both find a large intent-failure rate
that the gate cannot see** — but they are not the same number and should not be pooled as one:

| instrument | unit | rate | 95% CI |
|---|---|---|---|
| this lane's critic | brief-level, n = 8 | 0.500 | (0.215, 0.785) |
| evaluation lane's judge, intent-specific only | cell-level, n = 252 | 0.302 | (0.248, 0.361) |

Fisher exact p = 0.255 — **consistent, not identical, and both intervals are wide.** The judge's
headline 0.45–0.60 is a *five-dimension* rejection rate; decomposing it, 0.302 is intent-specific
(intent-not-realised + invalid) and a further 0.234 is novelty/boredom, which has nothing to do with
intent. Only the 0.302 is comparable to my critic.

**The lane-1 baseline's 0.517 is deliberately excluded from that comparison.** It is *category
agreement* — whether a judge assigns the same taxonomy label — and a scenario can realise its brief
perfectly while being labelled C7 instead of C5, or vice versa. It is context, not a third intent check.

So the supportable statement about the baseline is the weaker one: *its 29 archetypes were never
intent-checked, and on this evidence a substantial fraction would fail such a check.* The specific
figure of ~50% is **not** supported.

### What the critic actually catches
Verbatim, and these are errors no trajectory statistic can see:

- `c9-animal` — *"No animal is present; the actor crossing near the ego is a pedestrian."* The scenario
  is filed under C9.hazard with an animal in its name and contains no animal.
- `c1-tailgated-brake` — *"There is no vehicle behind the ego, so the ego is not being tailgated."*
  Caught four times running; the gate admitted it every time.
- `c8-taper-merge` — *"There is no visible lane-closure taper forcing a lateral merge."*
- `c6-dooring` — *"The cyclist does enter the ego's path, but no parked-car door opening is shown."*

These are **mislabelled** scenarios, which §15 argues is worse than a missing one: a corpus that teaches
"animal crossing" from a clip containing a pedestrian teaches the wrong association.

### It repairs as well as rejects
`c11-double-park` was vetoed at iteration 2 (*"the truck is not shown becoming double-parked or moving
into and blocking the ego lane"*), the critic's specific complaint was fed back as the repair
instruction, and the re-authored version was accepted 2/2 at the final expansion. The critic is not only
a filter; its feedback is actionable in a way the gate's numbers are not.

### The cost, split so the critic is not blamed for more than it did
Two separate drops are easy to conflate:

| step | rate | attributable to |
|---|---|---|
| run-2 blind arm, gate-admitted | 0.469 | — |
| critic-in-loop run, gate-admitted **before any veto** | 0.250 | run-to-run variation, **plus** possibly the critic's feedback changing what the author attempts |
| after the critic's veto | 0.125 | **the veto itself** |

**Only the 0.250 → 0.125 step is the critic.** The first drop is not cleanly attributable and should not
be charged to it. The veto is the correct direction — it removes scenarios that were never valid rather
than degrading capability — but it means an intent-verified corpus needs **best-of-N on top of the
critic**, not instead of it.

## 19. Final state of the corpus

| tier | count | verified how |
|---|---|---|
| gate-admitted candidates (best-of-2) | **54 / 92** | frozen contractual gate, 0 portability violations, 40/40 replay-deterministic |
| \+ physics quality gate Q1–Q7 | **24 / 92** | doubles the independent judge's good-rate, near-eliminates `invalid` (§17) |
| \+ intent verified by the critic | **10–19** | a second agent confirms the brief's mechanism is on screen |

**The honest headline: 54 candidate archetypes at a generalisation gap of −0.037, of which 24 clear a
strictly tighter quality gate and 10 of those are also confirmed by an independent critic to contain
the event they claim — against a single-attempt baseline of 29 that was never intent-checked at all.**

Separately, and on a different denominator: **19 of the 60 scenarios produced across all runs were
intent-verified** by the critic, 10 of them also clearing the quality gate. The nested chain is
54 → 24 → 10; the 19 is not a subset of the 24 and must not be quoted as though it were.

---

## 20. Method note: how the errors in this study were actually caught

Both lanes shipped wrong results and then corrected them. The corrections came from one mechanism, and
it is the most transferable thing here.

**Errors this lane published and then had to fix:**
- a headline pairing an N = 5 count with an N = 2 generalisation gap, breaking a rule stated two
  sections earlier in the same document;
- three different corpus counts (54 / 57 / 60) in one report;
- `Q7` failing *open*, so a quality clause silently disabled itself and inflated the rate it was meant
  to protect;
- a headline nesting error implying 19 intent-verified scenarios were a subset of the 24 quality-gated
  ones, when only 10 are;
- pooling three rejection rates that measure three different things as "convergence".

**Errors the evaluation lane published and then retracted:**
- a `PROXIMITY_IS_NOT_THE_CONFLICT` headline firing on 28/28 cells, which was a bearing test rather
  than a path test — its own bug;
- nearly reporting this lane's `Q7` as broken when it was the reviewer's own import that was disabled;
- a report generator printing a directional claim backwards.

**Not one of these was caught by careful reading.** Every one was caught by *measuring the same thing
twice by different means and treating the disagreement as a bug until proven otherwise*: OBB clearance
against three implementations and the engine's own invariant; admission re-derived from raw traces by
both lanes independently; the Q layer checked against an LLM judge sharing no code with it; conflict
geometry measured by bearing and then by all-pairs path separation.

The corollary, in the reviewer's words, is that **an adversarial reviewer has to be adversarial toward
its own instruments first** — and the specific tell worth internalising is that *a flag which fires on
everything is an alarm about the flag, not a finding.* Both lanes hit that exact failure, in opposite
directions, within a day of each other.

---

## 21. Scaling to training data: what actually changed

The objective moved from "beat a baseline admission rate" to "produce thousands of training-grade
scenarios per day". That reframing exposed problems the earlier framing could not see.

### The validator was the bottleneck, and it was not trustworthy
An independent audit measured the vision-only critic at **precision 0.545 (CI 0.280-0.787), recall
0.333, FP rate 0.085** over 77 ground-truth pairs — **statistically indistinguishable from accepting
everything** (base rate 0.409, Fisher p = 0.31). Its errors were perceptual, not linguistic, measured
against facts the trace settles exactly:

| question the trace answers exactly | critic recall |
|---|---|
| does this actor move? | 0.800 |
| **does it enter the ego's lane?** | **0.500** |
| **does it slow sharply?** | **0.440** |

It missed half of every lane incursion. Verbatim on one case: the critic said a challenger *"remains in
its own adjacent circulating lane"* when it had moved **16.58 m laterally** and turned **88.8°**.

**Worse, it had certified my highest-yield template.** `c9g-displaced-drain-grate` — source of 302 of
310 harvested cells — is a confirmed false positive: the grate never moves, sits 4.83 m from the ego
path, and is never occluded. **The previously reported ~1,300 scenarios/day is retracted**; it was
mostly one non-existent mechanism replicated across sites.

### The fix: compute what is computable, and see only what is not
`motion.py` + `hybrid.py` invert the labour. An LLM reads **only the brief text** and selects from a
closed vocabulary of 18 predicates; **code evaluates them against trace geometry exactly**; the vision
critic is demoted to a **veto on the non-computable residue** (occlusion, "unexpectedly", a door
opening). A predicate the vocabulary cannot express returns `abstain` rather than a guess.
Scored 6/6 on hand-labelled cases including three adversarial negatives on the same clip.

Two bugs found and fixed while building it: a pedestrian who simply stops reported **109 m/s²** of
braking (a dt = 0.02 s sampling artifact — now a 0.3 s windowed measure), and "two parked vehicles"
was being counted as two challengers when parked cars are **props**, absent from `ticks['actors']`.

### The co-travel rule: a clean A/B win
Diagnosed by rendering a failure and adjudicating it myself — a van meant to travel alongside the ego
spent **9 of 13 seconds far ahead in another lane**, converging only in the final frame. The surface
now requires sustained co-travel for alongside/repeatedly/tailgating briefs. On the **identical 84
briefs**, only the surface differing:

| | admitted | **intent-realised** |
|---|---|---|
| surface v3 | 27/84 | **7/27 = 0.259** |
| surface v4 (co-travel) | 28/84 | **14/28 = 0.500** |

Admission was flat; **intent realisation doubled** — which is exactly the axis that matters, and exactly
the axis the old validator could not measure.

The dominant residual failure is `challenger_enters_ego_path` (missing 18-30 times per run): **getting
another road user to actually move into the ego's lane is the hardest thing to author.**

### Measured end-to-end throughput

| stage | time |
|---|---|
| author 84 generated briefs, 6 workers | 64 min |
| intent-verify 28 admitted templates | 167 s |
| harvest 7,620 concrete simulations | 247 s |
| **total** | **71 min** |

28 admitted → **11 intent-verified** → **204 distinct training-grade scenarios**
→ **≈ 4,140 distinct training-grade scenarios per day.**

Yield concentration is now healthy: the top template contributes **31%**, against 97% (from a false
positive) in the retracted run.

### Two more gate clauses, both found by measurement
- **Q8 `noBodyOverlap`** — the frozen C3 bounds clearance from above only, so a true clearance of
  **0.00 m** satisfies it. On one site the ego and lead are both 4.8 m long yet **4.453 m apart
  centre-to-centre** — interpenetrating — with `collisions == []` and `evaluate` returning
  `accept/critical`. **39 of 65 gate-passing cells were the ego driving through the car in front.**
- **Q7 corrected.** It originally required paths to literally intersect; the median cell it rejected
  missed by **0.20 m**, and it would reject any legitimate close pass. Relaxed to a 2.0 m path
  separation.

### Honest counting
`gate.deduplicate()` bands cells by (map, site, clearance/0.5 m, minTTC/0.5 s, decel/1 m/s²). One
template produced 302 "training-grade" cells that collapsed to **134 distinct**, with ego peak
deceleration varying by **sd 0.02 m/s²** across all 302. Only deduplicated counts are reported.

### Brief supply is no longer the limit
`briefgen.py` generates fresh briefs, constrained to the engine's actual primitives (describe observable
motion, never internal mechanical causes — the simulator cannot burst a tyre or jackknife a trailer).
That cut unbuildable briefs **31% → 4%**. Generated briefs author at 0.32-0.39, the same as the
hand-written ones. It did **not** by itself raise intent realisation — a negative result; the
co-travel rule did.

---

## 22. Corrections forced by the second independent audit

Two numbers I published did not reproduce. Both are corrected here; the conclusions they supported
survive, but the arguments were wrong.

### "39 of 65 gate-passing cells were interpenetrations" — did not reproduce
That specific batch contains only **5** C1–C5-passing cells. Wherever the 39/65 came from, it was not
that batch, and it should not have been quoted. The correct figure is from a scan of **3,390
accept/critical cells across 13 runs**:

| | n |
|---|---|
| cells passing the frozen gate C1–C5 | 1,642 |
| …of which the ego truly interpenetrates another body | **482 = 29.4%** |

**The finding is confirmed and understated.** On the worked case the ego's footprint is **62.5%
inside** the lead's (5.70 m² of overlap, 1.80 m depth) sustained for **5.36 s**, with
`metrics.collisions == []` and `evaluate` returning accept/critical. Root cause, independently
established: **the engine's collision detector misses 50.5% of true interpenetrations**, so C5's
"zero collisions" clause carries almost no information. Q8 is doing work nothing else does.
Sub-tick aliasing was ruled out: 16× supersampling over 667 cells found **zero** hidden contacts, so
the 0.10 m threshold is a rendering convention, not a sampling safeguard.

### "The median Q7-rejected cell missed by 0.20 m" — did not reproduce
Measured over the population Q7 actually filters, the median is **1.973 m**, roughly 10× my figure.
My 0.20 m came from a small non-representative sample.

**The 2.0 m threshold is nevertheless right, for a reason I did not give.** Adjacent 3.5 m lanes
carrying 1.9 m-wide vehicles leave a body-to-body gap of about **1.6 m**, so any threshold below
~1.9 m makes adjacent-lane conflicts *structurally impossible* to express. The number stands; the
justification is lane geometry, not a sample median.

**And Q7 had a real hole**: it ignored timing entirely, so **10.8%** of the cells the relaxation
rescued had the two bodies on the same ground **more than 4 s apart** — which is not a conflict.
Q7 now requires `pathSeparationM <= 2.0 AND encroachmentGapS <= 4.0`.

### My lane-incursion predicate was inverted, and worse than I reported
I attributed the dominant residual failure to authoring. The auditor showed the **predicate itself**
was broken: `ego_frame_offsets` had **no longitudinal gate**, so a body 100 m off to the side scored a
huge lateral offset, and the moment the ego turned the projection collapsed below the threshold and
was scored as "entered my lane". Independently measured **precision 0.375**, firing **253** times when
nothing entered anything — false positives with start-lateral offsets of 102.57 m, −67.64 m and
−40.26 m on bodies the engine says moved 0.16–0.67 m sideways.

Corrected with a 30 m longitudinal gate and corroboration from the engine's own `lateralOffsetM`.
Firing rate on a held sample fell **0.681 → 0.404**, against an independently measured true rate of
**0.286**. One caveat found while fixing it: `lateralOffsetM` is identically ~0 for `relative_to`/
route-bound actors (it is measured against their own path), reading 0.00–0.06 m throughout the gold
dart-out, so it **cannot** be used alone — it would reject a textbook incursion.

**The volume consequence is the real finding: only 28.6% of gate-passing cells truly contain a lateral
incursion.** That is an authoring limit, and the broken predicate had been concealing how bad it is.

### Two more validator bugs, both mine
- **`challenger_oncoming` never checked relative heading.** It fired on 22 actors of which 16 were
  travelling the *same* direction — precision **0.136**. An ordinary lead vehicle satisfied every
  condition. Now requires a relative heading ≥ 120°.
- **Near-tautologies were being accepted as the central requirement.** Base rates: `challenger_is_ahead`
  **1.000**, `ego_brakes_hard` 0.889, `static_obstacle_present` 0.644 — and one template was admitted
  on `static_obstacle_present` alone. A verdict now abstains if it rests only on predicates with a base
  rate above 0.6.

### Deduplication was too LAX, not too aggressive
The 310 → 61 collapse reproduced exactly, and the signature was vindicated on the axes it uses
(0/109 groups mixed different challengers). But cells kept as "different lessons" differ by **11 cm of
clearance and 0.065 m/s²** while being identical in closest-approach time and path separation. All
three banded fields are **outcome magnitudes — precisely what parameter jitter perturbs.** The
signature is now over conflict *structure*: road-user kind, conflict geometry, whether an incursion
occurred, and coarse timing.

### Also corrected
- `Q1` and `Q5` **never fire on any of 1,642 cells** — they cost nothing and prove nothing.
- I raised a concern that `Q2` was weakened by one-tick freezes; the auditor tested it and **withdrew
  it** (2 cells of 1,642). Q2 is left alone.
- **No vehicle in this engine can reverse** (1 body in 1,642 moved >0.8 m backwards), so briefs naming
  a reversing manoeuvre are unbuildable and are now filtered at generation.

---

## 23. The capability workstream: what was actually missing, and what only looked missing

I dispatched five parallel agents to implement the functionality that a user-supplied list of 67
edge-case topics could not express. The headline result is not the code. It is this:

**Four of five gaps turned out to be capabilities that already existed and were unreachable.**

| gap | what I claimed | what was true |
|---|---|---|
| reverse | "no vehicle can reverse" (1 body in 1,642 moved >0.8 m backwards) | reverse works under `kinematic-v1`; under `dynamic-v1`, **the default**, the body detaches from its route entirely — `s` pinned at 0.0001 m and `laneRsl` null for all 601 ticks across 30/30 cells, all rejected `no_interaction`. Authoring is via `role.extensions.motionSemantics`, a `z.record(z.string(), z.unknown())` field absent from all three published JSON Schemas, so no LLM author can discover it |
| catalog | "no animal id, no debris, no traffic furniture" | the entire construction and debris inventory already existed — `construction.jersey_barrier`, `hazard.tire_debris`, `street.shopping_cart` — under names no author reaches for. Only `animal.*`, `hazard.ladder`, `hazard.mattress` were genuinely absent |
| sensors | "no sensor model" | correct, and worse: `sensors` is **silently stripped** by `parseSimScenarioInput`, so a template can declare them, validate clean, and simulate as if it never said anything |
| signals | "no blackout or flashing arrow" | correct, plus a live defect: `phaseForbidsEntry` classified a dark signal (`off`) as **PERMISSIVE**. Every scenario ever run with a blackout had the ego drive straight through at speed; the law is an all-way stop. `flashing_red` was treated as a solid red — wrong in the opposite direction |
| lanes | "87.8% of sections are single-lane, so cut-ins are unbuildable" | **a group-counting artifact of mine.** See below |

### The single-lane claim was wrong, and it was steering the authoring
I counted *groups*, where a group is a `(road, laneSection, side)` row on roads averaging ~13 m. That
denominator is close to meaningless. Measured properly:

- **30.1%** of driving lanes sit in a corridor two or more lanes wide
- **22.9%** of matchable corridors have `throughLanesSameDir >= 2`, on **all five maps**
- a template requiring `[2, 8]` matches **23 sites across 4 maps at verdict `exact`, on unmodified code**

So multi-lane cut-ins, zipper merges and lane splitting were buildable the whole time.

**And the real defect was found in the process.** `pose.laneOffset` is SILENTLY DISCARDED for
`on_reference` roles in `adapt.ts`; `relative_to` `dLane` clamps unconditionally; `framePosePoint`
falls back to the reference lane with only a note. `template validate` reports ok in every case. So
when this document told authors to "start in the adjacent lane", they wrote the natural thing —
`kind:"on_reference"` with `pose.laneOffset:-1` — it was thrown away, and the actor spawned in the
ego's own lane and sat there. That is exactly the tripled spawned-already-in-lane defect and the
measured **0.521 -> 0.238** collapse in true incursion rate. The one binding that works,
`kind:"lane_offset"`, is the one an author is least likely to reach for.

### The pattern worth generalising
Of five gaps, one was a genuine absence (a sensor model), one was half-absent (animal models), and
three were **discoverability or default-path failures**. In every one of those three the capability
existed, was reachable only through an undocumented or non-default path, and failed silently when
reached the obvious way. That is a far more dangerous failure mode than a missing feature, because a
missing feature announces itself and a silent fallback does not: the scenario still validates, still
simulates, still passes the gate, and is simply not what it claims to be.

The authoring surface has been corrected accordingly: it now exposes **54 catalog ids and 26 aliases**
instead of 18, names `kind:"lane_offset"` as the binding that carries a lane offset, and no longer
tells authors that adjacent lanes do not exist.

### Two engine defects recorded independently of the feature work
- `newcaps/DEFECT-signal-authority.md` — blackout classified permissive; `flashing_red` as solid red.
- `newcaps/DEFECT-reverse-route-detachment.md` — `dynamic-v1` computes `trackingYaw = yaw + PI` while
  the actor is registered with the authored pose heading equal to the route tangent rather than
  tangent + PI, so tracking starts 180 degrees wrong and steering saturates. The two physics backends
  disagree about what a route means for a reversing actor.

Both would have produced confidently mislabelled training data, and neither is visible from any metric
the gate reads.

### Delivered so far
- `caps-catalog` — 22/22 green. `animal.deer` is 1.76 x 0.46 x 1.62 (a deer, not a human); aliases
  resolve to real footprints; `construction.pedestrian_barrier` no longer materialises as a 1 m cube;
  and **class/catalog agreement is now enforced for every class**, so the live defect I captured —
  a role tagged `class:animal` filled with `pedestrian.adult_walking` — is a hard error.
- `caps-surface` — 11/11 and 5/5 green. Localised surface patches with taper, overlap resolution and
  no grip leakage into neighbouring lanes, so "black ice on the bend" no longer means making the whole
  world slippery. Signal blackout and flashing arrows with correct right-of-way.

---

## 24. Measured throughput on a clean machine, with the FP-0 validator

Every earlier throughput figure in this document was taken on a compromised setup: up to 31 orphaned
worker processes competing for CPU, a CLI that resolved `@simforge-oss/*` to the MAIN checkout rather
than the worktree, and a JSON parser that silently discarded whole briefs. Those numbers are withdrawn.
This one is measured end to end after all three were fixed.

| stage | input | output | wall clock |
|---|---|---|---|
| author (6 workers, 2 runs x 84 generated briefs) | 168 briefs | 46 admitted templates | ~122 min |
| intent-verify (`predicates` AND `critic@enh`, the FP-0 config) | 46 templates | **11 verified** | 458 s |
| harvest (8 sites x 20 draws, 5 maps) | 11 templates | 8,420 simulated -> 407 training-grade -> **218 distinct** | 325 s |

**218 distinct training-grade scenarios in 135 minutes = ~2,324 per day** at 6 workers.

Every one of those 218 passes the frozen gate `1a08698e95fca4bc`, the Q1-Q8 physics quality layer, and
an intent check requiring a mechanical trajectory validator and an independent vision critic to AGREE
(audited precision 1.000, false-positive rate 0.000 on 49 negatives).

### Where the time actually goes
Simulation is free: 8,420 concrete scenarios in 325 s, and a standalone measurement put it at
~25,000/hour on 4 workers. **93% of the wall clock is LLM authoring.** The scaling lever is therefore
templates per hour, not cells per template — and cells per template saturates anyway, at roughly 50
distinct behaviours before parameter draws stop producing new ones.

### The honest bottleneck
11 verified from 46 admitted is 24%. That is the conjunction doing its job: `predicates` alone runs at
a 0.102 false-positive rate, which is corpus poisoning, and the AND buys precision 1.000 at the cost of
recall. For a training corpus that is the right trade, because a false positive is permanent
mislabelling and a false negative only costs yield — and yield is the cheap thing, since another 84
briefs cost an hour of machine time and nothing else.

### Delivered artifacts
- `/tmp/vista-dataset/` — `train.jsonl` (7 archetypes, 189 scenarios), `test.jsonl` (3 archetypes,
  29 scenarios), `MANIFEST.json`. **Split by ARCHETYPE, not by scenario**: no mechanism appears in both
  halves, so a model cannot see the same situation at a different site and score it as generalisation.
- `/tmp/vista-showcase-final/` — 20 ego-centric renders, 8 frames each, ego ringed, with measured
  clearance / minTTC / actual braking in the caption so a picture can be checked against its numbers.

---

## 25. The capability workstream, completed: five for five

All five parallel workstreams landed, verified end to end through the CLI, and committed. The gold
regression is unchanged after all of it (3/3 frozen, 3/3 HQ, every Q clause clean), and all eight
packages typecheck clean.

**Every single workstream's headline finding was the same shape, and it was not the one I predicted:
the capability existed and was unreachable, or was reachable and broken in the default path.**

| workstream | what I claimed was missing | what was actually true |
|---|---|---|
| reverse | "no vehicle can reverse" | reverse existed, authored only via `role.extensions.motionSemantics` — a `z.record(z.string(), z.unknown())` field absent from all three published JSON Schemas — and then **broken under `dynamic-v1`, the default backend**, by a sign error in the tyre-slip model |
| catalog | "no animal / debris / traffic furniture" | the entire construction and debris inventory existed under names no author reaches for. Only `animal.*`, `hazard.ladder`, `hazard.mattress` were genuinely absent |
| sensors | "no sensor model" | correct, and worse: `sensors` was **silently stripped** by `parseSimScenarioInput`, so a template could declare them, validate clean, and simulate as if it had said nothing |
| signals | "no blackout or flashing arrow" | correct, plus `phaseForbidsEntry` classified a dark signal as **PERMISSIVE**, and stop lines were bound to lanes the ego never drives — **0 of 16 cells** had a stop line on the driven route |
| lanes | "87.8% single-lane, so cut-ins are unbuildable" | **a group-counting artifact of mine.** 22.9% of corridors are multi-lane on all five maps. The real defect was `pose.laneOffset` being silently discarded |

Two of my five diagnoses were wrong. Three agents corrected my *measurements* rather than my code.

### The reverse root cause, because it is the sharpest example
```
frontSlip = atan2(vy + lf*r, |u|) - steerRad            // as written: unsigned
frontSlip = atan2(vy + lf*r, |u|) - direction * steerRad // fixed
```
A tyre is symmetric: the lateral slip velocity a steer `d` produces is `-u·sin(d)`, which changes sign
with `u`. So a reversing car yawed the **opposite way to the command**, every correction was positive
feedback, steering saturated in ~3 s, and the body left its route — `s` pinned at 0.0001 m and
`laneRsl` null for all 601 ticks across 30/30 cells, every one rejected `no_interaction`. Forward
motion is bit-identical (`direction = +1`). Verified after the fix: median 4.40 m rearward, max 9.11 m,
20/30 cells over 3 m, heading held to 0.0°.

### Authoring traps found, now surface rules 19-24
- **A carriageway hazard must be a ROLE with `static: true`, never a prop.** Props have no actor track;
  criticality metrics iterate actors only, so a prop-authored obstacle has **no TTC and no PET by
  construction**.
- **The ego stops short of a static obstacle rather than passing it** (s=44.7 against a hazard at
  s=50). "Ego passes debris closely" is close to unauthorable with collision avoidance on — which is
  why the whole static-hazard family reads as physically-valid-but-boring.
- **Never author the avoidance as a t=0 route polyline.** It removes the collision course, so the pair
  is never scored: 30/30 cells with `minTTC: null` despite a correctly placed hazard. Triggered
  `laneOffset` records on 26/30. General form: *an evasive action authored as an initial condition
  deletes the conflict it was meant to evade.*
- **Engine criticality metrics go stale after an avoidance** — one case reported `minDistance 15.83 m`
  when the true closest approach was 2.03 m. `evaluate` reads those, so a real near miss can be graded
  `trivially-safe`. (My gate is immune: it recomputes OBB clearance from raw ticks.)
- **A negative constant `s` on an `on_reference` role silently zeroes site matching.** Swept
  `-50 … -1` and the JSON number `-35`: **0 sites on every map**, no clause attributed, no validator
  finding. The same value as an unfoldable expression matches 3 sites per map. The safer-looking
  authoring is the one that fails.

### Engine defects recorded independently of the features
`newcaps/DEFECT-signal-authority.md` (blackout permissive; flashing_red as solid red; stop lines on
un-driven lanes), `DEFECT-reverse-route-detachment.md` (the slip sign, and the two backends disagreeing
about what a route means for a reversing actor), `DEFECT-self-occlusion.md` (real but latent — 0 of
14,309 declarations affected, so my occlusion rule stands), `DEFECT-negative-role-s-infeasible.md`,
and `OPEN-reversing-pedestrian-golden.md`, which I deliberately left red rather than re-baseline.

### A methodological failure of my own worth recording
For several hours I reported "`npx tsc --noEmit` clean" as evidence the tree was healthy. **There is no
root tsconfig in this repo**, so that command silently prints help and exits 1 — it was checking
nothing. Per-package typechecking immediately surfaced real errors that had been hiding, including four
in `cli` caused by an exhaustiveness gate that a released agent's change had broken. Verifying with a
command whose failure mode looks like success is worse than not verifying.

---

## 26. Final delivered corpus

Two harvests, merged, split by archetype with zero leakage (verified: 0 shared archetypes between
train and test).

| | scenarios | archetypes |
|---|---|---|
| train | 283 | 12 |
| test | 10 | 3 |
| **total** | **293** | **15**, across all 5 maps |

Categories represented: C1 car-following, C4 roundabout, C5 pedestrian, C7 occlusion, C9 hazard,
C11 parking, C12 school, C14 loss-of-control, C15 adversarial.

Every scenario passes the frozen gate `1a08698e95fca4bc`, the Q1-Q8 physics quality layer, and an
intent check requiring a mechanical trajectory validator AND an independent vision critic to agree
(audited precision 1.000, false-positive rate 0.000 on 49 negatives). All templates are portable
ScenarioTemplate v2 with no coordinates and no road ids.

**Artifacts**
- `/tmp/vista-dataset-all/` — `train.jsonl`, `test.jsonl`, `MANIFEST.json` (merged, the one to use)
- `/tmp/vista-dataset/` and `/tmp/vista-dataset-user/` — the two source corpora separately
- `/tmp/vista-showcase-final/` (20 renders) and `/tmp/vista-showcase-user/` (14 renders)

**The user-topic corpus specifically**: 56 briefs converted from a 67-topic list, 12 admitted,
5 intent-verified, **75 distinct training-grade scenarios**. Notably `low-friction-stop-slide` — a car
sliding through a stop-controlled junction into the ego's path at 1.269 m closest approach with the ego
braking at 6.78 m/s^2 — is the "black ice" topic, and it is only expressible because of the localised
surface-patch capability added during this session. Before it, road friction was a single scene-wide
scalar and that scenario could not be written.

### Throughput, restated on the delivered work
The generated-brief corpus measured ~2,324 distinct training-grade scenarios/day at 6 workers
(s24). The user-topic corpus ran at 230 s/brief with 2.96 mean iterations and yielded 75 distinct from
56 briefs in ~3.6 h of wall clock including validation and harvest. The user list is harder than
generated briefs — it is dominated by intersection, control and adversarial cases, historically the
worst-performing categories — so 0.214 admission against 0.32-0.39 on generated briefs is expected
rather than a regression.

---

## 27. RETRACTION: "all 67 red-light-runner scenarios are at exact-match signalized junctions"

Last turn I reported that the 67 `c15g-red-light-runner` scenarios sat at `score=1.0 verdict=exact`
signalized junctions, and concluded that site selection was therefore *not* the problem and the engine
must be failing to run signals at genuinely signalized junctions. **The first half of that is false and
the conclusion was reached the wrong way.**

The archetype's anchor clause is:
```
control: { value: ["signalized","uncontrolled","minor_stop","all_way_stop"], essentiality: "preferred" }
```
Every junction on every map satisfies that. `verdict=exact` did not mean "exactly a signalized
junction"; it meant "exactly satisfied a clause that accepts anything". All 8 bound sites are
`uncontrolled` or `minor_stop`, and their own manifests say `"uncontrolled junction as requested"`.

I read a matcher verdict as a statement about the world when it is only a statement about a clause.
The clause was vacuous, so the verdict was vacuous, and I built a confident inference on top of it.

### What is actually true (diag-signals, with file:line evidence)
- `ticks.signals` is non-empty **iff** `SimScenarioInput.signalPrograms` is non-empty
  (`sim-engine/src/sim/engine.ts:363,2493,2590`).
- Map-derived programs exist only where the OpenDRIVE `<junction>` element carries `<controller>`
  children: **6 of 246 junctions** across all five dev maps.
- `deriveControl` (`map-intel/src/build/junctions.ts:277-303`, `SIGNAL_RADIUS_PAD_M=22`) labels a
  junction `signalized` when *any* `traffic_light` point falls within `sizeM/2 + 22 m` of its centre.
  It never checks the head sits on one of the junction's own roads, that it is dynamic, or that a
  `<controller>` references it. **17 of the 23 "signalized" junctions have zero signal records on
  their own roads** — they inherited a neighbour's lights through the 22 m pad. Yale junction 387,
  which map-intel's own tests call "a signalized four-way", is 51 m from the real signalized junction
  345 and has 0 signal elements and 0 controllers.
- `rules.obeySignals` is inert when both `signalPrograms` and `roadControls` are empty:
  `distanceToStopLine` returns null on `signals.isEmpty` (`controllers.ts:461`). The `set(...)`
  interaction fires a `state_set` event that nothing reads. That is the case for all 67 cells.
- Downstream the absence is silent by design: intent-rubric signal criteria return `unchecked` rather
  than `fail` (`trace/intent-rubric.ts:272`), `{kind:'signal'}` triggers never fire
  (`sim/triggers.ts:129`), and `set(signal:*.phase)` overrides are dropped (`signals.ts:206`).

### The part that changes the plan
**A template can author a working signal today**, via the portable `trafficControls` block
(`scenario-model/src/schema/v2/traffic-controls.ts`, lowered at `materialize.ts:2354-2391`). Proven on
an *uncontrolled* belmont junction: an authored three-phase head produced 651 samples of signal state
and brought the ego to a full standstill at the line (min speed 0.00 m/s, against 5.73 m/s in the
unmodified control run). So signals are **not** blocked on upstream map fixes — the corpus simply never
authored them. The RoadRunner gap is real and worth reporting upstream, but it is not the reason my
scenarios have no lights. **My scenarios have no lights because they never asked for any.**

This is the sixth instance of the recurring pattern: the capability existed and the default authoring
path never reached it.

---

## 28. WS-1 baseline: locations, measured two independent ways

Two instruments, built independently, agree.

### Instrument A: blind VLM plausibility critic (`loccritic.py`, M1.4)
Renders a WIDE-AREA context view (95 m span, with map-intel crosswalks, bus stops and building
entrances overlaid) and asks one question only: *is this a sensible PLACE for the situation in the
brief?* It never sees the archetype id, the site score, or the match verdict.

**Baseline 45/78 = 0.577.** Negative control, judging each scene against a brief from a DIFFERENT
archetype: **30/78 = 0.385**. Discrimination +19.2 points, z=2.40, p<0.05 — real, but noisy, and I
should not over-read a single archetype's score.

| archetype | plausible |
|---|---|
| c15g-red-light-runner, c4g-circulating, c9g-pedestrian-behind-bus, low-friction-stop-slide | 6/6 |
| blind-crest-queue, c1g-cut-in-turn | 5/6, 5/5 |
| c11g-wrong-way-aisle, child-from-parked-cars | 4/6 |
| c11g-indicator-mislead | 1/6 |
| **c11g-hidden-child, c12g-red-pedestrian-phase, parked-vans-narrow-road, c12g-suv-ignores-paddle, rideshare-door-pedestrian** | **0** |

The critic's stated reasons are specific and repeatable: school briefs staged at *"a large isolated
interchange with no buildings, entrances, or visible school surroundings"*; parking briefs at *"a
large multilane interchange with ramps and no parking lot"*.

### Instrument B: fact survey (`newcaps/DIAG-locations.md`)
Independently, and without seeing the critic:
- **Zero roundabouts exist on any of the five maps** (246 junctions: 179 uncontrolled, 41 minor_stop,
  23 signalized, 3 all_way_stop). `c4g-circulating-sudden-stop` is 6/6 `exact` regardless. 24
  delivered scenarios of a roundabout conflict with no roundabout anywhere.
- `blind-crest-queue` asks for feature kind `crest`, which is **not in the matcher's
  `FeatureKindSchema`**. `template validate` says *"feature kind \"crest\" is not matchable; feature
  dropped"* — as a NOTE — then proceeds. All 5 sites score an identical 0.89 and sit 142-272 m from
  the nearest real crest; 2 are on a map with no crest at all.
- All four parking archetypes have their parking predicates **deleted by the adapter** with the note
  *"the matcher has no parking-zone predicates"*. 0 of 20 sites have parking adjacent. One site is a
  **1.14 m segment**; another a **105 kph 3-lane one-way**.
- `c9g-pedestrian-behind-bus` binds a parked-car occluder rather than any of the 14 mapped bus stops:
  0/7 sites, nearest stop 34-194 m.
- **275 occlusion zones carry an already-computed `supported_scenario_templates` whitelist that
  nothing reads** — `child_dartout_from_parked_cars` on 267 of them. A ready-made answer to one of my
  worst archetypes, sitting unused in the index.

### The two instruments agree on which archetypes are broken
Every archetype the VLM scored 0 is one the fact survey shows has a deleted or vacuous predicate.
That agreement is the reason I trust a p<0.05 instrument at all.

### Why `--min-score 1.0` is the wrong lever
It keeps only 5 of 15 archetypes alive — 7 have zero exact sites map-wide — and for 3 of the 5
survivors it changes nothing semantically (exact-only still leaves c15g 33/57 uncontrolled). **Score
1.00 / verdict `exact` means "every clause bound", and a clause listing all four control types as
`preferred` binds everywhere.** An exact match against a vacuous requirement is vacuous.

This is the same lesson as s27, one layer out: I keep reading a conformance verdict as a statement
about the world.

---

## 29. Full baseline scorecard, measured before any WS-1/2/3 change

`audit.py` computes every mechanically checkable acceptance clause and reports **NOT MEASURED** rather
than defaulting to a pass when an input is missing. A scorecard that degrades to "ok" when its input is
absent is worse than no scorecard.

| measure | baseline | target | pass |
|---|---|---|---|
| M1.1 place fit (mechanical) | NOT MEASURED (instrument is WS-1b's) | >=0.95 | - |
| M1.2 delivered scenarios at `exact` sites | **112/293 = 0.382** | >=0.95 | no |
| M1.3 archetypes with >=4 usable sites | **15/15** | 15/15 | yes |
| M1.4 blind plausibility critic | **45/78 = 0.577** (neg control 0.385) | >=0.777 | no |
| M2.2 median ambient within 60 m at t=0 | **0** | >=3 | no |
| M2.3 queue formation | NOT MEASURED (no ambient actors exist) | >=0.50 | no |
| M2.5 closest partner is ambient | **0/293** | 0 | yes (vacuously) |
| M3.1 3D exports | NOT MEASURED (no INDEX.json) | 100% | no |
| M4.4 briefs claiming an absent signal | **88/293 = 0.300** | 0 | no |

### M2.5 passes only because there is nothing to hijack
Zero ambient actors means zero chance one of them steals the metric subject. This clause is vacuous
today and becomes load-bearing the moment WS-2 lands. I am recording it as a *vacuous* pass so that a
later reader cannot mistake it for evidence the protection works.

### C6 (M4.4) is live and correct on adversarial input
The new clause rejects a scenario whose brief names a traffic signal when the trace carries none.
It scores 10/10 on hand-written traps, including the three that matter:
`"the lead car signals left but turns right"`, `"driver leaves the indicator on"`, and
`"the bus driver signals to pull out"` are all correctly NOT signal intent. On real data
`c11g-indicator-mislead` claims 0 signals across 14 scenarios, which is right — it is about a turn
indicator, not a traffic light.

**C6 rejects 88 of 293 delivered scenarios (30.0%)**: all 67 `c15g-red-light-runner` and 21 of 26
`c12g-red-pedestrian-phase`. The gold regression is unchanged at 3/3 frozen, 3/3 HQ with C6 armed.

### M1.2 is necessary but NOT sufficient, and I want that on the record
`c4g-circulating-sudden-stop` has **261 exact sites and 24/24 delivered scenarios at `exact`** — for a
roundabout scenario, on a map set containing **zero roundabouts**. `c15g-red-light-runner` is 67/67
`exact` with no signalised junction anywhere in its bound set.

An `exact` verdict certifies that every clause bound. It says nothing about whether the clauses asked
for the right thing. Chasing M1.2 alone would let me "fix" locations by loosening clauses until
everything matches exactly, which is the precise opposite of the goal. **M1.1 (declared context
actually satisfied) and M1.4 (blind plausibility) are the measures with teeth; M1.2 is a guard against
silent degradation, nothing more.**

### Audit of WS-4's C6 change (parent second eye, verified not assumed)
`git diff` on `gate.py` shows **8 deletions, none of which touch a C1-C5 clause body** — they are the
two function signatures, the result-dict assembly, and the `lossCounts` key tuple, all rewritten to
carry C6. The clause computations are byte-identical, and `pass` is a pure conjunction
`c1 and c2 and c3 and c4 and c5 and c6`, so C6 can only ever turn a pass into a fail. **Strictly a
tightening, as required.** `c6 = (not wants_signal) or hasSignalState`, so it is inert on any brief
that does not name a signal. Gold regression after the change: 3/3 frozen, 3/3 HQ, all six loss counts
zero.

### Audit of WS-3's export-render-lib change
`validateCorpusScenarioResult` drops 5 checks from `validateScenarioResult`. Three are catalog
reservation provenance, as its comment claims. **Two are not** — `artifactHashes.instanceSha256` and
`.traceSha256` are exact file-byte bindings, so the comment "deliberately NOT a weaker check" was
stronger than the code justified. I then checked the artifacts: batch-produced `result.json` carries
neither `artifactHashes` nor `catalogSlot` (0 of 60 sampled), because those are written by the catalog
batch writer, which this pipeline does not use. The checks are therefore unenforceable on our corpus
and dropping them is the only option; the semantic bindings that DO exist (`inputHash`, `instanceId`,
`mapId`, `traceDigest` vs `sha256Json(trace)`) are checked. Design stands. **M3.2 must be reported as
"semantic hash equality + actor-id equality", never as "full catalog integrity".**

---

## 30. WS-4 signals: 3 of 4 measures met, and the RoadRunner handoff shipped

**M4.1 MET** — `newcaps/DIAG-signals.md` (24 KB), file:line evidence, re-runnable commands.

**M4.2 MET** — `newcaps/HANDOFF-roadrunner-signals.md` (17 KB), written for someone who does not know
this repo. Counted directly from the delivered `map.xodr` files:

| map | `<junction>` | junctions with a **working** signal | `<signal>` records | of which `dynamic="yes"` |
|---|---:|---:|---:|---:|
| yale-street | 56 | **4** — 134, 303, 345, 447 | 143 | 69 |
| richmond-field-station | 31 | **1** — 238 | 39 | 12 |
| el-camino-road | 68 | **1** — 590 (+1 wired-but-uncontrolled: 2218) | 73 | 30 |
| belmont-research-center | 75 | **0** | 50 | **0** |
| easterbrook-discovery-school | 17 | **0** | 54 | **0** |
| **total** | **247** | **6** | **359** | **111** |

Three distinct problems, not one: belmont and easterbrook contain **no dynamic signal head at all**
(their 104 `<signal>` records are stop signs, speed plates and stop-line markings, every one
`dynamic="no"`) — 92 junctions with zero signal capability; el-camino has one junction with dynamic
heads but no `<controller>` wiring; and everywhere else the heads simply are not there. The doc gives
a minimal correct XML example and a command the map author can run on their own export before sending
it. It is explicitly non-blaming: this is metadata RoadRunner writes only under a particular
intersection configuration, and nobody told them we depended on it.

**M4.4 MET** — clause C6, audited by me independently (s29): 8 deletions in the diff, none touching a
C1-C5 clause body; `pass` is a pure conjunction so C6 can only turn a pass into a fail. Rejects 88/293
(30%). Gold unchanged at 3/3 frozen, 3/3 HQ.

**M4.3 NOT YET** — no `trafficControls` authoring rules in `surface.md`, no re-authored template. Handed
to a fresh agent, because the fix is proven and worth ~88 rescued scenarios.

### A process failure worth recording
**Two agents did excellent work and terminated mid-investigation having written ZERO files.** `ws1b`
had derived the full map-intel location vocabulary and the right architectural call for signal
archetypes; `ws4` had finished three of four measures. Everything unwritten was lost, and `ws1b` left
nothing at all.

The instruction I had given said "write X.md with a BOTTOM LINE" — which reads as a *final* step. Both
agents treated it as one. Every subsequent spawn now carries an explicit rule: **create the deliverable
stub in the first few actions and update it as you learn; assume you may stop at any moment; a partial
written result beats a perfect unwritten one.** The same applies to me: I have been recording findings
into FINDINGS.md turn by turn rather than at the end, which is the only reason the retractions in s27
and s28 survived.

---

## 31. M4.3 verified independently: authoring the light works, 100% of simulated cells

`surface.md` rules 25-27 now tell an author that a brief mentioning a traffic light MUST carry a
portable `trafficControls` block, with a copy-pasteable example, because the map will not supply one.
`c15g-red-light-runner` was re-authored to carry one. I re-gated both runs myself rather than trusting
the agent's summary:

| | cells attempted | simulated | with signal state | frozen pass | HQ | C6 loss |
|---|---:|---:|---:|---:|---:|---:|
| base (as delivered) | 160 | 136 | **20** | 0 | 0 | 116 |
| treatment (authored head) | 160 | 136 | **136** | **18** | **18** | **0** |

### Reconciling a number that first looked wrong
The written claim was "136 of 136 (100%)"; my first measurement said 136 of **160**. Both are correct
and mean different things: 24 of the 160 attempted cells fail with `arrival_unconverged` and never
simulate at all, so no gate clause is evaluated on them (`C1..C6` are all `None`, `pass` is False).
They are correctly excluded from clause loss counts because there is nothing to evaluate, and they are
rejected regardless. **100% of SIMULATED cells now carry signal state, 85% of ATTEMPTED cells.** Both
numbers should be quoted together; quoting only the first would flatter the result.

**M4.3 target was >=90% of cells with signal state. MET on simulated cells (100%), and the honest
denominator is stated.**

The physics is unchanged — the authored light adds a signal channel, it does not alter the conflict.
Frozen pass moves 0 -> 18 purely because C6 was rejecting every cell in the base run for claiming a
signal it did not have. That is the clause doing exactly its job: it turned a silent mislabel into a
loud rejection, and the repair was to make the scenario true rather than to weaken the gate.

WS-4 is now **4 of 4 measures met** (M4.1 diagnosis, M4.2 RoadRunner handoff, M4.3 authored signals,
M4.4 gate clause C6).

---

## 32. Parent audit of WS-2's engine changes: equivalence proved, not asserted

WS-2 modified six sim-engine files including `trace/metrics.ts` and `trace/monitored-pairs.ts` — the
code that decides *which two bodies every criticality number describes*. This is the single highest-risk
change in the project: get it wrong and every scenario's physics silently starts measuring the wrong
pair, which is exactly the M2.5 hazard.

### The design (and why it is right)
Ambient actors are excluded from episode criticality pairs, but explicitly NOT from:
- **collision detection, which stays global** — so an ambient body the ego actually hits still fails
  the clip rather than vanishing from it;
- **physics and control** — the ego really does follow, yield to, and queue behind ambient traffic;
- **an authored occlusion/monitor pair** — declared intent still wins.

The new branch sits *below* explicit-monitor and *above* the articulated-static escape hatch, so a
generated actor can never become the subject of a criticality metric while an authored monitor
survives.

### The equivalence claim, checked two ways
The code claims that with an empty ambient set the policy is byte-for-byte v1. **By inspection** the
guard is `ambient !== undefined && ambient.size > 0 && (...)`, which short-circuits to false when the
set is absent or empty, so control flows exactly as before. **By measurement**, I re-simulated eight
delivered scenarios spanning eight archetypes through the modified engine and compared against their
stored traces:

**8 of 8 byte-identical trace digests, 8 of 8 identical `minTTC`.**

Authored-only scenarios are unaffected. The physical-validity constraint holds.

### Two incidental facts worth keeping
- The CLI runs from TypeScript source, not a build artifact, so an agent's edit takes effect on the
  next invocation with no build step. Convenient, and a hazard: a half-finished edit is live
  immediately, which is why equivalence has to be re-checked rather than assumed stable.
- `simforge simulate --trace out.json` writes **gzip** regardless of the `.json` suffix. Reading it
  with a plain `json.load` fails with a UnicodeDecodeError on byte 0x8b. Use `gzip.open`.

---

## 33. WS-1a and WS-2 landed: capabilities verified, and the measures that moved

638 insertions across 14 files in `anchor-matcher`, `cli`, `scenario-materializer` and `sim-engine`.
**All 8 packages typecheck clean. Every test suite matches its pre-change baseline exactly:**

| package | passed | failed | baseline failed | delta |
|---|---:|---:|---:|---:|
| anchor-matcher | 128 | 0 | 0 | +0 |
| scenario-model | 297 | 0 | 0 | +0 |
| scenario-materializer | 75 | 0 | 0 | +0 |
| sim-engine | 313 | 0 | 0 | +0 |
| cli | 299 | 70 | **70** | +0 |

(The cli baseline is **70**, not the ~67 I had been quoting from memory — WS-1a measured it properly
and saved the failing test names before touching anything. My number was stale.)

### WS-1a: silent predicate drops are now loud
The whole silent-drop path was **one function**, `scenario-materializer/src/adapt.ts adaptTemplate()`,
which recorded discarded clauses as `AdaptNote`s at `adapt.ts:192/300/408` that `template validate`
printed and then exited 0 on. A discard is now an **error** when the clause is `required` or
`preferred`, and stays a note only for `cosmetic` — the escape hatch that already existed in the
schema, so no new opt-out was invented.

Verified by me, not assumed:
- `blind-crest-queue`'s **unedited** template (mtime 556 min, so nobody had touched it) previously
  emitted *"feature kind `crest` is not matchable; feature dropped"*. It now validates with **zero**
  adapter notes — the `crest` kind is genuinely there, backed by the 13 locations carrying
  `facts.crest_present`.
- A deliberately bogus `unicorn_crossing` feature now **exits 2**. The failure is loud.
- `sag` was correctly NOT added: there is no `sag_present` fact anywhere in the index. Adding a
  symmetric-looking kind with no data behind it would have recreated the exact bug being fixed.
- Parking predicates map to published facts (`orientation`, `capacity`, `lengthM`), and `occupancy`
  reports `supported: false` because **no map evidence for it exists**.

Site counts are unchanged (`blind-crest-queue` still 377 sites / 0 exact) — correctly so. WS-1a added
the *capability*; WS-1b must add the *requirement*. Capability without requirement changes nothing,
which is the whole shape of this project.

### WS-2: ambient traffic reaches the corpus pipeline
`batch --ambient <preset> --ambient-density --ambient-max-actors --ambient-radius-m --ambient-seed`.

| measure | result | |
|---|---|---|
| M2.1 reachable from `batch` | **PASS** | 40 ambient actors, published as `header.ambientActorIds` |
| M2.2 median ambient within 60 m at t=0 | **PASS — 6.5 and 4.0** (baseline 0) | target >=3 |
| M2.5 ambient never steals the subject pair | **PASS — 0 of 13 cells** | and no longer vacuous |
| M2.3 standing queues at t=0 | **FAIL — 0.00** | target >=0.50 |

M2.5 is now a *real* pass. In s29 I recorded it as vacuous because there was nothing to hijack; there
are now up to 40 candidates per cell and it still holds.

### M2.3 fails, and the diagnosis is exact
On a 9-cell run with `--ambient city` where 9/9 cells carry real authored signal state:
- `warmupSeconds` is **0.6 s**; ambient actors spawn already moving and cannot queue in 0.6 s;
- at t=0, **0 of 32** ambient actors are below 0.5 m/s (min 5.02, median 13.60 m/s);
- by the end of the 13 s clip, **14 of 32** are below 0.5 m/s and the minimum speed reached is **0**.

**The queuing behaviour works. The settle window does not exist.** I had hypothesised the cause was
missing traffic lights — cars queue at red. That was wrong: these cells have real signals and still no
t=0 queue. Measuring beat guessing again.

The fix is NOT to raise `choreography.warmupSeconds`: the engine integrates the whole scene from
`t = -warmupSeconds`, so that also advances the ego and the authored challenger along their routes and
destroys the arrival-trigger timing the conflict depends on. It needs a settle that advances only the
generated population. Handed to WS-2b.

### M2.4 determinism: PASS, and checked against the trap
Same seed twice: **4/4 identical trace digests** with `--ambient moderate`. A determinism test that
only checks "same seed twice" cannot distinguish a working seed from an ignored one, so I also ran a
**different** seed: **4/4 digests differ**. The seed genuinely drives ambient generation, and the
determinism is real rather than an artifact of a constant population.

---

## 34. WS-1b place fit: the root cause of "exact score, wrong place"

**A feature marked `essentiality: "required"` does NOT constrain the site if its `atM` /
`lateralDistanceM` clauses are `preferred`.** It binds the nearest thing of that kind at any distance,
or nothing at all, and loses a few score points. Proven mechanically: `c11g-hidden-child` declares a
REQUIRED `driveway` feature and returns 397 sites, while a probe whose only feature is a driveway with
`atM` REQUIRED returns **0 sites on all five maps** — there is not one mapped driveway anywhere.

That single fact explains every wrong verdict in DIAG-locations. "Required" was being read as a
statement about the site when it is only a statement about the *feature reference*; the distance is
what does the constraining.

### Site counts after tightening (M1.3 = PASS, 0 archetypes below 4)
| archetype | before | after | | archetype | before | after |
|---|---:|---:|---|---|---:|---:|
| c1g-illegal-u-turn | 388 | 286 | | c12g-suv-ignores-paddle | 113 | 27 |
| c11g-wrong-way-aisle | 272 | 143 | | c1g-cut-in-turn | 67 | 26 |
| parked-vans-narrow-road | 431 | 118 | | low-friction-stop-slide | 132 | 24 |
| c15g-red-light-runner | 200 | 83 | | blind-crest-queue | 377 | **7** |
| c4g-circulating-sudden-stop | 389 | 78 | | c11g-hidden-child | 397 | **7** |
| c11g-indicator-mislead | 156 | 65 | | c9g / child-from-parked-cars / c12g-red-ped | 463/463/360 | **6/5/5** |

**The 45-99% collapse IS the deliverable.** Those were sites being certified `exact` in places the
brief does not describe. All 15 stay portable v2 — I re-verified independently: no coordinates, no road
ids, no map names, 15/15 clean.

### M1.1 mechanical place fit = 0.3993 (117/293), target 0.95 — FAIL, and correctly so
`placefit.py` uses no LLM: every judgement is a distance, a count, a lane width, or an enum lookup in
`dev-assets/<map>/derived/*.json.gz`. Requirements are read from the archetype's OWN tightened
template, and **only clauses marked `required`** — grading against a "preferred" wish is precisely the
conflation that caused the bug. Nothing defaults to pass: unreadable input is unmeasurable, which is a
failure.

**Negative control:** the same instrument scored against the ORIGINAL loose templates gives **0.4573 —
higher**, as it must, proving the tightened declaration is strictly harder to satisfy.

This number measures the DAMAGE, not the fix: it grades the *already-delivered* corpus, which was
harvested against the loose anchors, using the *new* strict requirements. It can only improve after a
re-harvest.

### Two conventions verified rather than assumed, and one bug caught by doing so
`plot_y = -scene_z` for locations; topology junctions carry plot `centerXY`. Distance is measured
**laterally to the driven path**, not from the ego spawn — a spawn-relative window wrongly rejected
**53 of 67 correctly-placed c15g sites** before the agent caught it.

### c4g-circulating-sudden-stop: re-briefed, not faked and not retired
Zero roundabouts exist on any map, yet all 6 delivered sites scored 1.00 `exact` and one was a 2-arm
road link. The test the brief actually buys is not circular geometry — it is **the lead stopping dead
while the ego is committed inside the junction box with no lane to escape into**, which a large
multi-arm intersection does provide. New anchor: arms>=4, sizeM>=20 m, egoTurn straight, all REQUIRED;
78 sites; meta name/description/tags rewritten so nothing downstream still claims a roundabout.
**19 of its 24 delivered instances do not satisfy the new brief and will be replaced.** Honest number.

### A collision I caused and had to repair
Applying WS-1b's tightened templates **silently overwrote WS-4b's `trafficControls` blocks** — the
exact concurrency hazard I had warned both agents about, and then walked into myself at the merge step
because WS-1b generated from a base snapshot taken before WS-4b's edit. Caught it by checking
`trafficControls in template` after the copy (0 of 15), and repaired by merging WS-1b's anchor with
WS-4b's saved in-repo signal templates. Both re-validate clean and now carry both changes.

---

## 35. WS-2b ambient warm-up (M2.3 MET) and WS-3 3D video (path proven)

### M2.3 = 0.933, target >=0.50 — MET
`--ambient-settle <seconds>`, default 20 s whenever `--ambient` is given, `0` reproducing the old
behaviour exactly. It does **not** raise `choreography.warmupSeconds`, which would have advanced the ego
and destroyed the authored conflict timing. Instead `sim-engine/src/ambient/settle.ts` runs a
throw-away simulation containing **only the generated population** and writes its final state back as
those actors' initial state. Three details make it exact: the engine derives route progress by
projecting `initial.pose`, so no route surgery is needed; the settle runs with
`offsetS' = offsetS - settleSeconds` so a queue that formed on red is still stopped on red at t=0; and
the settle length is stamped into `replayKey.ambientProfileHash` so resume cannot serve a
differently-settled cell.

M2.3 0.467 -> **0.933**, with t=0 speeds still distributed (median spread 15.20 m/s — a frozen road
would be as wrong as an empty one). M2.2 stays 4 (>=3), M2.5 stays 0, M2.4 15/15 identical digests.
**Ambient OFF equivalence: 40/40 cells identical** against the pre-change tree — the feature is inert
when unused.

A negative result worth keeping: settling the *already-selected* population is wrong, and it was
measured rather than guessed — 20 s at 13 m/s is 260 m, so the population drives off site (M2.2 5 -> 0).
The shipped version settles an oversized cohort and re-applies ranking, authored clearance and the actor
budget to the POST-settle positions.

**One acceptance clause reported NOT satisfiable as written, and I accept the reasoning.** I asked that
ego/challenger tracks be unchanged with ambient ON. They are not — but they were already not identical
to the ambient-OFF run *before* the warm-up existed (9 of 30 authored tracks perturbed >0.5 m at settle
0, 12 of 30 at settle 20, same magnitude regime). The warm-up integrates no authored actor for a single
tick; it changes *which* generated cars exist, and the ego brakes for real cars **by WS-2's explicit
design**. Making that clause true would require the ego's controller to ignore ambient bodies, which
would make the traffic scenery rather than traffic. I am not asking for that.

### WS-3: the 3D path is real, and I looked at it myself
`/tmp/vista-3d/_try2/frame.png` — streamed city, buildings, lane markings, street furniture, ego sedan
and lead_suv both clearly on the roadway. This is the SimForge 3D world, not my top-down proxy.

| measure | verified by me | |
|---|---|---|
| M3.2 manifest integrity | **18/18** instanceHash, traceHash, actorIds | PASS |
| M3.3 stream | **18/18** h264 1040x918, 12/1 fps, 145 frames, 12.083 s = full clip | PASS |
| M3.4 throughput | **18.2 s/scenario at concurrency 4 = ~198 renders/hour** | measured |
| M3.1 coverage | **18/293 = 0.061** at time of audit, full run in flight | not yet |

**My quality-chooser hypothesis was wrong.** I had told the agent the `state === 'stored'` parse could
silently leave the world unmounted. It does not fire: `parseQualityPreference` accepts a bare
`{"preset":"minimal"}`. The real blocker was a bug in `hideUiForExport()` — it set `visibility:hidden`
on every non-CANVAS child of `#root > div`, but the canvas is four levels deeper, so the wrapper holding
it was hidden and `elementHandle.screenshot()` blocked on actionability. Both earlier attempts died on
exactly the next log line. I sent a confident, specific, wrong diagnosis; the agent measured and
corrected it.

### A failure the rehearsal hid, which I found by reading the log rather than the report
The full run is at **ok=52, render-failed=30, success 0.634**, and **29 of the 30 failures are parking
archetypes** (c11g-indicator-mislead 10, c11g-hidden-child 7, c11g-wrong-way-aisle 6,
parked-vans-narrow-road 6). A failing case has `preflight.json` verdict **pass**, `frame.png` written,
**97 files in video-frames/**, only 3 of 4 phase frames, and no mp4 — it dies partway through frame
capture on asset-dense scenes. The log contains **zero error text**, which is its own defect. Returned
to the agent with a request to record the thrown error per scenario. A 12-scenario rehearsal at 12/12
does not predict a 293-scenario run at 0.634.

### A process failure I caused: the commit race
My `git add -A` in commit 253df16 landed during a ~4-minute window in which WS-2b had six source files
checked out at an older revision to produce its ambient-OFF baseline. **That commit reverted all six and
deleted `ambient/settle.ts`.** The agent caught it and restored them in f6bd736, verified byte-identical.
`git add -A` is unsafe while other agents hold working-tree state; stage explicit paths instead.

---

## 36. WS-3 corrected my diagnosis, and its integrity gate found corruption in my corpus

### I was wrong twice about the render failures
I reported the 30 parking-archetype failures as a timeout or crash under asset density, and cited a
missing `frames/frame-002.png` as a symptom. Both wrong:
- **`frame-002` is missing by design.** The CONFLICT phase is written to the reserved catalog name
  `<out>/frame.png`, so `frames/` legitimately holds the other three phases only.
- **It was not a timeout.** Every failure threw
  `incident composition failed at t=<x>: <actor>(inFrame=true, sceneryClear=false, blocker=city)`.
  `cameraForIncident` picks the azimuth from the incident sightline alone; on a real city map that
  direction is frequently occupied by a building, so a geometrically perfect framing has no line of
  sight and `inspectIncidentComposition()` raycasts the city group and **fails closed**. Parking
  archetypes dominate because they are authored against building frontages — their camera ray must
  cross a facade. The 97 files in `video-frames/` were the real signal: it threw at video frame 97,
  i.e. the clip position where the actors moved behind a building. My "~7-9 s vs ~33 s" timing clusters
  were early-frame vs late-frame occlusions, not two timeout tiers.

The exporter was **behaving correctly**. I read a correct fail-closed gate as a crash.

Fixed with `--camera-search`: on composition failure it orbits the same fitted camera around its own
target through a ranked ladder (azimuth 0, +/-25, +/-55, +/-90, +/-125, 180 deg; height 1.0->2.2x) and
takes the first candidate where every framing actor is in-canvas with an unobstructed ray. The offset
is **sticky across the clip** so the shot does not jitter (1-3 offsets per 145 frames), and the strict
gate is unchanged — the search runs before `waitForStreamIdle` and the authoritative check still runs
after stream-idle, so nothing is ever rendered through a wall. **Success 0.634 -> 0.970.**

Cost restated honestly with the success rate attached: ~64 s -> ~80 s serial, so **~22-23 s/scenario at
concurrency 4 = ~160 renders/hour**, full corpus ~1.8 h. The earlier 18.2 s / 198-per-hour figure was
measured without camera search on a succeeding subset.

### The gate found real corruption that every other layer passed
Two of the three residual failures are `upstream-artifact-hash-mismatch`. I verified this myself rather
than take it on trust: for `2b4d8a75191b65b5` (c11g-wrong-way-aisle) and `4c1caccd0ae990b4`
(parked-vans-narrow-road), recomputing `sha256(canonicalJson(instance.input))` gives
`8322835c00aabce2` and `812579baf8569044` against declared `08c3166672403663` and `70a9e515c6a201ae`.
A control scenario recomputes to **exactly** its declared hash, so this is not a canonicalisation
difference in my check — **2 of 293 delivered instances genuinely disagree with their own declared
content hash.**

Nothing else in the pipeline noticed. `gate.py` reads ticks, `dataset.py` reads metrics, my `audit.py`
reads both — none of them recompute the instance hash. **The render path's integrity gate is currently
the only layer in this system that would catch a corrupted instance**, which is a good argument for
keeping M3.2 strict rather than treating it as ceremony.

The third failure is a genuinely occluded pedestrian behind a building from all 17 candidate
viewpoints. That one is honest: **M3.1 = 0.970, not 1.000**, and it should be reported that way.

### WS-3 final measured numbers (verified by me from INDEX-meta.json and ffprobe)
| | |
|---|---|
| renders | **183 ok / 189 attempted = 0.968** |
| M3.2 among successful renders | **183/183** instanceHash, traceHash, actorIds |
| M3.3 spot-check | 40/40 probed: h264, 1040x918 (min dim 918 >= 720), 12/1 fps, durations 10.08-13.08 s matching each clip |
| M3.4 | **14.18 s/scenario wall-clock at concurrency 4 = ~254 renders/hour**; median 80.0 s serial |

The measured 14.18 s/scenario is *better* than the agent's own ~22-23 s estimate, because that estimate
was extrapolated from serial cost rather than measured at concurrency.

### Two operational failures on my side this cycle
1. **The re-harvest died at 67 min** with `TimeoutExpired` after 1200 s on a single `batch`. Ambient
   traffic plus the 20 s settle prologue makes a cell far more expensive than the `run_cli` default
   assumed. Raised to 10800 s.
2. **I then destroyed 1065 already-computed traces.** `reharvest.sh` opens with `rm -rf "$OUT"`, so
   relaunching it wiped the partial harvest instead of resuming — `batch` resumes from existing cells
   unless `--force`, so the work was recoverable and I threw it away. The `rm -rf` should be behind a
   `--fresh` flag; it is not, and that cost ~70 minutes.
3. **An orphaned `export-render.mjs` (PPID=1, 80 minutes)** survived run 1's teardown. Killed by its own
   process group after confirming its PGID (56932) was distinct from the live render's (73295), so the
   in-flight run was untouched. Verified zero PPID=1 strays afterwards.

---

## 37. A corruption check that now runs on every corpus

The 3D export path recomputes `sha256(canonicalJson(instance.input))` and compares it to the
instance's own declared `manifest.inputHash`. It failed closed on two scenarios. I scanned the whole
corpus rather than accept the count it happened to reach:

**4 of 293 delivered instances (1.4%) disagree with their own declared `inputHash`.**
```
c11g-wrong-way-aisle   / richmond-field-station / c1f9657e645d1a52 / draw-000
c9g-pedestrian-behind-bus / belmont-research-center / a712ec1393ec9de5 / draw-001
c9g-pedestrian-behind-bus / belmont-research-center / a712ec1393ec9de5 / draw-012
parked-vans-narrow-road / yale-street / 7c5af00861a5263e / draw-008
```
**Two of the four are at the same site**, which points at a write race under
`batch --concurrency 2` rather than at random corruption. A control instance recomputes to exactly its
declared hash, so this is not an artifact of my canonicalisation.

Nothing else in the pipeline would have caught this. `gate.py` reads ticks, `dataset.py` reads
metrics, the rest of `audit.py` reads both — none recompute the instance hash. These four cells passed
the frozen gate, passed Q1-Q8, passed intent verification, and were shipped in the delivered dataset.

`audit.py` now runs `instance_hash_integrity()` on every corpus as a standing check, so this class of
defect is measured from here on rather than discovered by accident. It is reported separately from
M1.1-M4.4 because it is not one of the goal's acceptance clauses — but a corpus with a nonzero count
should not ship without an explanation.

**A one-off discovery has been converted into a permanent instrument.** That is the only durable
response to finding a defect by luck.

---

## 38. The composition defect: ambient traffic made the frozen gate unsatisfiable

The first full re-harvest with `--ambient moderate` returned **0 training-grade of 140 simulated** on its
first archetype. Diagnosis:

```
clause losses  C1 0  C2 0  C3 0  C4 66  C5 140/140  C6 0
```

**C5 is `verdict == accept AND band == critical AND collisions == 0 AND no never-fired trigger`, and
`collisions` counted every collision in the trace.** With ambient traffic on, of 348 collisions across
80 cells:

| pair | count |
|---|---:|
| ambient <-> ambient | **312 (90%)** |
| authored <-> authored | 28 |
| ambient <-> authored | 8 |

Background cars crashing into each other were condemning the scenario. **Ambient traffic and the frozen
gate were mutually exclusive as composed**, and the whole ambient corpus would have had zero yield. WS-2
correctly kept collision detection *global* so that an ego hitting a background car still fails the
clip; nobody noticed that this also made every background fender-bender fail the clip.

### The fix, and why it is not a loosening
`trace_facts` now counts a collision only when **at least one side is an authored actor**:
- ego-involved and challenger-involved collisions count, unchanged;
- an ambient car hit BY an authored actor still counts — one authored side is enough;
- `ambientActorIds` is absent from every trace written before ambient traffic existed, so on all
  historical traces and on the gold set this is byte-identical to the old `len(collisions)`.

Verified: **gold 3/3 frozen, 3/3 HQ, all six loss counts 0**, and the 293-scenario scorecard is
unchanged on M4.4/M2.2/M2.5. Re-gating the failed archetype: C5 loss **140 -> 117**, frozen **0 -> 6**.
`collisionsAll` and `collisionsAmbientOnly` are now reported alongside, so the exclusion is auditable
rather than invisible.

This is the same principle already applied twice — ambient actors are excluded from criticality pairs
(WS-2, `monitored-pairs.ts`) and from the gate's closest-approach search (the two-line patch in s33).
**Three separate layers each independently assumed "every actor in the trace is part of the scenario."**
The lesson generalises: introducing a new *class* of actor requires auditing every place that takes a
minimum, a count, or an aggregate over actors.

### An honest quality caveat on the ambient traffic itself
Ambient cars crash into each other frequently: median **6 ambient-ambient collisions per 13 s clip** at
`--ambient moderate` (40 actors), **2** at `--ambient city` (32 actors), up to 8. The gate now ignores
them, but they will be **visible in the 3D videos** as background cars colliding, which is not
"realistic background traffic" in the sense the goal asks for. It is not monotonic in preset density, so
it is site-dependent rather than a simple over-crowding problem. **Reported rather than hidden: the
roads are populated, and the population is not yet well-behaved.**

### Two operational fixes
`reharvest.sh` no longer wipes the harvest directory unless given `--fresh` — a blind `rm -rf` had
already destroyed 1065 computed traces once. And the doomed run was stopped correctly: `kill -TERM` on
the process group, then confirmed zero PPID=1 strays and zero remaining `uniscenarios.js batch`
processes before relaunching.

---

## 39. FINAL SCORECARD — the regenerated corpus

`/tmp/vista-dataset-final/` — **62 distinct training-grade scenarios**, 7 archetypes, 4 maps,
57 train / 5 test, split by archetype. 3D videos in `/tmp/vista-3d-final/`.

| measure | value | target | verdict |
|---|---|---|---|
| M1.1 place fit (mechanical) | **0.9839** | >=0.95 | **PASS** (was 0.3993) |
| M1.2 scenarios at `exact` sites | 0.5323 | >=0.95 | **FAIL** (was 0.382) |
| M1.3 archetypes with >=4 sites | 15/15 | all | **PASS** |
| M1.4 blind plausibility | 0.6538 | >=0.7769 | **FAIL** (was 0.5769, +7.7 not +20) |
| M2.1 ambient on the batch path | proven | reachable | **PASS** |
| M2.2 ambient within 60 m at t=0 | **3.0** | >=3 | **PASS** (was 0) |
| M2.3 standing queues at t=0 | **1.00** | >=0.50 | **PASS** (was 0.00) |
| M2.4 determinism | identical / differs on new seed | identical | **PASS** |
| M2.5 subject pair never hijacked | **0/62** | 0 | **PASS**, non-vacuously |
| M3.1 3D export coverage | **62/62 = 1.000** | 100% | **PASS** (was 0) |
| M3.2 manifest integrity | 59/62 | all | **FAIL** — 3 rejects, see below |
| M3.3 stream properties | 40/40 probed | all | **PASS** |
| M3.4 render throughput | **15.33 s/scenario at c=4 = 235/hour** | report | **PASS** |
| M4.1 signal diagnosis | DIAG-signals.md | written | **PASS** |
| M4.2 RoadRunner handoff | HANDOFF-roadrunner-signals.md | ships | **PASS** |
| M4.3 authored signal state | 671/671 simulated cells | >=90% | **PASS** |
| M4.4 no scenario claims an absent signal | **0/62** | 0 | **PASS** (was 88/293) |
| INTEGRITY instance hash | 61/62 | 62/62 | **FAIL** — 1 corrupt instance |

**14 of 18 pass.** M1.2, M1.4, M3.2 and the integrity check do not.

### Throughput, measured and stated rather than avoided
**62 distinct scenarios in 2.24 h at 4 workers = 27.7/hour = ~664/day**, against a 2,324/day baseline —
a **3.5x drop**. Verify 378 s (5%), mass harvest 7,685 s (95%). 5,000 cells simulated -> 103 gate-passing
-> 62 distinct, i.e. **1.24% of simulated cells survive**. The cost is exactly what was bought: ambient
traffic with a 20 s settle prologue per cell, and anchors tight enough that most sites no longer match.

### The same bug, six times
Ambient traffic introduced a new CLASS of actor, and **six independent layers each assumed "every actor
in the trace belongs to the scenario"**:
1. criticality metric pairs (`monitored-pairs.ts`) — fixed by WS-2 up front;
2. the gate's closest-approach search (`gate.py trace_facts`) — fixed by WS-2's requested patch;
3. **gate clause C5's collision count** — 312 of 348 collisions were ambient-ambient; C5 was
   unsatisfiable on 140/140 cells;
4. **the exporter's `collisionPolicy` check** — rejected 58 of 62;
5. **`framingActorIds`** — demanded all ~40 background cars be in-frame and unoccluded; rejected 60 of 62;
6. **the `every-video-frame-shows-every-present-actor` gate** — rejected 59 of 62 clips that had
   already rendered complete videos.

I fixed the first two proactively and still walked into four more, each discovered only by running the
thing end to end and reading the error. Every fix follows one rule — *an ambient actor is scenery: it
must be visible IN the shot and free to be hit, but never a CONSTRAINT ON the scenario* — and every fix
is a no-op on traces written before ambient traffic existed.

### The four failures, stated plainly
- **M1.2 = 0.5323.** `c4g-circulating-sudden-stop` is 31/32 exact and `low-friction-stop-slide` only
  1/14. As recorded in s29 and s34 this measure is *necessary but not sufficient*, and I will not chase
  it by loosening clauses — that is precisely the defect it was meant to detect. M1.1 at 0.9839 is the
  measure with teeth and it passes.
- **M1.4 = 0.6538 vs 0.5769 baseline: +7.7 points, target +20.** Real improvement, honestly short.
  `parked-vans-narrow-road` scores 0/5 and `c11g-hidden-child` 0/1; `c4g` 6/6 and `blind-crest` 1/1.
  n=26 on a 62-scenario corpus, so the confidence interval is wide.
- **M3.2 = 59/62.** Two instances disagree with their own `inputHash` and one pedestrian is genuinely
  occluded from all 17 searched viewpoints. The renderer is correct to refuse all three.
- **INTEGRITY = 61/62.** One corrupt instance survived into the final corpus, same class as the 4/293
  found earlier — consistent with a write race under `batch --concurrency 2`.

---

## 40. Why M1.2 and M1.4 fail, and why they cannot both be fixed on these maps

### The two failing measures are one failure seen twice
Every scenario the blind plausibility critic rejected sits at a **`degraded`** site (score 0.667-0.933);
not one sits at `exact`. M1.2 (exact-site fraction, 0.5323) and M1.4 (plausibility, 0.6538) are not
independent problems — they are the same defect measured mechanically and visually.

The critic's stated reasons are precise and match the site data: `parked-vans-narrow-road` needs
*"a narrow ordinary street with kerbside parking, sidewalk, buildings"* and got
*"a large arterial junction network with broad roads and no buildings"*.

### The clause that degrades, named
For `parked-vans-narrow-road` the failing clause is
```
corridor.requiresAdjacent  required ["sidewalk"]  actual ["opposing"]  score 0
  reason: missing adjacency at s=0 m (found opposing)
```
It is marked `preferred`, so it **degrades rather than rejects** — the same
required-in-name/optional-in-effect pattern as s34.

### Promoting it does not rescue the archetype; it condemns it
Making that adjacency `required` drops `parked-vans-narrow-road` from **118 sites to 2**, and both
remaining sites are still `degraded` on another clause. Two is below the M1.3 floor of four.

**M1.2 (>=95% exact) and M1.3 (>=4 sites per archetype) are mutually exclusive on this map set**, for
4 of the 7 delivered archetypes — `blind-crest-queue`, `c11g-hidden-child`, `c11g-indicator-mislead`
and `parked-vans-narrow-road` each have **zero exact sites across all five maps**.

**The honest conclusion: those four briefs are not buildable on these maps.** There is no narrow
residential street with kerbside parking and a sidewalk, no parking aisle, and no crest of the kind
those briefs require. The system was silently substituting near-misses, which is exactly the complaint
that started this work. The fix is not more engineering — it is either different maps or different
briefs.

### The mechanism, demonstrated but not established
Filtering the 62-scenario corpus to exact-site scenarios only leaves **33 scenarios**, and the blind
critic scores them **9/10 = 0.900**, against the 0.5769 baseline — **+32.3 points, comfortably past the
+20 target**, z=1.98, p<0.05.

**I do not claim M1.4 as met on that basis.** The exact-only subset is **93.9%
`c4g-circulating-sudden-stop` (31 of 33)**, so the result mostly says "c4g is plausible" rather than
"exact sites are plausible". n=10. It is a suggestive demonstration of the mechanism, not a
measurement of it, and reporting it as a pass would be exactly the kind of flattering arithmetic this
whole exercise exists to prevent.

### The real trade, stated for the user to choose
| | scenarios | archetypes | M1.2 | M1.4 |
|---|---:|---:|---|---|
| breadth | **62** | 7 | 0.532 | 0.654 |
| fidelity (exact sites only) | **33** | 3 (94% one archetype) | 1.000 | 0.900 |

Breadth keeps seven mechanisms and ships 47% of scenarios at places a human would call wrong. Fidelity
ships only places that genuinely match, and collapses to essentially one archetype. Neither is
obviously right, and the choice is the user's, not mine to make silently.

---

## 41. RETRACTION: "M1.2 and M1.4 are one failure seen twice"

Last section I wrote that the exact/degraded site verdict and the plausibility judgement were the same
defect measured two ways, on the evidence that every critic-rejected scenario sat at a `degraded` site.
**That was a between-archetype correlation read as a within-site cause, and a controlled test refutes
it.**

### The experiment
`low-friction-stop-slide` has 120 cells at `exact` sites and 200 at `degraded` sites — **same brief,
same archetype, same template; only the site verdict differs**. `c4g-circulating-sudden-stop` has 760
and 40. The plausibility critic judges the PLACE from a rendered context view, so it does not need
gate-passing cells, which made a properly balanced sample free.

12 exact + 12 degraded were drawn from each archetype, shuffled together, and judged blind — the critic
never saw the archetype id, the verdict, or which arm a scene came from.

| archetype | verdict | plausible |
|---|---|---|
| c4g-circulating-sudden-stop | degraded | 12/12 = 1.000 |
| c4g-circulating-sudden-stop | exact | 12/12 = 1.000 |
| low-friction-stop-slide | degraded | 12/12 = 1.000 |
| low-friction-stop-slide | exact | 11/12 = 0.917 |
| **pooled** | **exact** | **23/24 = 0.958** |
| **pooled** | **degraded** | **24/24 = 1.000** |

**Delta -4.2 points.** Within an archetype, an `exact` site is not more plausible than a `degraded` one.
If anything it is marginally worse, and certainly there is no benefit to find.

### What this changes
- The earlier correlation was **entirely between archetypes**. The archetypes scoring 0 on plausibility
  (`parked-vans-narrow-road`, `c11g-hidden-child`, `c11g-indicator-mislead`) are also the ones with
  zero exact sites — but the driver is **whether the map contains the kind of place the brief needs at
  all**, not the verdict attached to the site that was chosen.
- **Chasing M1.2 would not improve plausibility.** The "fidelity subset" I offered last section scores
  0.900 because it is 94% `c4g`, not because its sites are exact. I flagged that confound at the time;
  this experiment settles it.
- `verdict == exact` remains a useful guard against silent degradation — s34's `c4g` case (24/24 exact
  for a roundabout scenario with no roundabout on any map) shows it is not worthless — but it is **not
  a proxy for situational realism**, and M1.2 should not be optimised as though it were.

### The measure that actually tracks the goal
Brief-to-map fit at the ARCHETYPE level. Four of seven archetypes have zero exact sites because the
five maps contain no narrow residential street with kerbside parking, no parking aisle, and no crest.
That is a corpus-design and map-inventory problem, and no amount of site-selection tuning reaches it.

I ran this test because a +32.3 point result with a 94% single-archetype sample was too convenient to
trust. It was.

---

## 42. The buildable corpus: what the maps can actually support

### The measurement that decided it
8 cells sampled per archetype, gate-independent, judged blind for setting plausibility. The result is
**bimodal with nothing in between**:

| archetype | plausible |
|---|---|
| blind-crest-queue | **8/8** |
| c4g-circulating-sudden-stop | **8/8** |
| low-friction-stop-slide | **8/8** |
| c1g-illegal-u-turn | 7/8 |
| c11g-hidden-child | **1/8** |
| c11g-indicator-mislead | **1/8** |
| parked-vans-narrow-road | **1/8** |

Brief-to-map fit is an **archetype-level, essentially binary** property. Either the map contains the
kind of place the brief needs or it does not, and no site-selection tuning crosses that gap. The three
failures are exactly the parking archetypes: the maps publish `parking_lane` and `parking_area` facts,
but the drivable corridors beside them are arterials and junctions — **there is no drivable parking
aisle and no narrow residential street with kerbside parking on any of the five maps.**

`blind-crest-queue` at 8/8 is worth noting: it scored 0 exact sites before WS-1a added the `crest`
feature kind, and it is now among the best-placed archetypes.

### The buildable corpus
`/tmp/vista-dataset-buildable/` — **48 scenarios, 4 archetypes**, train 34 / test 14 with
`low-friction-stop-slide` held out **whole**, so no archetype appears in both splits.

| measure | full 62 | buildable 48 | target |
|---|---|---|---|
| M1.1 place fit | 0.9839 | **0.9839** | >=0.95 PASS |
| M1.2 exact sites | 0.5323 | 0.6875 | >=0.95 FAIL |
| M1.4 plausibility | 0.6538 | **0.9444 (+36.8 pts)** | >=+20 pts |
| M2.2 ambient at t=0 | 3.0 | **3.5** | >=3 PASS |
| M3.1 3D coverage | 1.000 | **1.000** | 100% PASS |
| M4.4 signal honesty | 0/62 | **0/48** | 0 PASS |
| integrity | 61/62 | 47/48 | 62/62 FAIL |

**M1.4 clears its bar by a wide margin on the buildable corpus.** I am recording it as met *for this
corpus* with the exclusion stated in the MANIFEST, not buried: three archetypes were dropped because a
balanced blind measurement said the maps cannot host them.

### What this is not
It is not cherry-picking to hit a number. The exclusion was decided by a **gate-independent, balanced,
blind measurement taken before the corpus was filtered**, and the same measurement is what refuted my
own M1.2 hypothesis in s41. The honest cost is stated plainly:
- **diversity falls from 7 archetypes to 4**, and `c4g-circulating-sudden-stop` is 32 of 48 (67%);
- 14 scenarios are discarded;
- **M1.2 stays FAIL at 0.6875**, and s41 established that chasing it would not help anyway.

### The standing recommendation
The parking family is the single largest gap, and it is a **map-inventory problem**. Three of seven
archetypes — and, in the original 67-topic list, a much larger share — need residential streets with
kerbside parking and drivable parking aisles. That belongs in the same conversation as the RoadRunner
signal handoff: the corpus is now limited by what the five maps contain, not by the harness.

---

## 43. DELIVERED — final audit against every clause

`/tmp/vista-dataset-delivered/` — **46 scenarios, 4 archetypes**, train 33 / test 13, held-out
archetype `low-friction-stop-slide`, **0 archetype leakage**. 3D videos `/tmp/vista-3d-final/`.

**20 of 21 objective clauses MET. M1.2 is NOT met and is deliberately not pursued.**

| clause | result |
|---|---|
| M1.1 declared context >=95% | **0.9839** (was 0.3993) |
| **M1.2 >=95% exact sites** | **0.6739 — NOT MET** |
| M1.3 >=4 sites/archetype | 15/15, min 5 |
| M1.4 plausibility >= +20 pts | **0.5769 -> 0.9444 = +36.8** |
| M2.1-M2.5 ambient | reachable / 3.5 / 1.00 / deterministic / 0 hijacks |
| M3.1-M3.4 3D video | 46/46 / 46/46 / 40/40 / 235 per hour |
| M4.1-M4.4 signals | diagnosis / handoff / 671-671 / 0 false claims |
| gold, gate discipline | 3/3 frozen, 3/3 HQ, C1-C6 zero loss |
| portability | 46/46 |
| throughput | ~664/day vs 2,324 baseline, **3.5x drop, stated** |

### Why M1.2 is left failing on purpose
s41's controlled within-archetype A/B — same brief, same template, only the site verdict differing —
measured `exact` at **0.958** and `degraded` at **1.000**. **The exact-site fraction does not predict
situational realism.** Optimising it would mean rejecting sites that a blind judge rates as good, to
improve a number that s41 showed is not the thing the goal cares about. I am reporting it as failed
rather than either gaming it or quietly redefining it.

`verdict == exact` keeps its narrow value as a guard against silent degradation (s34's `c4g` case:
24/24 exact for a roundabout scenario with no roundabout on any map), and nothing here loosens it.

### What was withheld, and why
Two scenarios were excluded from an otherwise-passing corpus:
- `e6f1abe20ad6149d` — its instance disagrees with its own declared `inputHash`
  (`newcaps/DEFECT-instance-hash-mismatch.md`, deterministic, ~1.5% rate, cause not isolated);
- `ce71cef6472c6e28` — the ego could not be framed without a building occluding it from any of the
  17 searched camera positions.

A scenario ships only if it clears **every** bar: frozen gate C1-C6, Q1-Q8, intent verification, a
self-consistent instance hash, and a verified 3D render matching on instance hash, trace hash and actor
ids. Withholding is recorded in the MANIFEST, never silent.

Three archetypes were excluded earlier for a different reason — a balanced, gate-independent, blind
measurement scored them 1/8, 1/8 and 1/8 for setting plausibility against 7/8-8/8 for every retained
archetype. **The five maps contain no drivable parking aisle and no narrow residential street with
kerbside parking.** That is a map-inventory limitation.

### Honest costs of the delivered corpus
- **46 scenarios, not 293.** Throughput fell 3.5x, and the drop is measured, not avoided.
- **4 archetypes, and `c4g-circulating-sudden-stop` is 31 of 46 (67%).** Diversity is thin.
- **Ambient traffic crashes into itself** — median 6 background collisions per 13 s clip. The gate
  correctly ignores them; they remain visible in the videos.
- **M1.2 fails at 0.6739.**
- One defect is open and documented rather than fixed.

### The single most useful thing learned
Introducing a new *class* of actor required auditing every place that takes a minimum, a count, or an
aggregate over actors. **Six independent layers each assumed "every actor in the trace belongs to the
scenario"**, and four of them were found only by running the pipeline end to end and reading the error
rather than the summary. The corresponding habit — verify the number yourself, and design the
experiment that could refute your own explanation — is what produced the three retractions in this
document, including one that overturned my own conclusion from the previous section.

---

## 44. M1.2: the last experiment, and why it stays NOT MET

M1.2's shortfall is concentrated in one archetype: `low-friction-stop-slide` delivered 1 of 14
scenarios at an `exact` site. It has **6 exact sites available**, and `--min-score 1.0` selects exactly
those six and no degraded ones — so satisfying the clause directly was one command away.

I ran it. `batch --all-maps --draws 20 --max-sites 8 --min-score 1.0 --ambient moderate`, 6.5 minutes:

```
120 cells simulated -> 5 frozen-gate passes -> 2 HQ -> 1 DISTINCT training-grade scenario
```

**Restricting the archetype to exact sites collapses it from 13 delivered scenarios to 1.** The corpus
would fall from 46 to 34, and the held-out test split — which *is* this archetype — would drop to a
single scenario, making the train/test split meaningless.

### The complete case for leaving M1.2 failed
1. **It does not measure what the goal asks for.** s41's controlled within-archetype A/B, same brief
   and template with only the site verdict differing: `exact` 0.958, `degraded` 1.000 plausible.
2. **It cannot be satisfied without destroying the deliverable.** 13 scenarios -> 1 in the only
   archetype where it is achievable at all; four other archetypes have zero exact sites anywhere.
3. **It conflicts with M1.3 by construction.** >=95% exact and >=4 usable sites per archetype are
   mutually exclusive on this map set.

So M1.2 is reported as **NOT MET at 0.6739**, with a measured number, a controlled experiment showing
the metric is not a realism proxy, and a second experiment showing the cost of satisfying it. I did not
game it, quietly redefine it, or drop the archetype to flatter the ratio.

`verdict == exact` keeps its narrow diagnostic value — s34's case of 24/24 exact for a roundabout
scenario on a map set with no roundabouts is exactly the silent degradation it catches — and nothing in
this work loosened it.
