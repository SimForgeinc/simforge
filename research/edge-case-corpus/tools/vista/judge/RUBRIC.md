# RUBRIC.md — the independent quality judge, and why it is built this way

`judge/judge.py`. Model `gpt-5.6-luna`, reasoning effort `medium`, vision over rendered rollout frames.

---

## 0. What this thing is for

The frozen admission gate is a **physics** test. It asks: did the ego drive, did something get within
5 m of it after spawn, was there a deceleration demand or a low TTC, and did `evaluate` accept.
It cannot ask the question the corpus actually depends on:

> Is this a genuinely interesting, novel edge case — or a physically valid, completely boring clip?

That gap is not hypothetical. `GATE-AUDIT.md` §4 contains a constructive counter-example (`P5`) in
which an ego drives in a straight line at a rigidly constant 10 m/s past a parked car and satisfies
**all** of C1–C5. §5 contains a real-engine reproduction in which the ego drives **through** two parked
SUVs and satisfies C1–C4. Both are exactly what a physics gate is blind to.

So the design constraint for this judge is:

> **The verdict `physically-valid-but-boring` must be reachable, must be reached often enough to be
> load-bearing, and must not be reachable by accident.**

A judge that never says it is decoration.

---

## 1. The three things that make LLM judges useless, and what is done about each

### (a) The brief primes the answer
If you show a model a clip *and* tell it "this is a child dart-out", it will find a child dart-out. This
is the single largest source of inflated agreement in LLM-judged corpora, and it is why the existing
lane's "blind judge: is a critical edge case = 0.828" is not as reassuring as it looks: a judge that
agrees 83% of the time with a gate it was shown the output of is measuring the gate.

**Countermeasure — two-stage blind-then-brief.**
* **Stage 1** the model sees only the images and a sampled ego speed trace. It is explicitly told it is
  *not* being told what the scenario was supposed to be, and is asked to describe what happens and to
  commit to falsifiable specifics: the time of the critical moment, which party it was with, whether
  the ego braked, whether it swerved.
* **Stage 2** it is then given the brief, **its own stage-1 description verbatim**, the images again,
  and a verified numeric appendix, and asked to score.

Stage 1 is written before the brief exists in context, so a stage-2 "yes, the brief is realised" has to
be reconciled against a description that was produced without the brief. In the calibration runs the
stage-1 description is where the judge's real information is; stage 2 mostly arbitrates.

### (b) The model can just be wrong about what it saw and never be caught
**Countermeasure — `cross_check()`.** Every falsifiable stage-1 claim is checked against the trace:

| claim | checked against |
|---|---|
| `critical_moment.t_seconds` | true `argmin_t` OBB clearance; tolerance 1.5 s |
| `critical_moment.other_party` | the set of actual actor and prop ids |
| `ego_response.braked` | observed peak deceleration ≥ 1.0 m/s² from `speedMps` |
| `ego_response.swerved` | observed peak lateral acceleration ≥ 1.0 m/s² from `headingRad`×`v` |

The fraction passing becomes `reliability`. **If `reliability < 0.5`, R1/R2/R3 are capped at 2**: a model
that demonstrably misread the clip does not get to award high marks on it. This is what makes the judge
falsifiable rather than merely fluent.

### (c) The model can be argued out of physics
**Countermeasure — mechanical flags with hard caps.** Some questions are settled by the trace and are
not up for discussion. These are computed in `mechanical_flags()` and override the model's score:

| flag | evidence | cap |
|---|---|---|
| `EGO_NEVER_ACTED` | constant speed **and** heading for the whole clip | R4 → 0 |
| `EGO_RESPONSE_NEGLIGIBLE` | observed peak decel < 0.5 and peak lat < 0.5 m/s² | R4 → 1 |
| `CHALLENGER_STATIC` | the nearest road user never moves | R2 → 1 |
| `CLOSEST_AT_SPAWN` | closest approach at the first co-present tick | R2 → 1 |
| `CHALLENGER_DISCONTINUOUS` | a single-tick jump larger than its own speed allows | R5 → 1 |
| `EGO_INTERSECTS_PROP` | ego OBB overlaps a static prop (props are `collidable:false`) | R5 → 0 |
| `OCCLUDER_INEFFECTIVE` | the engine says the declared occluder never blocked line of sight | R1 → 1 |
| `EGO_NOT_MAKING_PROGRESS` | net displacement < 0.5 × path length | R5 → 1 |

