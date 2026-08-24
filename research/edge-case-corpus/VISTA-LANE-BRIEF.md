# Research brief: a VISTA-style visual harness for driving-scenario authoring

You are taking over an independent research lane. Read this whole brief before running anything.
It contains the goal, the frozen contract you must obey, the repo facts you need, the baseline you are
trying to beat, and a list of footguns that have already cost previous agents entire runs.

---

## 0. Credentials and model (hard constraints)

```python
import os, httpx
os.environ['OPENAI_API_KEY'] = "sk-proj-REDACTED-ROTATE-ME"
```

**Model: `gpt-5.6-luna`, reasoning effort `medium`. This is the ONLY permitted model.**
Do not substitute another model. Do not use a Codex OAuth token.

Text call:
```python
r = httpx.post("https://api.openai.com/v1/responses",
    headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
    json={"model":"gpt-5.6-luna","reasoning":{"effort":"medium"},"max_output_tokens":4000,
          "input":[{"role":"user","content":[{"type":"input_text","text":PROMPT}]}]}, timeout=180)
```
Vision call — add to the same `content` list:
```python
{"type":"input_image","image_url":f"data:image/png;base64,{b64}"}
```
Parse: `d['output']` -> items -> `content` -> entries with `{'type':'output_text','text':...}`.

Verify this works in your FIRST cell. Two previous agents concluded the key or model did not exist and
wasted their entire runs. It does exist; hundreds of calls including vision calls have been made with it.

---

## 1. The goal

Build a **general, novel, anti-overfitting algorithm** that produces and validates **~100 distinct
edge-case driving-scenario archetypes**, spanning the 15-category taxonomy in
`docs/research/interactions-and-edge-cases.md`.

The deliverable is an **ALGORITHM that generalises**, plus the corpus it produces. Hand-tuning 100
scenarios one at a time is explicitly NOT the goal, and is the primary failure mode to avoid.

Each admitted archetype must be a **portable ScenarioTemplate v2**: a logical anchor over road structure,
with **no coordinates and no road IDs**.

---

## 2. The core idea you are testing

