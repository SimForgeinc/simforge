# `@simforge/maps`

Layer 1 of the SimForge stack: **per-map location intelligence**.

Turns the raw artifacts a map ships with into two derived files that everything
above — the anchor matcher, the sim engine, the `simforge` CLI, the editor's
location browser — reads instead of touching source data:

```
dev-assets/<map>/derived/locations.json.gz         the location catalog
dev-assets/<map>/derived/topology-derived.json.gz  segments + junctions + fact index
```

Nothing here imports three.js and nothing reads the network.

## Build

```bash
pnpm --filter @simforge/maps build:map -- --map yale-st-palo-alto-ca
pnpm --filter @simforge/maps build:map -- --all [--json]
```

Both artifacts carry the same `catalogRevision`, a hash over the *source
artifact* hashes. Unchanged sources ⇒ unchanged revision ⇒ no rebuild needed,
and any consumer that stamped an older revision knows to re-derive rather than
trust what it cached.

## What is in the catalog

A `StudioLocation` has a **three-part identity** and a **three-level anchor**:

| | | |
|---|---|---|
| `id` | `loc_<24 hex>` | content-derived from `mapId:type:identityKey`. Never positional. |
| `handle` | `junction/college-ave-at-yale-st` | unique per map, typeable, what agents address things by. |
| `name` | `Oxford Avenue @ West El Camino Real` | display only, **not** unique. |

| anchor level | field | use |
|---|---|---|
| geographic | `anchor.geo` | maps, Overture joins |
| scene | `anchor.scene` | the y-up glTF frame, with sampled ground height |
| **road network** | `anchor.road` | `{rsl, s, offsetM, headingRad, laneType, junctionId?, gateId?}` — what makes a location *placeable* |

Plus `affordances`, flat `facts`, `tags`, multi-source `provenance`, and a
`quality.anchor` band (`exact` ≤ 2 m, `projected` ≤ 25 m, `inferred` ≤ 150 m,
else `unanchored`).

Sources are adopted (~700 search-index objects per map) and then densified with
the things nothing downstream ever exposed: one record per **junction
movement**, individual **parking bays** with entry poses, a **50 m midblock
stride** along every corridor, MUTCD-derived **school zones**,
**work-zone-suitable** points, and **building entrances** from Overture address
road-snaps.

## What is in the derived topology

- **`Segment`** — a maximal same-direction driving corridor with a piecewise
  profile (lane counts both directions, speed, width, curvature per 10 m),
  adjacency flags, lane-change intervals, and the junctions it passes through.
- **`JunctionDescriptor`** — arms, approaches with bearings and turn options,
  control derived from the signal layer, size, and **`conflictPairs`**: for
  every pair of movements whose paths cross, the crossing point, the arc length
  along each path, the crossing angle, and the relation
  (`opposing` / `from_left` / `from_right` / `same_dir_merge`).
- **`FactIndex`** — inverted maps for selectivity-ordered candidate generation.

## Query API

```ts
import { buildMapIntelFromDir, findLocations, describeLocation } from '@simforge/maps';

const { catalog, derived } = await buildMapIntelFromDir('dev-assets/yale-st-palo-alto-ca');

const unprotectedLefts = findLocations(catalog, {
  type: 'junction_movement',
  facts: { allOf: [
    { key: 'turn_relation', op: 'eq', value: 'Left' },
    { key: 'is_protected',  op: 'eq', value: false },
  ]},
  near: { id: 'junction/college-ave-at-yale-st', withinM: 400 },
  diversityRadiusM: 40,
  limit: 10,
}, { index: derived.factIndex });

describeLocation(catalog, unprotectedLefts[0]!.location.handle);
resolveReference(catalog, 'the intersection by the school');
```

Structured-only by design — there is no free-text spatial field. Prose goes
through `resolveReference`, which returns handles; the model then queries with
those.

## Design rules this package enforces

1. **Content-derived ids.** An id never encodes a position in an array. The
   search index's `street:<n>` *is* positional, so streets are re-keyed on their
   sorted lane set.
2. **Branded types.** `LaneRef` / `LocationId` / `Handle` are nominal types;
   a display string cannot reach a placement position without an explicit,
   validating cast.