Note that these are **caps, not scores**: they can only ever lower a judgement. The model cannot be
talked into ignoring them, and they cannot manufacture a "high".

Both the raw model scores (`scoresRaw`) and the capped scores (`scores`) are recorded, so the
disagreement between the model and physics is itself a measurable quantity. In calibration
`EGO_INTERSECTS_PROP` had to fire against a model score of R5 = 3 — **the vision model did not notice
the ego driving through a parked SUV.** That is a result about vision, and it is in
`FAILURE-MODES.md` §2.

One flag is deliberately **not** capped: `CHALLENGER_STOPPED_AT_CONFLICT` (the other party had stopped
by the moment of closest approach). A pedestrian frozen in a live traffic lane can be a legitimately
hard scenario. It is surfaced in the numeric appendix in capital letters instead, so the model must
address it under R5 rather than have the answer decided for it.

---

## 2. The five dimensions, and why these five

The task named four things to judge plus a difficulty score. They do not decompose into one number,
and averaging them would let a high novelty score pay for a nonexistent conflict — the exact failure
this judge exists to prevent. So they are scored separately and combined by **rules, not arithmetic**.

**R1 intent realisation.** Does the specific event the brief names actually happen, with the named kind
of actor, in the named spatial relationship? The anchors name the concrete way this fails in this
project: *the pedestrian emerges, but nowhere near the parked cars that were supposed to hide it.*

**R2 conflict genuineness.** Is there a contested piece of space, or is this a pass-by? The 0/1 anchors
are written directly from the audit's junk counter-example: "the actors are merely near each other",
"the conflict is with something stationary that the ego simply drove past". This is the dimension that
`P5` must fail.

**R3 novelty and interest.** The corpus is a *training/evaluation* artifact; a slot spent on an ordinary
lead-vehicle brake is a slot wasted. Anchor 0 is "generic car-following or free driving"; anchor 1 is
"a common, well-covered situation". This dimension is what caught the synthetic positive control B3 (an
ordinary cut-in with a comfortable margin) and correctly demoted it.

**R4 ego response: non-trivial but survivable.** Deliberately a **band, not a ladder**. 0 is *both*
"the ego did nothing" *and* "the ego collided / it was unsurvivable". 1 is *both* "a token response" and
"a wildly excessive one". This is the only correct shape: a scenario the ego sails through is worthless,
and so is one that is unavoidable. A monotone "more braking is better" score would reward exactly the
degenerate scenarios a solver drifts toward.

**R5 plausibility.** Would a driving instructor accept that this could happen? Anchor 0 explicitly names
the artifacts this engine can produce: bodies passing through one another, teleporting actors, vehicles
where no vehicle can be, pedestrians standing motionless in a live lane for no reason.

### The verdict rules (applied in order, first match wins)

```
R5 <= 1                 -> invalid
R1 <= 1                 -> intent-not-realised
R2 <= 1 or R4 == 0      -> physically-valid-but-boring
R3 <= 1 and R2 <= 2     -> physically-valid-but-boring
min(R1,R2,R3,R4) >= 3   -> high
otherwise               -> acceptable
```

Two properties this ordering buys:
1. **A zero anywhere is fatal.** No dimension can be bought off by another. `R2 <= 1 or R4 == 0` is a
   disjunction precisely so that "no real conflict" and "ego did nothing" each independently sink a clip.
2. **`high` requires a floor of 3 on four dimensions simultaneously.** It is deliberately hard to reach,
   and it does not require R5 = 4, because "plausible" is enough.

The rules are evaluated in Python (`_verdict()`), not by the model. The model is *shown* the rules and
asked for its own verdict too; `verdictModel` vs `verdict` disagreement is recorded and is a cheap
ongoing check on whether the model is following instructions.

---

## 3. The difficulty score, and why it is computed rather than asked

