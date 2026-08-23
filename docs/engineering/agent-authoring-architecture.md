# UniScenarios — agent-authoring architecture
> **Historical architecture:** Pre-rebrand package, CLI, and application names
> are retained verbatim below.


**Date:** 2026-07-31 · **Status:** APPROVED (Michael, 2026-07-31) — clip length
is parameterized (`clipSeconds`, default 20); actor/editor UX approved with a
"Premiere Pro / Blender-grade" interaction bar; full build ordered.
**Inputs:** [`../research/location-catalog.md`](../research/location-catalog.md),
[`../research/retargeting.md`](../research/retargeting.md), and
[`../research/interactions-and-edge-cases.md`](../research/interactions-and-edge-cases.md)
(read those for full detail; this doc is the synthesis and build contract).

## 0. What this enables, in one paragraph

Humans author scenarios visually in the 3D editor; LLM agents author the same
documents at scale through a CLI over a deterministic simulation engine. Both
speak the same language: a **scenario template** = logical anchor (predicate
over road structure — no road IDs, no coordinates) + a 20-second **timeline
choreography** (7 verbs, condition triggers, arrival solver) + parameters +
invariants. Templates match onto ranked concrete **sites** on any map, sample
into thousands of concrete **instances**, simulate deterministically, and pass
through criticality filters. Claude workflows orchestrate generation; the
validator and reject filters do the quality control the model can't.

## 1. The layer stack

```
┌────────────────────────────────────────────────────────────────┐
│ 5. GENERATION  Claude workflows: archetype → template → sites  │
│                → draws → simulate → filter → triage            │
├────────────────────────────────────────────────────────────────┤
│ 4. AGENT CLI   `uniscenarios` — query/author/bind/sample/sim/validate/ │
│                evaluate/render; JSON I/O; structured errors    │
├────────────────────────────────────────────────────────────────┤
│ 3. ENGINE      deterministic fixed-dt sim (headless == editor  │
│                preview), trace format, criticality metrics     │
├────────────────────────────────────────────────────────────────┤
│ 2. SCENARIO    template / site-binding / instance; anchor      │
│                matcher; timeline (7 verbs + triggers +         │
│                arrival solver); validator tiers 1+2            │
├────────────────────────────────────────────────────────────────┤
│ 1. MAP DATA    per-map artifacts + derived: location catalog   │
│                (locations.json), segments, junction            │
│                descriptors + conflictPairs, fact index         │
├────────────────────────────────────────────────────────────────┤
│ 0. EXISTING    topology index, lane polygons, signals, 3D      │
│                tiles, search index, enrichment overlay         │
└────────────────────────────────────────────────────────────────┘
```

The editor (apps/studio) sits beside layers 2–3: same document, same engine,
plus the viewport/timeline UI. Nothing in layers 1–5 imports three.js.

## 2. Layer 1 — map intelligence (`packages/map-intel`, new)

Per map, offline, one build step, cached by `sourceHashes`:

1. **Location catalog** (`locations.json`) per `docs/research/location-catalog.md`:
   adopt the ~700 search-index objects, anchor-lift them onto the lane graph
   (`rsl`, `s`, `headingRad`, quality), densify (parking spaces with entry poses,
   junction movements, 50 m midblock segments, school zones from MUTCD signs,
   driveways, work-zone-suitable segments, building entrances), assign
   content-stable ids + unique human/LLM **handles**
   (`junction/el-camino-real-at-cambridge-ave`).
2. **Derived topology** per `docs/research/retargeting.md`: Segments (maximal
   lane chains with piecewise profiles), JunctionDescriptors with
   **conflictPairs** (precomputed crossing points/angles between junction gates
   — the fact that makes conflict scenarios portable), FactIndex.

Types discipline (from observed failure modes): `LocationId`/`Handle` vs
display strings are distinct TS types; placement anchors (`rsl`) and display
references are not interchangeable anywhere in the API.

## 3. Layer 2 — the scenario document (`packages/scenario-model`, extend)

The shipped v1 schema (entities + reserved blocks) grows into the template
model — reserved blocks unseal in v2 exactly as designed:

