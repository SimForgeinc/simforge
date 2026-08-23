# Research: retargetable scenarios (logical anchors + site matching)
> **Historical research record:** Pre-consolidation package names are retained
> verbatim below.


Condensed from the 2026-07-31 first-principles + prior-art investigation
(Scenic, OpenSCENARIO 1.x/2.x, PEGASUS, RoadRunner Scenario, CommonRoad).
SimCloud's scenario/authoring systems were explicitly NOT studied (banned scope).

## Thesis

A scenario is a **choreography expressed in a road-relative frame** plus a
**logical anchor** — a predicate over road structure. Retargeting = re-running
the anchor matcher on a new map and re-projecting the choreography. `.xosc` and
world-space trajectories are derived artifacts, cached, never authoritative.

## Prior-art verdicts

- **Scenic**: right semantics (scenarios name predicates over the network —
  `is4Way and not isSignalized` — never roads; `conflictingManeuvers` is the
  killer derived fact) but rejection sampling is wrong for an editor → we do
  scored enumeration instead.
- **OSC 2.x**: right vocabulary (abstract road network as search space,
  relational positions `position(10m, behind: npc)`, `keep()` constraints,
  `routes_overlap`) but spec-with-thin-tooling.
- **OSC 1.x**: export format only — `LanePosition(roadId,…)` is per-map by
  construction. Emit `RelativeLanePosition` where possible + provenance block.
- **PEGASUS**: functional→logical→concrete ladder; the L1/L2-vs-L4 layer split is
  the retargeting seam — keep `anchor` and `choreography` structurally separate.
- **RoadRunner**: named anchors = manual pinning; offer as escape hatch
  (`anchor.pin`), never the primary mechanism.
- **Nobody ships a good interactive authoring experience for this** (Foretellix
  is the closed commercial embodiment). Genuine gap.

## Document model — three tiers, one authored file

```
ScenarioTemplate (authored, portable, no map)
  anchor: LogicalAnchor        ← predicate over road structure (L1+L2)
  roles: RoleBinding[]         ← how actors attach to matched structure
  choreography: Choreography   ← timeline, frame-relative (L4)
  environment, params, invariants
SiteBinding      (derived: anchor × map → ranked sites; cached, stamped)
ScenarioInstance (derived: template × site × param draw; → .xosc)
```

Stamps: `{mapId, topologyDigest, matcherVersion, solverVersion, paramSeed}` —
mismatch ⇒ re-derive, never trust. Re-match with a visible diff on digest
change; never silently re-bind.

## AnchorFrame — the coordinate system

