# GATE-AUDIT.md — adversarial audit of `tools/vista/gate.py`

Independent evaluation lane. Everything below is reproduced by two scripts in this directory:

```bash
cd /Users/michaelvu-simforge/Documents/Programming/SimForge-vista
MPLBACKEND= .venv/bin/python research/edge-case-corpus/tools/vista/judge/check_obb.py     # geometry cross-check
MPLBACKEND= .venv/bin/python research/edge-case-corpus/tools/vista/judge/gate_probes.py   # 11 adversarial probes
```

`gate_probes.py` writes `gate-probes.json`. Each probe's docstring *is* the claim; the printed dict is
the evidence. No probe needs the engine — they are synthetic traces in the engine's own on-disk shape,
so every counter-example is a statement about the gate code alone and cannot be blamed on the sim.

---

## 0. Summary

| # | severity | claim | verdict |
|---|---|---|---|
| **A1** | — | OBB clearance is exact | **CONFIRMED** — agrees with 3 independent implementations to 3e-13 m, and with the engine's own `exact-sampled-obb-clearance` to **0.000 m on 3/3 probe0 cells** |
| **A2** | — | trace `t=0` is post-warm-up (D1) | **CONFIRMED independently**, 3/3 cells, offset = `warmupSeconds * v0` to 0.001 m |
| **A3** | **HIGH** | a scenario can pass C1–C5 and be junk | **CONFIRMED**, constructive counter-example `P5` |
| **A4** | **HIGH** | C2 double-counts warm-up | **CONFIRMED**, `P4`. Over-strict by exactly `warmupSeconds` |
| **A5** | **HIGH** | C2/C3 are scored on the *global* closest pair, not the *intent* pair | **CONFIRMED**, `P5` (launders a pass) and `P5b` (destroys a good scenario) |
| **A6** | **HIGH** | C4 is taken on faith from `metrics`, never checked against the trajectory | **CONFIRMED**, `P6` |
| **A7** | **HIGH** | props are invisible to the gate *and* `collidable:false` | **CONFIRMED** from real traces |
| **A8** | MED | C1 measures path length, not progress | **CONFIRMED**, `P10` — an ego doing a closed 130 m circle passes |
| **A9** | MED | actor tracks are never checked for continuity | **CONFIRMED**, `P3` |
| **A10** | MED | missing `dims` silently substitutes a 0.6 m box | **CONFIRMED**, `P8` |
| **A11** | LOW | `obb_clearance` returns 0.0 for two zero-area actors | **CONFIRMED**, `P7` |
| **A12** | LOW | sampling aliasing, shared with the engine | **CONFIRMED but bounded**, `P9` — 0.04 m typical, 0.16 m adversarial worst |
| **A13** | LOW | reported `clearanceM`/`closestT` are wrong when the true min is > ~6 m | **CONFIRMED**, `P1`. Does **not** affect pass/fail |
| **F1** | **HIGH, not a gate bug** | instance files mix frame conventions: position is `(x, z=-y)` but `headingRad` is already in the `(x, y)` frame | **CONFIRMED**. Bit me during this audit; will bite the visual author harder |

Nothing found makes the gate **looser** than its written spec. Two findings (A4, A5-negative-direction)
make it **stricter** than intended, and that matters because the project's headline number — "C2 is
29.3% of all admission loss" — is measured with this code.

---

## 1. Is the OBB clearance exact? YES.

`check_obb.py` compares four implementations on 53 cases (13 hand-built degenerate/geometric cases,
40 randomised car–car and car–pedestrian pairs):

* **A** `gate.obb_clearance` — vertex-to-edge minimum, SAT overlap test (under audit)
* **B** all-pairs segment-to-segment minimum + winding-number containment
* **C** dense boundary sampling (400 points/edge), brute force
* **D** **exact via the Minkowski difference**: `clearance = dist(origin, conv(A ⊖ B))`, monotone-chain hull

These are three genuinely different formulations, not three spellings of one.

