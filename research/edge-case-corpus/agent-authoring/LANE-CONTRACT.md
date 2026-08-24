# Shared contract for BOTH research lanes

Two lanes now run in parallel against the SAME repo:
- **Lane 1 (blind tool authoring)** — the existing `ScenarioBuilder` surface: the agent emits JSON tool
  calls and never sees the road.
- **Lane 2 (VISTA-style visual harness)** — the agent SEES a top-down PNG of the site and authors by
  looking, inspecting and adjusting.

They are only worth running in parallel if they are **comparable**. So the following are FROZEN and
SHARED. Neither lane may modify them.

## 1. The briefs and the split (frozen)
`/Users/maikyon/Documents/Programming/SimForge/research/edge-case-corpus/agent-authoring/brief-corpus.json` — 92 briefs, all 15 taxonomy categories.
Split sha256 `dd4f360c16fd416f` — **DEV 32 / HELDOUT 60**.
A lane may develop against DEV. HELDOUT is authored once, through a hash-frozen surface.

## 2. The admission gate (frozen, pre-registered sha256 `1a08698e95fca4bc`)
A brief is ADMITTED only if some trace satisfies ALL of:
- C1 ego actually drives: `maxSpeedMps >= 2.0` and `distanceTravelledM >= 10.0`
- C2 closest approach is not a spawn artifact: it occurs at `t > warmupSeconds + 0.5`
- C3 genuine proximity: **true oriented-bounding-box clearance <= 5.0 m**
  (the engine's `minDistance` is a circumscribed-circle proxy and MUST NOT be used)
- C4 genuine demand: ego `requiredDecelMax >= 1.5` OR `minTTC <= 3.0`
- C5 `evaluate` verdict=accept AND band=critical AND zero collisions AND no never-fired trigger
- and across cells: **>= 2 maps AND >= 3 distinct sites**

Never relax this gate to admit a scenario. Tightening is allowed; loosening is not.

## 3. The portability rule (non-negotiable, both lanes)
The emitted artifact is a **portable ScenarioTemplate v2**: a logical anchor, no coordinates, no road IDs.
Lane 2 may let the agent point at pixels, but the harness MUST project pixel -> `(lane rsl, s, tFrac)` ->
logical anchor before emitting. **Drawing is an input modality, not a coordinate emission.**
If lane 2 bakes map coordinates into the template, it has failed requirement A regardless of its numbers.

## 4. The head-to-head
Same 92 briefs, same gate, same held-out split. Report:
`admitted/92`, `DEV rate`, `HELDOUT rate`, `generalization gap`, `mean authoring iterations`,
`wall-clock per brief`, and blind-judge agreement.
Lane 1 baseline to beat: **29-31 admitted, DEV 0.312 / HELD 0.317, gap ~0.00, judge 0.83, ~35 s/brief.**

## 5. Resource budget (10 CPU cores total)
Lane 1: <= 8 parallel `simforge batch` workers. Lane 2: <= 4 while its loop is being built.
`simforge batch` is CPU-bound node; oversubscribing makes BOTH lanes slower.

## 6. Evidence hygiene (learned the hard way)
Write every run to a UNIQUE output dir (`/tmp/<lane>-<attempt>-<briefId>`). An earlier K-restart run
overwrote its own evidence and 2 admitted archetypes had to be withdrawn.
Set `OPENAI_API_KEY` before any run and preflight-check it: a missing key once recorded 12 briefs as
scenario failures when it was an environment fault.