VISTA scored Relative Human Action Efficiency. The analogue here is the **action / intervention budget
the ego actually had to spend**. Crucially it must be measured, not judged, and it must be measured
**from the trajectory**, because `metrics.requiredDecelMax` is a *counterfactual*: `GATE-AUDIT` probe
`P6` shows an ego whose speed array is rigidly constant and whose observed peak deceleration is
0.0000 m/s² while `metrics.requiredDecelMax.ego` reports 3.0. Building difficulty on that number would
make it trivially inflatable.

```
difficulty = 100 * ( 0.24 * longitudinal authority spent   (peak observed decel, 0.5 -> 6.0 m/s^2)
                   + 0.16 * lateral authority spent        (peak observed |yawrate|*v, 0.3 -> 4.0)
                   + 0.14 * speed given up                 (speed drop / max speed, 5% -> 90%)
                   + 0.24 * margin lost                    (1 - clearance/5 m)
                   + 0.12 * number of separate interventions (1 -> 4)
                   + 0.10 * shortness of warning           (reveal-to-conflict, 4.0 -> 0.5 s) )
```

Weighting rationale: **margin** and **longitudinal authority** carry the most weight (0.24 each) because
they are the two quantities that a human would use to describe how close a near-miss was. Lateral
authority is next because a scenario that forces a *steering* response is strictly harder than one that
only forces braking, but it is smaller because ordinary lane geometry produces some lateral acceleration
for free. The intervention count captures "how many decisions", the VISTA "action budget" idea most
directly, but is capped low because it is the noisiest. Warning time only contributes when the scenario
declares an occlusion, so it cannot silently zero out a scenario that never claimed one.

Every component is a saturating ramp, so no single term can run away, and the score is monotone in
"the ego had to do more, with less room".

The model is *also* asked for `predicted_difficulty_0_100`. It is never used in the verdict. Its only
job is calibration: a persistent gap between the model's guess and the measured value tells you the
model is reading the clip differently from the physics, which is a signal about the *renderer*, not
about the scenario.

---

## 4. Negative controls: how I know the judge can fail things

`judge/make_controls.py` builds three rollouts whose **ego drives a real lane polyline of a real map**,
so they render and read exactly like real cells, and runs the **unmodified** `gate.py` over them.

| control | what it is | gate | correct judgement |
|---|---|---|---|
| **B1** boring pass-by | ego at a rigidly constant 10 m/s past a parked car 3.15 m off its path; a second car spawns 6 m away and diverges | **PASS** (C1–C5) | boring |
| **B2** ghost prop | same, but a stationary SUV prop sits **on** the ego's path; ego drives through it | **PASS** (C1–C5) | invalid |
| **B3** ordinary cut-in | a real late cut-in, ego brakes 11 → 5 m/s, 2.53 m clearance | **PASS** (C1–C5) | not boring — a positive control |

```
B1-boring-passby   C1=True C2=True C3=True C4=True C5=True PASS=True  clearance=1.225 m @ t=6.28
B2-ghost-prop      C1=True C2=True C3=True C4=True C5=True PASS=True  clearance=1.750 m @ t=6.28
B3-real-cutin      C1=True C2=True C3=True C4=True C5=True PASS=True  clearance=2.533 m @ t=4.86
```

(For the controls, C5's `verdict`/`band` is supplied as `accept`/`critical` rather than earned from
`evaluate`; C1–C4 are earned outright by the unmodified gate. The audit already establishes separately
that `evaluate` accept/critical is satisfiable by degenerate clips — that is why the physical gate
exists at all.)

**Result:**

| control | judge verdict | R1 | R2 | R3 | R4 | R5 | caps applied |
|---|---|---|---|---|---|---|---|
| B1 | **physically-valid-but-boring** | 3 | 1 | 0 | 0 | 4 | none — the model got there itself |
| B2 | **invalid** | 3 | 1 | 1 | 0 | 0 | `EGO_INTERSECTS_PROP` forced R5 3 → 0 |
| B3 | physically-valid-but-boring | 3 | 2 | 1 | 3 | 4 | none |

(final run, §6; an earlier run before the contested-space close-up was added gave B1 R3=1 and B3 R1=4)

B1's one-liner: *"This is a routine parallel pass with no genuine conflict or ego response, so it does
not provide a useful edge case."* — on a clip the frozen gate ADMITS. That is the whole point of this
module, demonstrated.