```
case                            A(gate)  B(segseg)  C(sampled)      D(qp)    maxdiff
far-apart-parallel            45.200000  45.200000   45.200000  45.200000   0.00e+00
touching-nose-to-tail          0.000000   0.000000    0.000000   0.000000   0.00e+00
overlapping-identical          0.000000   0.000000    0.000000   0.000000   0.00e+00
overlapping-partial            0.000000   0.000000    0.000000   0.000000   0.00e+00
ped-vs-car-3m-lateral          3.000000   3.000000    3.000000   3.000000   0.00e+00
ped-vs-car-side-exact1m        1.000000   1.000000    1.000000   1.000000   0.00e+00
corner-to-corner-45            1.601822   1.601822    1.601822   1.601822   2.65e-13
perp-t-bone-gap                1.650000   1.650000    1.650000   1.650000   0.00e+00
truck-vs-ped-tight             0.822845   0.822845    0.822910   0.822845   3.41e-13
degenerate-zero-dims           0.000000   5.000000    5.000000   5.000000   5.00e+00   <-- A11
edge-edge-parallel-1m          1.000000   1.000000    1.000000   1.000000   0.00e+00
nested-ped-inside-car          0.000000   0.000000    0.000000   0.000000   0.00e+00
touching-corner-exact          0.000000   0.000000    0.000000   0.000000   0.00e+00

WORST |A-B| / |A-D| over 53 cases: 5.000e+00   (entirely the degenerate case)
```

Excluding the degenerate case the worst disagreement is **3.4e-13 m**. Overlapping, touching,
corner-touching, pedestrian-vs-car and nested cases are all handled correctly. **Your implementation is
exact.**

### Cross-check against the engine (independent of the above)
`gate.trace_facts` vs the engine's own `no-contact` invariant (`method: exact-sampled-obb-clearance`)
on all 3 cells of `/tmp/vista-probe0`:

| map / site | gate clearance, t | engine invariant, t | Δ |
|---|---|---|---|
| belmont / 91aa10ce | 2.347 m @ 8.40 s | 2.347 m @ 8.40 s | **0.000** |
| yale / 06ae24d1 | 3.417 m @ 9.16 s | 3.417 m @ 9.16 s | **0.000** |
| yale / 25fd4ad6 | 2.128 m @ 8.72 s | 2.128 m @ 8.72 s | **0.000** |

Your ≤0.001 m claim holds, and it is tighter than that: exact to the printed precision, including the
time index.

### A12 — but that agreement proves less than it looks
Both you and the engine evaluate clearance only at trace samples. `P9` builds a 25 m/s × 25 m/s
perpendicular near-miss and re-samples it at four sub-tick phases:

```
clearance at dt=0.02, 4 sampling phases : [1.460, 1.492, 1.460, 1.450]
clearance at dt=0.0005 (reference)      :  1.450
aliasing spread                         :  0.042 m
```

A 300-case randomised sweep over crossing angles and speeds put the **worst overestimate at 0.161 m**
(true clearance 0.002 m read as 0.163 m). So gate–engine agreement is agreement between **two samplers
with identical aliasing**; it does not establish that either equals the continuous minimum. At the C3
threshold of 5.0 m the effect is immaterial. It is *not* immaterial if you ever report "closest approach
was 0.15 m" as a headline number — that could be a true 0.00 m grazing contact.

### A11 — the one geometry defect
`_sat_overlap` builds a candidate separating axis from every edge as `(-(y2-y1), (x2-x1))`. For an actor
with `l == w == 0` all four edges are zero-length, so every axis is `(0,0)`, every projection is `0`,
`max(pa) < min(pb)` is `0 < 0` = False on both sides, no axis ever separates, and the function reports
overlap. Two point-actors 5 m apart therefore report **0.0 m clearance and pass C3 for free**.

```
P7 => {"point_vs_point_5m_apart": 0.0, "expected": 5.0, "point_vs_car_ok": 2.6, "defect": true}
```