```
ScenarioTemplate v2
  meta, params[], environment
  anchor: LogicalAnchor            // research/retargeting.md §LogicalAnchor
  roles: RoleBinding[]             // on_reference | lane_offset | opposing |
                                   // conflicting_gate | on_crossing |
                                   // in_parking_zone | relative_to
  props: PropPlacement[]           // L3: catalogId refs into prop-catalog,
                                   // frame-relative poses; occluders carry a
                                   // target reveal-to-conflict time
  choreography:
    clipSeconds: number            // param, default 20; warm-up t∈[-5,0) implicit
    interactions: Interaction[]    // {actor, trigger, verb, target, dynamics}
                                   // 7 verbs; one-axis-one-owner enforced by
                                   // schema validation; later preempts earlier
  invariants: Invariant[]          // headway | gap | ttc | arrival |
                                   // closing_speed | event_order | decel_budget
  variants?: []                    // author-defined degraded renditions
```

Pinned mode (`anchor.pin = {mapId, siteId}`) collapses the template to
"this exact place" for simple hand-authored scenarios — same document, one flag.
The matcher, solver, degradation reports, per-cell seeded variation, and replay
keys are all as specified in `docs/research/retargeting.md`. The validator
(tier 1 static / tier 2 kinematic) shares its `ClauseResult` shape with the
matcher so the UI and the CLI emit one unified quality report.

## 4. Layer 3 — the engine (`packages/sim-engine`, new)

- Fixed dt = 20 ms, pure TS, zero rendering deps. **The editor preview and the
  headless CLI run the same engine byte-for-byte** — no parity lane, ever.
- Per-actor controllers driven by the interaction list + behavior rules:
  lane-follow along topology polylines, IDM-lite gap keeping, kinematic
  lane-change/offset profiles, route walker (incl. crossing paths for peds),
  signal compliance from light programs, and the `rules.*` switches —
  `collisionAvoidance:false` makes a challenger actually commit.
- **Trigger evaluation + the arrival solver**: condition triggers evaluated per
  tick; `arrival(..., ttc)` back-solved at bind time (bisection on spawn s —
  monotone, deterministic) and re-verified in the run.
- Determinism contract: same instance → bit-identical trace on every platform
  (fixed iteration order, no wall clock, seeded per cell). Tested property, not
  aspiration.
- **Trace output** (`.trace.json`, gz): per-tick poses + speeds, trigger-fire
  events, per-pair min-distance/TTC series, and the derived episode metrics:
  minTTC + time-of-minTTC, required decel, reveal-to-conflict (raycast against
  prop/city occluders — coarse capsule/box set, not render meshes), invariant
  residuals, collision flags. The metrics block is what filters and evaluators
  consume; the pose block is what the editor scrubs and the renderer replays.

## 5. Layer 4 — the agent CLI (`packages/cli`, new; bin: `uniscenarios`)

JSON-in/JSON-out subcommands, exit codes meaningful, all errors structured
(`{code, path, reason}`) so unattended repair loops work:

```
uniscenarios maps list
uniscenarios locations find   --map <id> [--type --tags --near <handle> --within-m ...]
uniscenarios locations get    <handle|id> [--describe]      # NL paragraph for grounding
uniscenarios locations resolve "<free text>"                # fuzzy → ranked handles
uniscenarios template new    [--out --map --site]          # deterministic v2 skeleton
uniscenarios template validate <file>                       # schema + tier-1
uniscenarios sites match      <template> --map <id> [--all-maps --min-score]
uniscenarios instantiate      <template> --site <siteId> [--seed N | --draws K]
uniscenarios simulate         <instance|template+site> [--trace out.trace.json]
uniscenarios validate         <instance> [--tier 2]         # includes sim-backed checks
uniscenarios evaluate         <trace>    [--filters critical|negative-control]
uniscenarios evidence verify  <instance> <trace.json.gz>    # shared-input-hash proof
uniscenarios import           <file.xosc> [--map --out]     # OpenSCENARIO 1.4 → v2 draft
uniscenarios export           <instance> --format xosc-1.4|xosc-1.3-esmini|osc-2.2 --out f
uniscenarios render run       <render-intent> --engine browser|carla --inputs m --out dir/
uniscenarios render hash      <render-intent>               # canonical SHA-256 identity
uniscenarios batch            <template> --maps ... --draws N --out dir/   # the matrix
```