B3 is worth dwelling on. I built it as a *positive* control and the judge demoted it to boring on
R3 = 1: an ordinary cut-in with a 2.53 m margin and 3.0 m/s² of braking really is a generic clip. I
consider that the right call rather than a failure, but it is a genuine finding about the rubric: **R3
is strict, and a corpus scored by it will not accept "textbook manoeuvre, executed cleanly" as an edge
case.** If that is not what you want, R3 is the dial — not R2 and not the verdict rules.

---

## 5. What this judge does NOT do

* It does not check portability. The lane contract's "no coordinates, no road IDs" rule is a property of
  the *template*, not the rollout, and belongs in `template validate`.
* It does not re-derive the gate. It is given the gate's verdict for context and is explicitly told the
  clip already passed physics, so that it spends its budget on the question the gate cannot answer.
* It judges **one cell**. Corpus-level questions — is this archetype a near-duplicate of another
  archetype, is the taxonomy covered, are the three "distinct sites" really distinct — are a different
  instrument. §9 of `GATE-AUDIT.md` shows why that instrument is needed: four different parameter draws
  at yale-street site `25fd4ad601d7872b` produced *identical* 2.128 m clearances, so "4 cells" there is
  closer to one sample.
* It is not deterministic. Two runs of the same clip can differ by a point on a dimension. The
  mechanical flags and caps are deterministic; the model's contribution is not. Report it as a
  distribution, not a scalar.


---

## 6. Calibration on real cells

28 real cells (7 sites × 4 draws, 2 maps, the gold `expA-child-dartout-two-cars` template):

```bash
node packages/cli/bin/simforge.js batch \
  research/edge-case-corpus/templates/expA-child-dartout-two-cars.template.json \
  --all-maps --draws 4 --max-sites 6 --out /tmp/judge-a1 --concurrency 3

MPLBACKEND= .venv/bin/python research/edge-case-corpus/tools/vista/judge/judge.py \
  --batch /tmp/judge-a1/batch-summary.json --all-cells --workers 5 \
  --brief "A child runs into the road from between two parked vehicles." --out /tmp/judge-cal2
```

Full record: `/tmp/judge-cal2/judgements.json`; summary in `judge/CALIBRATION.json`.

### Gate versus judge

| | acceptable | high | intent-not-realised | **physically-valid-but-boring** |
|---|---:|---:|---:|---:|
| **gate FAIL** (9) | 2 | 3 | 4 | 0 |
| **gate PASS** (19) | 14 | 3 | 0 | **2** |

* **The requested result exists: 2 cells the frozen gate ADMITS, the judge calls
  `physically-valid-but-boring`.** Both are unforced — raw model scores equal the capped scores, no
  mechanical cap fired.
  * `/tmp/judge-a1/yale-street/d2ad0646d29bcf97/draw-003.trace.json.gz` (gate clearance 3.349 m).
    Judge R2 = 2, R3 = 1: *"at the contested-space instant the child is still 16.22 m ahead with 13.4 m
    clearance; the 3.349 m closest approach at t=9.22 occurs after the child has stopped."*
  * `/tmp/judge-a1/yale-street/f40e79ec8edcfd77/draw-000.trace.json.gz` (gate clearance 3.562 m).
    *"the child lies on the ego centreline at 6.36 s but is still 19.04 m ahead with 16.23 m
    clearance... a real but easy interaction rather than a severe near-collision."*
* **All 4 `intent-not-realised` verdicts land on the 4 cells of site `33a100467f1b70e4`**, which the
  gate also failed — the engine reported `occluderIneffective: never_blocked_before_conflict` and
  `runway_insufficient`. Independent agreement, from a completely different direction.
* **3 cells the gate rejects, the judge calls `high`.** All three were rejected by `evaluate` on the
  PET invariant alone (`min PET 0.13 s`, `0.14 s`, `0.00 s` against a `[0.2, 2.5]` band) with clearances
  of 2.168, 2.906 and **0.807 m**. These are the *tightest* near misses in the run. That is not
  necessarily a gate defect — a PET floor is a deliberate "not a collision-by-luck" guard — but it is
  worth knowing that the physically most severe cells in the batch are the ones C5 throws away.