Only *mutually* degenerate pairs are affected (point-vs-car is correct at 2.6 m). Reachability is low
with the current catalog, but the fix is one line and it removes a silent free pass:

```python
axl = math.hypot(ax, ay)
if axl < 1e-12:
    continue          # degenerate edge, not a usable separating axis
```
and a length guard so a fully-degenerate polygon pair falls through to the vertex-distance path.

### A13 — the broad-phase short-circuit corrupts the *reported* numbers
```python
cut = er + ar + C3_CLEARANCE + 1.0
if gap > cut and loc['clearanceM'] < float('inf'):
    continue
```
Tick 0 is always evaluated (the `< inf` guard), so if every later tick is culled the recorded
`clearanceM`/`closestT` are **the t=0 values, not the minimum**:

```
P1 => gate: 198.1 m @ t=0.0    truth: 68.1 m @ t=6.5
```

**Pass/fail is still sound**: `gap > cut` implies `clearance > 6 > 5`, so any clearance that could satisfy
C3 is always computed exactly. But `clearanceM` and `closestT` are consumed by your failure census, and
by anything downstream (including my judge). Every cell whose true minimum exceeds ~6 m reports a
fabricated distance at a fabricated time. **If the 17.6% "C3 clearance > 5 m" bucket was binned by the
reported distance, those bins are meaningless.** Fix: drop the `< float('inf')` clause and instead track
the culled minimum-centre-distance separately as a lower bound.

---

## 2. Does it handle absent actors? YES, with one gap.

`P2` (control): a challenger present only for `t ≤ 1.0 s` is correctly ignored afterwards; the
`present[i]` guard works, and the ego path-length accumulator correctly resets `px` across a gap so a
despawn/respawn does not inject a phantom distance.

**A9 — but there is no continuity check at all.** `P3` teleports a challenger: present at (200,200) for
3 s, `present=false` for 3 s, then present again 2 m off the ego's nose at 10 m/s. The gate reports a
clean 0.7 m closest approach at t=6.0 and is perfectly happy:

```
P3 => {"clearanceM": 0.7, "closestT": 6.0, "gate_notices_teleport": false}
```

Nothing in C1..C5 penalises an actor that appears from nowhere into a conflict. For a *generative*
pipeline this matters: "make the challenger appear late" is a cheap way to manufacture criticality, and
it is exactly the kind of thing an optimiser will find. Recommended tightening (allowed):
**every actor that participates in the closest approach must be `present` continuously from t=0 to the
closest-approach time, and its per-tick displacement must be ≤ `1.5 * speedMps * dt + 0.05`.**

---

## 3. Is the C2 test right? **NO — it double-counts the warm-up.** (A4)

I re-verified the D1 finding independently, on all 3 probe0 cells, by comparing the instance file's
authored pose to trace `t=0`:

| map | \|trace t0 − instance pose\| | `warmupSeconds * v0` |
|---|---|---|
| belmont | 8.941 m | 8.941 m |
| yale | 11.111 m | 11.111 m |
| yale | 11.111 m | 11.111 m |

3/3 exact. **`D1-RESOLVED.json` is correct: trace `t=0` is the post-warm-up state, and warm-up is not
recorded in the trace.** (Frame check en route: instance `z` = −trace `y`, exact. See F1 below for the
part of that convention that is *not* what it looks like.)

The consequence for C2:

```python
c2 = f['closestT'] > f['warmupSeconds'] + C2_MARGIN
```

`closestT` is measured on a clock whose origin is already `warmupSeconds` after the actors were placed.
The spec sentence "closest approach occurs at `t > warmupSeconds + 0.5`" was written assuming the trace
clock starts at spawn. It does not. So the implemented clause demands the conflict happen
**`warmupSeconds + 0.5` seconds after warm-up ended**, i.e. `2*warmupSeconds + 0.5` seconds after spawn.

```
P4 => {"closestT": 1.82, "warmupSeconds": 2.0,
       "C2_as_implemented": false, "C2_semantic_intent": true, "defect": true}
```
— a genuine moving mid-clip conflict, 2.2 s of simulated time after placement, rejected as a spawn
artifact.

