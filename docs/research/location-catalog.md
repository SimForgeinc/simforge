# Research: location intelligence → the Studio location catalog
> **Historical research record:** Pre-consolidation package names are retained
> verbatim below.


Condensed from the 2026-07-31 SimCloud location-intelligence investigation.
Scope note: SimCloud's lane/location intelligence was cleared for reuse as
*data and design reference*; its authoring/scenario-generation code is off-limits.

## What exists per map, on S3, consumable directly (no DB)

Under `s3://simforge-assets-dev/maps/<mapAssetId>/`:

| Artifact | Contents | Use |
|---|---|---|
| `<id>.search-index.json` (gz) | **~700 typed catalog objects + ~392 graph edges** per map: junctions (with control type, approach count, spawn affordances), streets (lane counts, speed/grade/curvature/width classes), street parking, parking lots, occlusion zones (with `scenario_tags` like `PEDESTRIAN_DARTOUT` and `supported_scenario_templates`), crosswalk zones, bus stops, school/hospital/retail frontages, 326 addresses. Facts are FLAT primitives only (design law worth keeping). | **This is ~80% of our location catalog for free. Parse it, don't rebuild it.** |
| `<id>.topology-index.json` (gz) | Lane graph: `rsl` = `road:section:lane` keys, predecessors/successors, `adjacentLanes`, `laneChangePermissions`, speed limits, width samples, **per-lane polylines (~1 m sampling)**; gates (`turnRelation`, `headingChangeRad`, approach/connecting/exit lanes); junctions. Yale: 1,141 lanes / 537 gates / 56 junctions. | The spatial spine. Polylines are in xodr-local meters = scene frame with `scene_z = −xodr_y` (verified). Lane snap needs NO raycasting. |
| `<id>.geojson` (gz) | RoadRunner export incl. **`Type=ParkingSpace` polygons with `EntryPosition` per bay** (639 on Yale) | Individual spawnable parking spaces with entry poses |
| `<id>.signals.geojson` (gz) | Signals/signs with `road_id, s, t`, MUTCD codes incl. school-zone signs (S1-1/S3-1/S4-*P/S5-2) | Signal semantics; school-zone derivation |
| `enrichment/overlay-payload.json` | 15 Overture layers: buildings, addresses (with `road_access_lat/lng/distance_m/road_name` snapped to drivable roads — 3,241/3,243 coverage), POIs, crosswalk fills | Names, addresses, building entrances |
| `<id>_rrdata.xml` | Signal phase timing (Yale: 17 phases / 5 junctions) | Light programs |

All 12 maps have search/topology/xodr/geojson; 5 have 3D.

## The catalog design (deltas from SimCloud, learned from its defects)

**Three-part identity** (SimCloud conflates name with identity — 653 junctions
share the literal label "Junction with 3 approaches: T-yield, uncontrolled."):

- `id` — content-derived: `loc_<sha256(mapId:type:identityKey).slice(24)>`, where
  identityKey = xodr junction id | `rsl@round(s)` | RoadRunner GUID | overture id.
  NEVER positional/index-derived (SimCloud's in-house detectors renumber on any
  threshold tweak; only its Overture path got this right).
- `name` — human-readable, not unique.
- `handle` — unique, typeable, LLM-friendly: `junction/el-camino-real-at-cambridge-ave`.
  Disambiguation ladder: cross-street → nearest address ("behind-550-oxford-ave";
  3,243 road-snapped addresses are the highest-leverage unused disambiguator) →
  cardinal offset ("north-of-stanford-ave") → ordinal ("junction-3-of-8").

**Three-level anchor on every location** — geographic (lngLat), scene (x,y,z),
and **road-network (`rsl`, `s`, `laneType`, `headingRad`, junction/gate ids)**.
The road anchor is the step SimCloud never took (its candidates are lat/lng-only,
which made half its junctions searchable but not draftable). Derive by
nearest-lane query against topology polylines ("anchor-lift"), with
`quality: exact|projected|inferred`.

**Plus:** `affordances` (vehicleSpawn/pedestrianSpawn/parkedVehicle/occluder/...),
flat `facts`, `relations` with `bearingDeg` (SimCloud has no directional
vocabulary at all — its `upstream_of` silently equals `connected_to`), multi-source
provenance with confidence, and `catalogRevision` = hash over input artifact hashes.

**Type taxonomy** (modeled on SimCloud's semantic feature graph, its best layer,
extended with what it never derived): junctions (subtyped by control),
junction_movement (per gate), driving/bike/walking corridors,
**midblock_segment (50 m stride — xodr roads average ~13 m)**, merge_zone,
lane_drop, parking_lane/space/area/access_point, **driveway**, loading_zone,
bus_stop, crosswalk, sidewalk, curb, median, refuge_island, **building_entrance**
(from address road-snaps), **school_zone** (MUTCD sign projection),
**work_zone_suitable** (straight+flat+multilane+shoulder+no junction within 80 m),
occlusion_zone (6 subtypes — SimCloud's detectors are pure functions over xodr,
port the math), conflict_zone, poi_frontage.

## Build recipe (per map, offline, → `locations.json` next to other artifacts)

1. Load topology-index → lane graph + R-tree over polylines (the spine).
2. Load search-index → adopt its ~700 objects (ids, names, facts, tags, graph).
3. **Anchor-lift**: nearest-lane join per object → road anchor + heading + quality.
4. Densify from raw artifacts: parking spaces (EntryPosition), junction movements
   (gates), midblock segments, school zones (signals MUTCD), driveways
   (parking-lane run discontinuities + short junction stubs), work-zone-suitable
   segments, building entrances (address road-snaps).
5. Names + handles via the disambiguation ladder (uniqueness-checked per map).
6. Relations: adopt search-index edges + add bearingDeg + contains/crosses.
7. Emit `locations.json` `{catalogVersion, mapId, sourceHashes, locations[], relations[]}` (~300–500 KB gz).

## LLM tool surface (copy SimCloud's good parts, fix its confirmed defects)

Copy: structured-only queries (no free-text spatial reasoning by the model),
closed vocab injected into schema descriptions from one constant, per-call caps
with actionable errors, `matchedReasons[]` explainability, diversity clustering.

Fix: (1) return the subject's own coordinates/pose inline (SimCloud drops them);
(2) real directional relations from predecessors/successors/gates;
(3) `anyOf`/`allOf` in filters; (4) no authorability cliff — anchor-lift makes
everything placeable; (5) build-time assertion that every declared fact key is
actually produced (SimCloud's `is_t_intersection` is declared, aliased, and
written by zero code paths).

Tools: `find_locations`, `get_location`, `describe_location`,
`resolve_reference` (fuzzy NL → ranked handles — closes the "intersection by the
school" loop).