Established by the matcher, identical shape on every map: `referencePath`
(ordered lane chain incl. junction-internal lanes), arc length `s` from a named
`origin` feature (junction entry / stop line / crossing), signed same-direction
lane index `k` (lateral), `handedness` + `mirrored`. Every pose is
`(k, s, tFrac, headingOffsetRad)` — **`tFrac` = lateral offset as a fraction of
local lane width** (absolute meters don't transfer between 2.7 m and 3.9 m lanes).

## LogicalAnchor — LLM-emittable predicate

Flat, enum-heavy, ranges as `[min,max]`, every clause
`{value, essentiality: required|preferred|cosmetic, weight?}`:

- `corridor`: throughLanesSameDir/Opposing, laneWidthM, speedLimitKph,
  **runwayUpstreamM / runwayDownstreamM** (the "enough room" clauses),
  curvatureDegPer10m, gradePct, requires/forbidsAdjacent (parking/bike/sidewalk…),
  laneChangeLegal{side, sRange}.
- `features[]`: ordered `{id, kind: junction|crossing|merge|parking_zone|…,
  atM: Range, side}` with kind-specific predicates — junction: arms, control,
  egoTurn, **conflictingApproach{from, turn}**, sizeM, hasCrossingOnLeg.
- `policy`: allowMirror, maxSitesPerMap, diversity, minScore.
- `pin?`: {mapId, siteId} escape hatch.

No coordinates, no road ids expressible → an LLM cannot hallucinate them.

## Derived per-map indexes (build in xodr-tools at catalog time)

- **Segment**: maximal lane chains with piecewise profiles over s (lane counts,
  speed, width, curvature), adjacency flags, laneChangeIntervals, entry/exit junctions.
- **JunctionDescriptor**: arms, approaches with bearings + turn options, control
  (from signals), size, crossings, and **conflictPairs** — for every pair of
  gates whose connecting-lane centerlines cross: crossing point, s-on-each,
  crossing angle, relation (opposing/from_left/from_right/merge). O(gates²)
  segment intersection, ~500 gates/map, trivial cost, **the single
  highest-value derived fact** (Scenic's conflictingManeuvers).
- **FactIndex**: inverted maps (laneCount→segments, junction class→junctions…)
  for selectivity-ordered candidate generation. Linear scan is already fast at
  this scale — no R-trees/graph DBs for matching.

## Matcher (anchor × map → ranked MatchedSite[])

Selectivity-ordered candidate generation (rarest clause first, usually junction
class) → frame construction (walk predecessors/successors preferring straightest
continuation; genuine ambiguity ⇒ emit both candidates) → clause evaluation
(worst value over the s-interval, not mean) → aggregate score (required =
pass/fail; preferred/cosmetic weighted) → diversity dedup (best per junction /
road-direction; "which lane" is a parameter, not 3 sites) → stable sort by
(-score, siteId).

Scoring: `scoreRange` linear falloff over a tolerance band (defaults: distance
25% of range width min 10 m, speed 10 kph, width 0.4 m); `scoreSet` via a
near-miss table (all_way_stop↔signalized 0.6, minor_stop↔yield 0.85, 4way↔3way
0.4). Every ClauseResult carries required/actual/score/slack → full
explainability in UI and provenance.

**Determinism rules:** sort at every fan-out (never Map/object iteration order);
`siteId = sha256(anchorId + matchSemanticsVersion + mapId + topologyDigest +
originFeatureId + entryLaneRsl + quantize(s, 0.5m))` — deliberately excludes
soft clauses/weights so preference tuning doesn't orphan bindings; matcher is a
pure function of (anchor, derivedIndex).

## Role bindings & invariants (what transfers vs what re-derives)

Role kinds: `on_reference`, `lane_offset(k, onMissing: clamp|drop|fail)`,
`opposing`, **`conflicting_gate(feature, from, turn, arriveAtConflict{relativeTo,
deltaT})`** — placed by backing up from the precomputed conflict point, ranked by
crossing-angle closeness (keeps a T-bone a T-bone) — `on_crossing(startFrac)`,
`in_parking_zone`, `relative_to(ref, dLane, dsM)`.

**Preserved (re-solved to hold):** headways/gaps, TTC at triggers, arrival-time
offset at conflict, closing-speed band, event order, decel budget, relative lane
topology. **Re-derived (never stored as truth):** absolute transforms, actual
s/rsl values, route polylines, junction geometry, crossing lengths, absolute
speeds.

**Speeds are expressions, not literals** — `clamp(0.9 * lane.speedLimitKph, 25, 65)`
via a small typed AST evaluator (no eval). Longitudinal solve: routes as graph
walks → conflict points from conflictPairs → **bisection on spawn s** (monotone,
deterministic) for arrival invariants → closed-form gap/headway offsets →
feasibility guards: upstream run-up available, **forward runway ≥ v·clipDuration
over the WHOLE clip** (geometrically-verified successor adjacency), decel ≤
budget (5.5 comfort / 8.0 hard m/s²), spawn footprints disjoint (real dims).

## Degradation semantics

**Rule: degradation may relax presentation, never intent.** Repairs in order:
speed-clamp/runway-shorten (preserve the arrival invariant over the speed
parameter) → feature-distance relax within tolerance → lane-offset clamp
(non-required roles) → junction-class substitute (near-miss table, preferred
only) → actor drop (cosmetic only) → else `infeasible`. Every site returns a
DegradationReport {verdict, repairs, failedRequiredClauses, plain-language
summary, intentPreserved} — surfaced in the site picker, the exported .xosc
provenance block, and batch manifests. A signal-trigger with no signal to bind
to at a substituted junction is a separate required failure (trigger binding is
part of role binding).

Template `variants` (e.g. "when 2-lane: overrides…") let the AUTHOR define the
degraded rendition — that's authoring, not repair.

## Variation

`variationMatrix = sites(anchor, maps) × draws(params, n)`, with **per-cell
seeding**: `seed = hash(templateId|paramsVersion|siteId|drawIndex)` — never a
shared RNG stream (adding a map/site/param must not shift existing cells).
Full-factorial for small discrete spaces; Halton/LHS for continuous. Every
instance carries a replay key (template+version, map+digest, site, matcher+solver
versions, seed, drawIndex) that must reproduce it bit-exactly — testable.

## Validator (pure TS, no simulator)

Tier 1 on every edit (<5 ms): role_unbound, route_disconnected,
illegal_lane_change (vs laneChangePermissions), wrong_lane_type, wrong_way,
spawn_overlap (OBBs, real dims), spawn_off_lane, **runway_insufficient (whole
clip)**, dead_end_ahead, speed_over_limit, trigger_unbindable,
param_constraint_violated. Tier 2 on save (one coarse pass of the preview
engine): invariant_violated, conflict_missed/unintended, decel/jerk_exceeded,
trigger_never_fires, event order, maneuver_incomplete, actor_despawn. Validator
checks and anchor clauses share the ClauseResult shape → one unified quality
report.

## Pitfalls to design against (structural, from observed failure modes)

1. Two map representations distinguished only by docs → make display ids and
   placement ids different TS types.
2. Shared RNG stream position → per-cell seeding (above).
3. Actors running off the road because runway was only checked for the labelled
   window, and "successors" that aren't physically contiguous → whole-clip
   runway + geometric adjacency verification.
4. Silent asset substitution (an occluder becoming a sedan deletes the point of
   the scenario) → resolve assets against the catalog at author time, fail loud.