**This is a tightening, so it admits no junk, and I am not asking you to loosen it.** But it is a
measurement bug in the direction that inflates your headline diagnosis. The reported "C2 = 29.3% of all
admission loss, the single largest loss" is measured with a clause that is over-strict by exactly
`warmupSeconds`. Some share of that 29.3% is bookkeeping, not scenario error, and the visual-authoring
recovery you are about to measure against it will be measured against an inflated baseline.

**What I recommend (does not loosen the frozen gate):** keep `C2` exactly as written as the admission
clause, and additionally compute and report `C2_spawn = closestT > 0.5` as a *diagnostic*. Publish both
numbers. If they differ materially you have found a large free win that is not an authoring win, and you
need to know which is which before claiming sight beat blindness.

---

## 4. Can a scenario pass C1–C5 and still be JUNK? **YES.** (A3, A5, A6)

### `P5` — the counter-example, in full

Three actors, 13 s clip, `warmupSeconds = 1`:

| actor | motion |
|---|---|
| `ego` | straight line, **rigidly constant 10 m/s**, never steers, never brakes |
| `challenger` | the scenario's nominal actor. Closest at spawn (5.24 m at t=0) then diverges — the textbook C2 failure |
| `parked` | a **stationary** vehicle 2.2 m off the ego's path at x = 80 m |

```
P5 => {"per_challenger": {"challenger": {"clearanceM": 5.24, "t": 0.0},
                          "parked":     {"clearanceM": 2.2,  "t": 7.52}},
       "closestWith": "parked", "ego_speed_min_max": [10.0, 10.0],
       "C1": true, "C2": true, "C3": true, "C4": true, "C5": true, "PASS": true}
```

A car driving in a straight line at constant speed past a parked car is **ADMITTED as a critical edge
case**. The mechanism is that **C2, C3 and C4 are never required to refer to the same actor**:

* C3 is `min over all non-ego actors`. Any static vehicle within 5 m of the ego's path satisfies it.
* C2 is scored on whichever actor won that global minimum, so the same static vehicle also launders C2 —
  the real challenger's spawn artifact is simply never looked at.
* C4 reads `metrics.requiredDecelMax['ego']`, a **scenario-level scalar** with no attribution to an actor
  or a time. Any deceleration anywhere in the clip, for any reason (a speed-limit change, a signal, an
  unrelated lead vehicle), satisfies it.
* C5 is `evaluate`'s verdict, which the lane contract already documents as insufficient.

**Is this reachable in the real pipeline?** Yes, and cheaply. Confirmed from the real artifacts: `props`
are *not* in `ticks['actors']` (probe0 `evidence.actorIds = ["child","ego"]` while `propMetadata` holds
`parked-pair-0/1`), so *props* cannot do this. But any second **role** can, and second vehicle roles are
routine in this taxonomy — a lead vehicle, an oncoming vehicle, a stopped bus, an occluding truck. Any
template that puts a low-speed or stationary vehicle role within 5 m of the ego's corridor has a free,
permanent C2+C3 pass, regardless of whether its actual scenario mechanism ever fires. **An agentic author
rewarded by this gate will find that.** It is the single most exploitable property of the gate.

### `P5b` — the same defect, the other way round, and this one is costing you admissions

A genuinely good scenario: the challenger crosses the ego with a real 2.39 m conflict at t = 6.94 s. But
a second, irrelevant vehicle is parked 1.0 m off the ego's shoulder at the ego's spawn point.

```
P5b => {"per_challenger": {"challenger": {"clearanceM": 2.387, "t": 6.94},
                           "kerbside":   {"clearanceM": 1.0,   "t": 0.0}},
        "closestWith": "kerbside",
        "C2_as_implemented": false, "C2_if_scored_on_conflict_pair": true,
        "PASS": false, "defect": true}
```