### Does the judge follow its own rules?
`verdictModel == verdict` on **28/28**. The model, given the verdict rules in the prompt, reproduces the
Python `_verdict()` result exactly. The rules are still applied in Python; this only says the model is
not fighting them.

### Is the judge catchable?
Mean `cross_check` reliability **0.821**, minimum 0.75 — no cell fell below the 0.5 cap threshold, and
the failures are concentrated in `other_party_ok` (the model names "the child" where the actor id is
`child`, and the substring test is strict). The check is doing its job as a tripwire without firing
spuriously.

### Is the difficulty score meaningful?
The model's independent `predicted_difficulty_0_100` correlates **r = 0.822** with the trajectory-derived
measured difficulty, mean absolute error **1.4 points**. Two independent estimates of "how much did the
ego have to do" agreeing that closely is evidence that the measured score is tracking something the
model can also see, rather than an arbitrary weighted sum.

Difficulty separates the verdicts in the expected direction:
`physically-valid-but-boring` 46.8 < `acceptable` 56.7 < `high` 60.2.
(`intent-not-realised` scores 68.5 — deliberately: those cells have a *high* action budget because the
ego brakes hard, they simply are not the scenario that was asked for. Difficulty and quality are
different axes and the rubric keeps them apart.)

### The systemic finding — CORRECTED
The first version of this section reported `PROXIMITY_IS_NOT_THE_CONFLICT` firing on **28/28 cells**.
**That was a bug in my own measure, not a finding, and it is retracted.** The v1 "contested space"
instant was `argmin_t |lateral bearing offset|`, which is a bearing test, not a path test; it fires on
anything on the ego's forward axis at any distance, so it could never coincide with a closest approach.
A flag that fires on 100% of cells should have been treated as an alarm.

The rigorous replacement is `judge/conflict.py`: the minimum over **all tick-index pairs** `(i, j)`
(different times allowed) of `clearance(ego_i, challenger_j)`. Zero means the two bodies genuinely
occupied the same ground. On the same 28 cells:

* `pathSeparationM = 0.000` on **28/28** — every cell is a real encroachment
* `encroachmentGapS` 0.38–1.80 s (a footprint-measured post-encroachment time)
* `lagS = tMinClear − tCross`: median **0.12 s**, max **0.72 s** → **28/28 same event**

So the gate's C3 is scoring the right instant. `PROXIMITY_IS_NOT_THE_CONFLICT` now fires on 0/28.

What survives is narrower and real: **8/28 cells have a challenger that has stopped dead (0.0 m/s) by
the time the ego reaches the contested ground** (`CHALLENGER_STOPPED_AFTER_CROSSING`, and
`CHALLENGER_STOPPED_AT_CONFLICT` on 10/28). The encroachment happened; the near-miss the gate then
scores is a pass-by of a now-stationary pedestrian. That is a realism defect (route exhaustion), not a
conflict-detection defect, which is why `conflict.c3b_conflict_is_the_proximity()` ships with its
stopped-challenger clause **defaulted off**.

### Negative controls, final run

| control | gate | judge verdict | R1 | R2 | R3 | R4 | R5 | caps |
|---|---|---|---|---|---|---|---|---|
| B1 boring pass-by | PASS | **physically-valid-but-boring** | 3 | 1 | 0 | 0 | 4 | none |
| B2 ghost prop | PASS | **invalid** | 3 | 1 | 1 | 0 | 0 | R5 3→0 |
| B3 ordinary cut-in | PASS | physically-valid-but-boring | 3 | 2 | 1 | 3 | 4 | none |

B1: *"The brief is technically realised, but this contains no genuine conflict or non-trivial ego
response and should not occupy an edge-case slot."*

B2 remains the most important line in this table: the model scored plausibility **3/4** on a clip in
which the ego drives straight through a parked SUV. Only the mechanical `EGO_INTERSECTS_PROP` flag
caught it. **Vision did not catch a body interpenetration.** That is a fact about what a seeing harness
can and cannot be trusted with, and it is the reason the mechanical-flag layer exists.

### Cost
Two `gpt-5.6-luna` calls per cell (blind description, then rubric), plus two renders. ~25–40 s per cell
at 5 workers. The 28-cell run completed in a few minutes.