`uniscenarios locations`/`sites`/`simulate` are the LLM's spatial awareness: the model
never sees raw road IDs — it queries by semantics, receives handles + poses +
`matchedReasons`, and authors against handles and roles. Tool wrappers for MCP
come later; the CLI contract is the stable surface. Per-call result caps and
diversity clustering are server-side defaults, not model discipline.

## 6. Layer 5 — mass generation (Claude workflows)

Pipeline shape (each stage checkpointed to disk; every artifact carries its
replay key):

```
1. COVERAGE PLAN      pick archetypes × maps from the taxonomy (research/
                      interactions-and-edge-cases.md) minus what the library
                      already covers ("coverage ledger" = counts per archetype
                      × site class × criticality band)
2. TEMPLATE AUTHORING one agent per archetype family: emit LogicalAnchor +
                      choreography via constrained decoding against the
                      published JSON Schemas; `uniscenarios template validate` in a
                      repair loop (structured errors back to the model)
3. SITE MATCHING      `uniscenarios sites match --all-maps` (mechanical, no LLM)
4. SAMPLING           `uniscenarios batch` — per-cell seeds, Tier-1 axes from the
                      archetype's parameter table
5. SIM + FILTER       `uniscenarios simulate` + `uniscenarios evaluate`: drop trivially-safe
                      (unless tagged negative-control), physically-unavoidable,
                      never-fired, clipped-criticality instances
6. TRIAGE             agents review outliers + a sample per cell (traces, not
                      videos, for scale); promote to the library; update the
                      coverage ledger
```

Scale economics: one template ⇒ sites × draws ⇒ thousands of instances; LLM
cost is per *template*, sim cost is milliseconds per instance. The 1000-scenario
goal is a few dozen good templates, not a few thousand model calls.

## 7. Editor integration (apps/studio, after the viewer chain lands)

- Location catalog browser (search + handles + facts), site picker with scored/
  explained matches and degradation badges.
- Placement per the earlier actor-UX design (lane-snap ghosts etc. — pending
  Michael's proposal) writing `roles` + `props`, not raw poses.
- Timeline: chips at solved times, tethered condition chips, threshold-drag,
  Bake⇄Lift, whiskers over sampled draws; ego lane visually distinct,
  route-only by default.
- Occluder placement shows the live reveal-to-conflict readout.
- Scrub/playback = the same engine + trace.

## 8. Package map & build order

```
packages/map-intel        L1: catalog build + derived topology (+ conflictPairs)
packages/scenario-model   L2: template v2 schema, matcher, solver, validator
packages/sim-engine       L3: engine + trace + metrics
packages/cli              L4: uniscenarios
packages/prop-catalog     L3 props (in flight now)
workflows/                L5: generation scripts + coverage ledger
```

Build order (each step usable on its own):

| # | Step | Unblocks |
|---|---|---|
| A | map-intel: catalog + anchor-lift + conflictPairs (Yale first, then all 5) | everything |
| B | scenario-model v2: anchor/roles/choreography schemas + tier-1 validator | authoring + CLI |
| C | sim-engine v0: lane-follow + speed/gap/route verbs + time triggers + trace | preview, filters |
| D | matcher v0 (junction-anchored) + arrival solver + tier-2 validator | retargeting |
| E | CLI over A–D | agents |
| F | remaining verbs/conditions, degradation repairs, `uniscenarios batch` | scale generation |
| G | first workflow campaign (one archetype family, e.g. CPNCO dart-out) as the end-to-end proof | the 1000-scenario program |

A note on sequencing vs the render chain: A–E are renderer-independent and can
run as parallel lanes the same way the research did; only §7 waits on the
viewer/quality chain.

## 9. Open decisions for Michael

1. **20 s fixed vs `clipSeconds` param now** — doc assumes fixed 20 s with the
   warm-up prologue; making it a param later is a schema-compatible change.
2. **Ego semantics** — earlier call was "all actors equal." The engine treats
   whichever actor carries `role: "ego"`-like scoring focus as metric subject;
   fine either way, but §6 filters need *a* subject per instance. Proposal:
   a per-template `metricSubject: <role>` field, no other specialness.
3. **Actor UX** — your pending proposal shapes §7 placement; layers 1–6 don't
   depend on it.
4. **First campaign target** (§8 G) — suggest the occluded-pedestrian family
   (CPNCO + multiple-threat + bus-stop emergence): exercises props, occlusion
   metric, arrival solver, and VRU routing in one slice.
```