The parked car owns the global minimum at t=0, so C2 rejects the cell. **The gate's dominant reported
failure mode has exactly this shape.** Combined with A4, I would not trust the 29.3% figure until both
are controlled for.

### Recommended tightening (strictly stricter, never looser)
Score C2, C3 and C4 **per challenger** and require a single actor to satisfy all three:

```python
# ADMIT iff there exists a challenger j such that:
#   clearance(ego, j)                <= 5.0                      (C3)
#   argmin_t clearance(ego, j)        > 0.5                      (C2, spawn-relative)
#   ( requiredDecelMax['ego'] >= 1.5 and 'ego' in decel_attribution(j) )
#     or ( minTTC.pair contains 'ego' and j and minTTC.value <= 3.0 )   (C4)
```
plus, as a separate clause the current gate has no analogue of and which `P6`/`P10` both need:

```python
# C6 (new): the ego's own trajectory shows a response.
#   max over t of (-dv/dt) >= 1.0 m/s^2   OR   |heading rate| integral >= some threshold
#   measured FROM THE TRAJECTORY, not from metrics.
```

### A6 — C4 is unverified
`P6`: the ego's speed array is rigidly constant, so its observed peak deceleration from the trajectory is
**0.0000 m/s²**, yet `metrics.requiredDecelMax['ego'] = 3.0` and C4 passes.

```
P6 => {"reported_requiredDecelMaxEgo": 3.0,
       "observed_peak_decel_from_trajectory": 0.0, "C4": true, "PASS": true}
```

`requiredDecelMax` is a *counterfactual* ("what the ego would have needed"), so a mismatch is legal in
principle — but the gate has no clause at all tying the verdict to the ego's actual behaviour, and this
one number is doing all the C4 work. Two further unchecked items in the same family:

* **`minTTC.pair` is never checked to contain `ego`.** `metrics.minTTC` is read as a bare scalar. In
  probe0 the pair happens to be `["child","ego"]`, but nothing in `gate.py` requires it. With ≥3 actors a
  challenger-vs-challenger TTC would satisfy C4.
* **`metrics.clippedCriticality` is never checked.** It is present in every trace and flags that the
  solver had to clip the criticality target. `clippedCriticality: true` means the scenario sits on the
  solver's boundary; those are exactly the cells most likely to be degenerate. Adding
  `not clippedCriticality` to C5 is a free, sound tightening.

### A8 — C1 measures path length, not progress
`P10`: an ego driving a **closed circle**, 130 m of path, **0.00 m net displacement**, with a pedestrian
parked 1.5 m outside the circle.

```
P10 => {"distanceTravelledM": 129.999, "net_displacement_m": 0.0, "C1": true, "PASS": true}
```

C1's stated intent is "the ego actually drives". Path length is the right primary measure (a scenario
that ends where it began by design is legitimate), but adding
`net_displacement >= 0.5 * distanceTravelled` (or a route-progress check against the ego's `laneRsl`
sequence) would kill circling, oscillation, and reverse-then-forward artifacts for free.

### A10 — missing `dims` are silently substituted
`P8`: deleting a car challenger's `dims` from `actorMetadata` changes the reported clearance from 1.50 m
to 2.15 m with no warning, because the default is `l=0.6, w=0.6` — a pedestrian's footprint. That default
is exactly a child pedestrian's size, so the failure is invisible in the templates you have been probing
with. **Make it raise.** The dims are always present in a well-formed trace; a silent default here can
only ever hide a bug.

---

## 5. A7 — props are invisible to the gate, and non-collidable

This is not a bug in `gate.py` so much as a hole in the gate *as a specification*. From the real probe0
traces:

* `header.propMetadata['parked-pair-0'].collidable == false`
* props do not appear in `ticks['actors']`, so `trace_facts` never sees them
* `metrics.collisions` therefore cannot include a prop

Measured ego-to-prop OBB clearance on the three admitted probe0 cells (my own computation; the gate
reports nothing here):