From **VISTA** (https://vista-research.github.io/), which completed all 25 public ARC-AGI-3 games with a
100% win rate using a deliberately minimalist harness. Its three designs:

1. **Perception through raw high-dimensional input** — the agent reads 512x512 PNGs directly. It is never
   told the world is a 64x64 grid. Raw images retain spatial relations the model can reason over.
2. **Reasoning in language** — no task-specific engineering.
3. **Lossless visual memory** — every frame is stored losslessly with turn/frame index. An `inspect` tool
   re-views any past frame, region or zoom; `read_pixels` returns exact values at a point. This is an
   *explicit attention mechanism* over history, versus the lossy, limited-horizon KV cache.

They also found the same world given as a text grid works but costs far more tokens, and that a 3D
rendering also works — the method is not tied to 2D.

### Why this should apply here
The existing lane's authoring agent is **BLIND**. It emits JSON tool calls and never sees the road.
Every large measured win in that lane came from a **spatial** fix — MUTCD taper geometry, VRU lane
binding, junction arrival geometry. Those are things you would see instantly in a picture and cannot
easily find by numeric search.

### The two applications to build (these are the sharpest form of the idea)

**(a) Closed-loop visual scenario editing — the car-placement problem.**
Give the agent a rendered orthographic top-down viewport of the corridor. It places an actor, the harness
re-renders, and the agent **compares the new frame against its own stated expectation**. Off-road
placements, phantom-road placements, actors on the wrong side of the ego, and overlapping actors become
**visible errors the agent can see and repair**, instead of silent coordinate mistakes.
- your `inspect` equivalent = "zoom into this road region"
- your `read_pixels` equivalent = "query what surface is at this point" (drivable / sidewalk / junction /
  off-road). You have exact ground truth for this from the topology index, so implement it as a real
  semantic query, not a colour sample.

**(b) A second VISTA-style agent as a CRITIC.**
It watches the **rendered rollout** of a variation and verifies that the intended event actually occurred
— that the cut-in happened, that the jaywalk crossed the ego path, that the occluder actually occluded.
The **predict/verify discipline is the QA mechanism**: the author states what should happen, the critic
checks the rollout independently.

**(c) Difficulty scoring, RHAE-style.**
VISTA scored Relative Human Action Efficiency. The analogue here: rate scenario difficulty by the
**action or intervention budget** required to survive it — how much braking/steering authority, how
little margin, how many decisions. That gives a principled "is this variation actually hard?" metric for
the dataset, rather than a binary pass/fail.

**Prediction to test explicitly (from a failure census over 819 traces):** the single largest admission
loss is `C2` — the ego and challenger are **closest at spawn and then diverge** — at **29.3% of all
traces**. That is exactly the error a human catches in one glance at a t=0 top-down render: two boxes on
top of each other, or the challenger on the wrong side. It is invisible to a blind agent. **Render t=0
and have the agent check separation BEFORE simulating, and measure how much of that 29.3% you recover.**

---

## 3. The repo

**Path:** `/Users/maikyon/Documents/Programming/UniScenarios`
It is a TypeScript monorepo. **Every package's `main` points at `src/index.ts` and the CLI registers the
`tsx` ESM loader — there is NO build step and no `dist/`.** Editing a `.ts` file takes effect on the next
CLI invocation immediately. (Verify with `head -20 packages/cli/bin/uniscenarios.js`.)

### CLI
```bash
cd /Users/maikyon/Documents/Programming/UniScenarios
node packages/cli/bin/uniscenarios.js <command>
```
Commands: `maps list`, `locations find|get|resolve`, `template validate`, `sites match`, `instantiate`,
`simulate`, `debug`, `validate`, `evaluate`, `evidence verify`, `export`, `catalog create|verify|batch`,
`batch`, `schemas`.

Useful invocations:
- `sites match <template.json> --all-maps` (also `--map <id>`, `--rejected`, `--max-sites`, `--min-score`).
  There is **no `--limit`**. On failure the JSON contains a `failureSummary` naming the clauses that
  failed and at how many sites — this is the single most useful debugging output in the repo.
- `evaluate <trace.json.gz> [--rubric <rubric.json>]` -> `{verdict, band, intentEvaluation}`.
- `evidence verify <instance.json> <trace.json.gz>` -> replay determinism. **Needs BOTH files.**
- `batch` runs a template across sites x draws; it is CPU-bound node and is the wall-clock bottleneck.

### Maps and geometry (what you render from)
`/Users/maikyon/Documents/Programming/UniScenarios/dev-assets/<mapId>/topology-index.json.gz` — gunzip + json. Key `lanes` is a **dict keyed by `rsl`**
(NOT a list). Each lane has `polyline` (list of `{x,y}`), `representativeWidthM`, `laneType`
(`driving|sidewalk|shoulder|parking`), `isJunction`, `junctionId`, `predecessors`, `successors`,
`speedLimitKph`. Yale alone has 1141 lanes.
Also `derived/topology-derived.json.gz` and `derived/locations.json.gz`.

The 5 maps: ['yale-street', 'belmont-research-center', 'el-camino-road', 'easterbrook-discovery-school', 'richmond-field-station']

### A working renderer already exists
`/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/tools/vista/render.py` — headless matplotlib top-down renderer. It draws lanes coloured by type,
junction surfaces, the ego lane highlighted, a metre grid, and actor OBBs. It returns the
**pixel<->world transform**, plus:
- `world_from_pixel(view, px, py)` — invert the render transform
- `nearest_lane(dev_assets, mapid, x, y)` -> `{rsl, s, lateralM, tFrac, distanceM}`

**That projection is the key to portability** (see section 4). Renders take ~1 s per site.

**Feasibility is already proven.** I rendered a junction approach and gave the PNG to `gpt-5.6-luna`
cold. It correctly reported the junction was visible, got the ego's direction of travel right
(upper-left to lower-right), and estimated 84 m from lane start to the junction on a 114 m lane where the
view was centred on the junction end. Perception works on this data — you are not testing that.

### Trace format (read this before touching a trace)
Traces are `*.trace.json.gz`, keys `['events','header','metrics','ticks']`.
`ticks` is **COLUMNAR**: `ticks['t']` is a list of times; `ticks['actors'][actorId]` has parallel arrays
`x, y, s, speedMps, headingRad, laneRsl, lateralOffsetM, motionDirection, present`, plus a `physics`
sub-dict with per-tick arrays.
**NEVER print a whole tick object or a whole actor dict — they are tens of thousands of numbers and will
blow up your context.** Slice explicitly.

`metrics` has: `minTTC`, `minPathTTC`, `minDistance`, `requiredDecelMax`, `clippedCriticality`,
`collisions`, `triggerNeverFired`, `revealToConflict`, `declaredOcclusion`, `occluderIneffective`.

**`minDistance` is a circumscribed-circle broad-phase proxy and is NOT true clearance.** For a car
(r=2.58) and a pedestrian (r=0.42) it reports 0 m at 3.00 m of real separation. Compute true clearance
yourself from oriented bounding boxes using `x, y, headingRad` and the actor dims.
`minPET` is a *prediction* and is ~0 by construction for arrival-solved near misses. Do not trust it.

### An admitted example to copy the SHAPE of (not the content)
`/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/templates/expA-child-dartout-two-cars.template.json`
Note especially: a crossing VRU is bound `kind:"relative_to", ref:"ego"` with a `dsM` expression, and the
criticality comes from a **solver-owned `arrival` trigger** (`syncWith:"ego"`, `ttc:"param.arrivalTtc"`).

### Schemas worth knowing
`packages/scenario/src/schema/v2/interactions.ts` has a first-class
**`route` target `mode:"nearMiss"`** — a *re-solved, contact-free crossing intent* that stays valid when
the target route, speed or site changes. Prefer it over hand-rolled polylines.
`packages/engine/src/schema/input.ts` has the trigger union: `at`, `after`, `when` (with a mandatory
`byLatest` and `ifNever`), and `arrival` (with `syncWith` + exactly one of `ttc`/`deltaT`).

---

## 4. The frozen contract — you MUST obey this

Full text: `/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/agent-authoring/LANE-CONTRACT.md`

### 4.1 Briefs and split (frozen, do not modify)
The authoring unit is a **brief**: one sentence of natural language, e.g. *"A child runs into the road
from between two parked vehicles."*
- `/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/agent-authoring/brief-corpus.json` — tranche 1, **92 briefs**, split sha256 `dd4f360c16fd416f`,
  **DEV 32 / HELDOUT 60**.
- `/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/agent-authoring/brief-corpus-tranche2.json` — tranche 2, **116 briefs**, split sha256 `9327be880d9673a1`,
  **DEV 41 / HELDOUT 75**, weighted toward the categories that were empty.
- `/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/agent-authoring/brief-corpus-full.json` — all **208 briefs**, 15 categories.

**DEV may be used to develop the algorithm. HELDOUT is authored ONCE, through a surface frozen by hash,
with zero per-brief tuning.** Report the generalization gap (DEV admission rate minus HELDOUT).

### 4.2 The admission gate (pre-registered, sha256 `1a08698e95fca4bc`)
A brief is ADMITTED only if some trace satisfies **all** of:
- **C1** ego actually drives: `maxSpeedMps >= 2.0` AND `distanceTravelledM >= 10.0`
- **C2** closest approach is not a spawn artifact: it occurs at `t > warmupSeconds + 0.5`
- **C3** genuine proximity: **true OBB clearance <= 5.0 m** (never `minDistance`)
- **C4** genuine demand: ego `requiredDecelMax >= 1.5` OR `minTTC <= 3.0`
- **C5** `evaluate` verdict=accept AND band=critical AND zero collisions AND no never-fired trigger
- and across cells: **>= 2 maps AND >= 3 distinct sites**

**Never relax this gate to admit a scenario. Tightening is allowed; loosening is not.**
This gate exists because a blind judge rejected 27/52 traces the old pipeline called critical — inspection
showed `evaluate band="critical"` can be satisfied by spawn artifacts (minTTC=0 at t=0 with both actors
stationary) and by scenes with 16-32 m separation and zero required deceleration. After tightening,
blind-judge agreement went **0.481 -> 0.917**.

### 4.3 The portability rule (non-negotiable)
The emitted artifact is a **portable ScenarioTemplate v2**: logical anchor, no coordinates, no road IDs.
You may let the agent point at pixels, but the harness **MUST** project
pixel -> world -> `(lane rsl, s, tFrac)` -> logical anchor **before emitting**.
**Drawing is an input modality, not a coordinate emission.**
If you bake map coordinates into a template, you have failed the primary requirement no matter how good
the numbers look. `render.py:nearest_lane()` does this projection for you.

### 4.4 Rubrics
Each archetype gets an **intent rubric pre-registered by sha256 BEFORE authoring/tuning**, and is admitted
only by passing it. Never relax a rubric.

### 4.5 Resource budget
10 CPU cores. `uniscenarios batch` is CPU-bound node. Use <= 8 parallel workers; oversubscribing makes
everything slower, it does not help.

---

## 5. The baseline you are trying to beat

The blind tool-authoring lane, measured:

| metric | value |
|---|---|
| archetypes admitted (evidence-backed) | **29** of 92 briefs |
| taxonomy categories covered | 11 / 15 |
| DEV admission | 0.312 |
| HELDOUT admission | 0.317 |
| **generalization gap** | **-0.004** (no overfitting) |
| replay determinism | 156/156 bit-identical |
| blind judge: "is a critical edge case" | 0.828 |
| blind judge: category agreement | 0.517 |
| corpus-layout judge | **"inadequate", not fit for training data** |
| wall clock | ~35 s per brief |

**The generalization gap is already ~0. The bottleneck is the ABSOLUTE admission rate (~32%).**

Arithmetic that matters: from 208 briefs, 32% -> 66 archetypes; 45% -> 93; **55% -> 114**.
So reaching ~100 archetypes is a **rate** problem, not only a count problem. Roughly doubling admission
is the single most valuable thing you can do.

### Where the losses are (census over 819 traces, only 37.5% pass)
| cause | share | dominant in |
|---|---:|---|
| **C2 closest approach at spawn** | **29.3%** | C6 (58%), C14 (54%), C11 (50%), C8 (41%), C7 (40%) |
| C3 clearance > 5 m | 17.6% | C3.intersection (76%), C13.control (93%) |
| C1 ego never really drives | 11.0% | C11 (29%), C1 (24%) |
| C4 no deceleration demand | 4.6% | C15 (20%), C4 (33%) |

Best category is now **C5.pedestrian at 73.3% pass**, after two mechanism-level fixes. Worst are
C3.intersection and C13.control, which lose almost everything to loose clearance — the actors never
actually get near each other. C13 has no conflict mechanism at all: a signal phase change is not by
itself an encounter; it needs a second actor whose movement the phase provokes.

---

## 6. OPEN and UNRESOLVED: the placement-distance defect (D1)

**Do not treat this as settled. Two measurements disagree and it is the highest-value open question.**

Report: `/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/DEFECT-D1-relative-dsM.json`

A role declared `kind:"relative_to", ref:"ego", dsM:+G` should sit G metres ahead of the ego.
Measured at **trace t=0**, geometric forward projection onto the ego heading:
- direction is **always correct** (aheadFrac 1.00, 43/43) — **an earlier claim of a sign bug was FALSE
  and has been retracted**. It came from comparing lane stations `s` across actors, and **`s` restarts on
  each lane of a chain**, so a challenger on a successor lane looks "behind" when it is not.
- **distance is not honoured**: requested mean 18.1 m (range 9-30) produced actual mean 8.9 m
  (range 1.4-19.5), **correlation 0.16**. Actual values appear capped around 13.6 m.

Statistically linked to the dominant failure: C2 failures start a median **8.1 m** ahead, passing traces
**11.0 m** (Mann-Whitney p=0.0001). Fixing this should move admission materially.

**The disagreement:**
- A sub-agent measured the **instance** (materializer output, before simulation) on its own minimal
  2-role template and found placement **exact**: 20.7->20.6, 29.4->29.4, max error 0.4 m, correlation
  ~1.0. It concluded the gap is destroyed during the engine's **2 s warm-up** (unrecorded in the trace),
  and was heading into `packages/engine` to find it.
- I measured the instance on **my** template (built through the existing `ScenarioBuilder.place_actor`)
  and found placement already wrong: median error 10.9 m, correlation 0.06, capped near 13.6 m. Removing
  the extra role constraints (`requiredSameSegmentAs`, `requiredHeadingRelation`) did **not** help.

So it is either (i) warm-up dynamics, (ii) something the existing authoring surface emits, or (iii) both.
**Measure it yourself, at BOTH the instance level and trace t=0, and settle it.**

**A candidate cause I found by reading, and a patch I applied (UNVALIDATED — review it):**
`packages/compiler/src/materialize.ts`, `coverTarget()`. The chain-extension loop
**only ever prepended predecessors** (`[chosen.rsl, ...current]`) — it extends *backwards* only. A role
authored AHEAD of its reference projects past `route.lengthM` and `projectPoint` **clamps** there;
prepending predecessors can never reach it, so the realised gap collapses to whatever runway the chain
happened to have. That fits the evidence (direction right, distance compressed, uncorrelated with request)
better than a sign error did. The file's own comments at lines 665-680 document exactly this hazard for
the *backward* case and there is a `MAX_BACKWARD_STEPS` guard for it.

I made the extension **symmetric**: detect `projection.s >= route.lengthM - ENDPOINT_CLAMP_M` and append a
successor instead of prepending a predecessor, choosing by smallest turn angle. `npx tsc --noEmit` is
clean. **But placement was still capped at ~13.6 m in my probe afterwards, and the CLI uses `tsx` so the
edit WAS live.** So either the patch is insufficient, or the cause is elsewhere.
**Review this patch critically and revert it if it is not justified — I do not want an unvalidated engine
change sitting in the tree.** `git diff packages/compiler/src/materialize.ts`

---

## 7. Footguns that have already cost real time

1. **Traces are columnar and enormous.** Never print a whole tick/actor object.
2. **Lane `s` restarts per lane.** Never compare `s` across actors to decide "ahead/behind". Use geometric
   projection onto the ego's heading, or arc length along a single route.
3. **`minDistance` is a circle proxy, not clearance.** Compute OBB clearance yourself.
4. **`evaluate band="critical"` is not sufficient** — it accepts spawn artifacts and 30 m separations.
   That is why the physical gate exists.
5. **Write every run to a UNIQUE output dir** (`/tmp/<lane>-<attempt>-<briefId>`). A K-restart run reused
   `/tmp/toolrun-<briefId>` and overwrote its own evidence; 2 admitted archetypes had to be withdrawn.
   **Treat every existing `/tmp/toolrun-*` path as untrustworthy.**
6. **Preflight the API key** before any batch. A missing key once recorded 12 briefs as scenario failures
   when it was purely an environment fault.
7. **`catalogId` typos used to pass silently** — `vehicle.boxTruck` validated exit 0 and materialised as a
   sedan. Fixed at source (`isKnownPropCatalogId` in `scenario-materializer/src/prop-dims.ts`, 4 tests),
   but the CLI `template validate` is still not wired to it. Use exact catalog ids.
8. **`sites match --rejected` + `failureSummary`** is the fastest way to find why an anchor matches nothing.
9. `props.pose.tFrac` is clamped to [-1, 1] (ego lane edges), so the verge/sidewalk is not addressable for
   props. Known limitation.
10. Multi-lane junction approaches are rare on these maps (`throughLanesSameDir >= 2` fails at 157/210
    candidate sites). Do not design mechanisms that require them.

---

## 8. Your workspace and deliverables

Work in **`/Users/maikyon/Documents/Programming/UniScenarios/research/edge-case-corpus/tools/vista/`** inside the existing repo — do not fork the monorepo; you need its CLI, its
map assets and its engine. Keep your own code in that directory. `render.py` is already there.
If you change anything under `packages/`, it must be a **general** fix with a test, never a special case.

Deliver:
1. The harness: render -> place -> project -> template -> validate -> simulate -> re-render -> critic.
2. **Run on DEV first** (tranche 1 DEV = 32 briefs). Report `admitted/32` under the frozen gate, mean
   authoring iterations, and wall-clock per brief.
3. **Then freeze your surface by hash** and run HELDOUT once. Report the generalization gap.
4. `FINDINGS.md`: does sight beat blindness, with numbers, including specifically **how much of the 29.3%
   C2 loss the t=0 visual check recovers**.
5. The critic-agent result: how often the critic's verdict on the rendered rollout agrees with the gate.

**A negative result, measured honestly, is a real result.** If sight does not beat 29 admitted / 0.312 DEV
/ ~0 gap, say so plainly with the numbers. Do not relax the gate to manufacture a win — that is the exact
failure this project is built to avoid.

## 9. Working style
- Report incrementally, not at the end. Checkpoint findings to disk after each milestone.
- Prefer fixing a **mechanism** over fixing a scenario. Every worthwhile win in this project so far has
  been mechanism-level; per-scenario fixes are the anti-goal.
- Read metrics from the raw trace, never from a summary or verdict field.
- If you find a defect, produce a minimal reproduction and a failing test before fixing it.

---

## 10. YOUR ISOLATED WORKTREE — read this before touching anything

A dedicated git worktree has been set up for you. **Work there, not in the main checkout.**

```
WORKTREE : /Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista          <- yours, branch `vista-lane`
MAIN     : /Users/maikyon/Documents/Programming/UniScenarios   <- another agent is actively running batches here. DO NOT WRITE.
```

It is a real separate checkout sharing the same git history, so your `packages/` edits cannot affect the
other lane. That matters more than usual here: **the CLI runs TypeScript directly through `tsx` with no
build step**, so any edit under `packages/` is live in the *next* CLI call anywhere it is visible.

### What is already wired for you (verified working)
- `dev-assets` -> symlink to the shared 7.9 GB map store (read-only; do not copy or write).
  Verified: `node packages/cli/bin/uniscenarios.js maps list` returns all 5 maps from inside the worktree.
- `node_modules` -> symlinked from main (root + every package), so no install needed for the TS side.
- **Python venv at `/Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista/.venv`** with matplotlib, httpx, numpy, pillow.
  Use `/Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista/.venv/bin/python`. If you hit
  `ValueError: Key backend: 'module://matplotlib_inline...'`, do `os.environ.pop('MPLBACKEND', None)`
  before importing matplotlib, then `matplotlib.use("Agg")`.
- My uncommitted source fixes are copied in (`isKnownPropCatalogId` in
  `packages/compiler/src/prop-dims.ts` + tests; `trace/min-clearance.ts`,
  `trace/realized-pet.ts` + tests).
- `research/edge-case-corpus/` contains the frozen inputs: both brief corpora, the lane contract, the
  admission diagnosis, the D1 defect report, `ALGORITHM.md`, `render.py`, and the gold example template.

Verified end-to-end in the worktree: `render_site()` produced a PNG and `nearest_lane()` round-tripped the
view centre back to `{'rsl': '1:0:-2', 's': 40.24, 'tFrac': 0.0, 'distanceM': 0.0}` — exact.

### Rules that keep the two lanes from colliding
1. **Never write to `/Users/maikyon/Documents/Programming/UniScenarios`.** Read from it if you must; write only inside your worktree.
2. **Write run outputs to `/tmp/vista-<attempt>-<briefId>/`.** The other lane owns `/tmp/run*-<briefId>`
   and `/tmp/toolrun-*`. Never reuse a directory between attempts — a previous run overwrote its own
   evidence and two admitted archetypes had to be withdrawn.
3. **Write rubrics inside your worktree**, e.g. `research/edge-case-corpus/tools/vista/rubrics/`.
   The main checkout's `tools/` already holds 122 `<briefId>.rubric.json` files from the other lane and
   the brief IDs are identical, so writing there would silently clobber pre-registered rubrics — which
   would destroy the very thing requirement C protects.
4. **Cap yourself at 4-6 parallel `uniscenarios batch` workers.** 10 cores total, shared with the other
   lane; `batch` is CPU-bound node and oversubscribing slows both lanes.
5. **Commit on your branch** (`vista-lane`) whenever you want a checkpoint. Do not merge to `main`.
6. If you change anything under `packages/`, it must be a **general** fix with a test that fails first.
   Note the D1 patch I attempted in `coverTarget()` was wrong and has been **reverted** — the main tree is
   clean. Do not re-attempt it; the root cause is localised in section 6 to `framePoint()` clamping.