3. **Declared facts must be produced.** A fact key declared in
   `DECLARED_FACT_KEYS` and written by no derivation fails the build. (The prior
   system declared `is_t_intersection`, aliased it in three query paths, and
   wrote it from zero — every query on it silently returned nothing.)
4. **Determinism.** Every fan-out is sorted with a locale-independent
   comparator, no wall clock reaches an artifact, and the build is a pure
   function of the loaded sources. Tested: rebuild ⇒ byte-identical; permute the
   input order ⇒ byte-identical.
5. **Errors, not empty results.** Filtering on an unknown fact key throws with
   the available vocabulary attached.

## What the real data does *not* match the research docs on

Findings from building all five dev maps, kept here because they change how the
derived types should be read:

- **Non-junction chains are degenerate.** 363 of Yale's 622 driving lanes are
  junction-internal, and 251 of its 259 non-junction driving lanes have *no*
  non-junction successor: every road stub is bounded by junction lanes. A
  literal "maximal non-junction chain" is one ~25 m stub. Segments therefore
  continue through the unambiguous **straight-through** movement and record the
  junctions traversed in `junctionIntervals`.
- **Polylines are in OpenDRIVE `s` order, and positive-id lanes travel against
  `s`.** 225 of Yale's 234 positive-id approach lanes have the junction at their
  polyline *start*, and 198 of 239 positive-id connecting lanes run
  exit-to-approach. Consumed raw this is catastrophic and silent: junction 134
  reported **zero** `opposing` conflict pairs against a geometric truth of 18,
  which makes every left-turn-across-oncoming template unbindable there.
  `LaneGraph` reverses those polylines at construction and settles junction
  connecting lanes against their gate (the sign rule alone is wrong for 41 of
  them), so **every `s` in this package is travel-ordered arc length**, not
  OpenDRIVE `s` — convert with `LaneGraph.toXodrS`. The same flip is applied to
  lane-change permission intervals and their `left`/`right` sides.
- **`predecessors`/`successors` are not travel-directed.** Lanes routinely list
  the same neighbour in both arrays and list lanes nowhere near their endpoints.
  Every chain link here is verified geometrically (endpoint within 1.5 m,
  heading continuous, unambiguous in both directions).
- **Junction arms must be clustered by outward leg direction.** On a 70 m
  junction the inbound and outbound centrelines of one leg sit ~15 m apart, so
  clustering bearings around the centroid splits it in two and Yale's El Camino
  junctions come out as 6-7 "arms". Clustering outward leg bearings (40° gap,
  wrap-aware) puts every junction on all five maps at ≤ 5 arms.
- **`adjacentLanes` only reports drivable neighbours.** Lane `-2`'s left is
  `null` even when shoulder `-1` exists, so parking/bike/sidewalk adjacency is
  reconstructed from the `road:section` lane row.
- **School signage exists on one map of five.** Only
  `easterbrook-discovery-school` has MUTCD S-series signs, so school-zone facts
  are `conditional`. A `school_frontage` in the search index is *not* a zone.
- **The 80 m work-zone junction clearance is severe here.** As a *run*
  constraint it is unsatisfiable on all five maps (longest clear run: 30 m on
  Yale, zero elsewhere). It is applied as the point constraint the doc states.
- **Search-index `control_type` disagrees with the signals.** It keys off
  approach count and labels signalized junctions "uncontrolled". Control is
  derived from the signal layer; the search index's answer is kept in
  `controlEvidence`.
- **Three Yale driving lanes have no width at all** (`representativeWidthM:
  null`, empty `widthSamples`). Reported as `0` rather than back-filled.

## Layout

```
src/types/      branded ids, catalog + derived-topology + source-artifact types
src/geometry/   2D primitives, the indexed LaneGraph, the elevation field
src/build/      the 7-step recipe: sources → context → adopt → segments →
                junctions → densify → handles → relations → index → audit
src/query/      findLocations / getLocation / describeLocation / resolveReference
src/cli/        build:map
scripts/        extract-fixture.ts (regenerates the committed test fixture)
```