| map / site | parked-pair-0 | parked-pair-1 |
|---|---|---|
| belmont / 91aa10ce | 1.012 m @ 7.88 s | 1.081 m @ 8.68 s |
| yale / 06ae24d1 | 1.873 m @ 9.74 s | 1.247 m @ 11.18 s |
| yale / 25fd4ad6 | **0.763 m @ 8.08 s** | **0.788 m @ 8.80 s** |

Those are tight but physical for kerbside parking. The point is that **nothing checks them**.

### Reproduced on the real engine, not asserted
I took your gold template, changed exactly one number — `props[0].pose.tFrac: -0.78 -> 0.0`, i.e. the two
parked SUVs now sit in the **centre of the ego's own lane** — and ran it:

```bash
node packages/cli/bin/simforge.js batch /tmp/judge-propinlane.template.json \
  --all-maps --draws 1 --max-sites 3 --out /tmp/judge-a2 --concurrency 2
```

| map / site | ego-vs-prop-0 | ego-vs-prop-1 | `metrics.collisions` | engine `no-contact` | C1 | C2 | C3 | C4 |
|---|---|---|---|---|---|---|---|---|
| belmont / 91aa10ce | **0.000 m** @ 7.36 s | **0.000 m** @ 8.30 s | `[]` | held, 2.347 m | ✔ | ✔ | ✔ | ✔ |
| yale / 06ae24d1 | **0.000 m** @ 7.88 s | **0.000 m** @ 8.86 s | `[]` | held, 3.417 m | ✔ | ✔ | ✔ | ✔ |
| yale / 25fd4ad6 | **0.000 m** @ 7.50 s | **0.000 m** @ 8.36 s | `[]` | held, 2.128 m | ✔ | ✔ | ✔ | ✔ |
| yale / 33a10046 | **0.000 m** @ 2.06 s | **0.000 m** @ 2.06 s | `[]` | held, 3.056 m | ✔ | ✔ | ✔ | ✔ |

The ego's oriented bounding box **fully overlaps two stationary SUVs**, in every cell, and:

* `metrics.collisions` is empty (props are `collidable:false`),
* the engine's own `no-contact` invariant reports "held" at 2.1–3.4 m, because it too only considers
  *actors*,
* **C1, C2, C3 and C4 all pass**.

The only thing that stopped these cells was `C5`, and it stopped them for an **unrelated, incidental**
reason: `occlusion_unproven` / band `trivially-safe` — the SUVs, having moved into the lane, no longer
occlude the child. **A template with no declared occlusion has no such backstop.** Occluders in this
taxonomy are props (`vehicle.suv`, `vehicle.boxTruck`), and occlusion drives a large fraction of the
interesting categories, so this is live, not theoretical. **Recommended tightening: add
`min over props of OBB clearance(ego, prop) > 0` as a hard clause.** It costs one function you already
have and it is the single cheapest defence against "physically impossible but admitted".

---

## 6. F1 — the frame convention is a *mixed* convention, and this will bite the visual author

Your stated rule — "instance files use `(x, z)`; trace/topology use `(x, y)` with `y == -z`" — is correct
**for positions** and wrong **for headings**. Ground truth, yale-street cell `25fd4ad6`:

| | instance | trace `t=0` |
|---|---|---|
| ego position | `x=671.56, z=-1666.69` | `x=677.72, y=+1675.93` (= −z, plus warm-up travel) |
| ego `headingRad` | **0.9829** | **0.9829** |
| ego heading from trace velocity | | **0.9827** |

`headingRad` is **identical in both files and is already the `(x, y)`-frame heading**. Under the naive
`z → y = −z` transform a heading would have to negate; it does not.

Confirmed independently on props: `propMetadata['parked-pair-0'].pose.headingRad = 0.9786`, and the
`(x,y)`-frame tangent of the parking lane it sits on (`102:0:-2`) is `0.9780` — agreement to **0.001 rad**.
Negating gives a **1.96 rad** error.

I hit this during this audit: negating prop headings made the ego appear to drive *through* both parked
SUVs at 0.000 m clearance. It looked like a spectacular engine defect. It was my sign error. **That is
precisely the failure a seeing author will produce**, and it is worse for a seeing author than a blind
one, because a mirrored OBB in a rendered PNG looks completely plausible — it is a car, on a road, at a
believable angle — and the agent will confidently "repair" a problem that does not exist. See
`FAILURE-MODES.md` §1.

Anything that renders from an instance file must use `(x, −z, headingRad)` with **no sign flip on the
heading**, and the harness should assert it: for any moving actor, `|headingRad − atan2(vy, vx)| < 0.05`
at the first tick. It is a one-line assertion that removes an entire class of silent catastrophe.

---

## 7. Minor / API

* `gate_cell(path)` called without `verdict`/`band` always returns `C5 = False`. It is easy to call it
  standalone on a single trace and conclude the trace fails. Make the signature require them, or return
  `C5: None`.
* `dt` is read from the header but never used.
* `trace_facts` will `KeyError` on a trace missing `present`; `traceVersion` is not checked. A version
  bump that renames a column would silently produce wrong numbers rather than an error.

---

## 8. What I would change, in priority order (all strictly tightening)

1. **Per-challenger conjunction for C2∧C3∧C4** — kills `P5`, un-kills `P5b`. Highest value by far.
2. **New C6: the ego's own trajectory must show a response** (peak observed decel ≥ 1.0 m/s² or a
   measurable steering response), computed from `speedMps`/`headingRad`, not from `metrics`. Kills the
   "ego sails through at constant speed" family that `P5`/`P6` both exploit.
3. **Ego-vs-prop clearance > 0** as a hard clause.
4. **Assert `'ego' in metrics.minTTC.pair`**, and add `not metrics.clippedCriticality` to C5.
5. **Report `C2_spawn = closestT > 0.5` alongside C2** as a diagnostic, and re-derive the 29.3% figure
   with it before using that number as a baseline.
6. **Continuity/no-teleport clause** on the conflict challenger.
7. **Raise on missing `dims`**; guard the degenerate separating axis; drop the `< inf` clause in the
   broad-phase cull.
8. `net_displacement >= 0.5 * pathLength` in C1.


---

## 9. Real-batch sanity run (28 cells)

```bash
node packages/cli/bin/simforge.js batch \
  research/edge-case-corpus/templates/expA-child-dartout-two-cars.template.json \
  --all-maps --draws 4 --max-sites 6 --out /tmp/judge-a1 --concurrency 3
```

`gate_batch` result: **19/28 cells pass, 2 maps, 6 sites, ADMITTED.**
Loss counts: `{C1: 0, C2: 0, C3: 0, C4: 0, C5: 9}` — every loss is C5 (`evaluate` rejected: 5 × PET
invariant violated, 4 × infeasible/`runway_insufficient`).

Two things worth noting from this run:

1. **On this template family C2 never fires and the A4 warm-up bug costs nothing.** All 28 closest
   approaches land at 8.0–9.4 s except site `33a100467f1b70e4` at 2.04–2.24 s, and even those clear
   `warmupSeconds(=1) + 0.5`. A4 becomes expensive only when `warmupSeconds` is larger or when the
   conflict is engineered early — which is exactly what the categories that lose most to C2 (C6 cut-in,
   C14, C11) look like. It should be measured on those, not on a dart-out.
2. **All 12 cells at sites `25fd4ad601d7872b` and `f40e79ec8edcfd77` report near-identical clearance**
   (2.128 m four times in a row at `25fd4ad6`, across four different parameter draws with different
   `arrivalTtc`, `childSpeedKph` and `gapM`). The clearance is *pinned by geometry*, not by the draw.
   Four "distinct cells" at one site are therefore close to one sample, and the ≥3-sites / ≥2-maps
   spread rule counts sites, not independent conflicts. That is another reason the gate alone cannot
   certify corpus quality, and part of why the corpus-layout judge called the corpus "inadequate".
