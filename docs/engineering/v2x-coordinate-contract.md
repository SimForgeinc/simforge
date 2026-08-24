# V2X Coordinate Contract — Richmond Field Station

Status: **V5 MapParity deliverable**, 2026-08-22. Branch `v2x-map-parity`.
Golden fixtures:
[`fixtures/v2x-richmond-golden-projections.json`](../../fixtures/v2x-richmond-golden-projections.json).
Executable round-trip tests:
`packages/maps/src/__tests__/v2x-golden-projections.test.ts`.
Lineage evidence:
[`research/v2x/map-lineage-diff.py`](../../research/v2x/map-lineage-diff.py) +
`research/v2x/map-lineage-diff-report.json`.

## 1. The three frames

| Frame | Units / axes | Defined by | Used by |
|---|---|---|---|
| **WGS-84** | degrees, `[lat, lon]` | EPSG:4326 | detection HTTP API, trajectories, cameras.json site, zones (as `[lon, lat]` pairs) |
| **xodr-local** | metres, x-east / y-north / z-up | the XODR `<geoReference>` PROJ string | all SimForge map assets, topology index, engine, scene frame |
| **legacy flat-earth** ("CARLA world") | metres, x-east / **y = negated northing** (UE4 left-handed) | `geo_utils.py` CARLA 0.10 path — an equirectangular approximation around the map origin, *not* strict tmerc | every calibrated artifact of the deployed twin: camera poses, zone placement, trajectory playback, detection mirroring |

Richmond georeference (identical in both lineages):

```
+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857
            +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs
```

Because `x_0=y_0=0` and `k=1`, the tmerc natural origin coincides with the
CARLA world origin: the two metric frames share `(0, 0)` exactly.

## 2. Formulas

### WGS-84 ↔ xodr-local (strict)

proj4/EPSG:4326 forward/inverse with the PROJ string above.
Implementation: `CoordinateFrame.wgs84ToLocal` / `localToWgs84`
(`@simforge/maps/opendrive`). Round-trip error is at machine precision.

### WGS-84 ↔ legacy flat-earth

From `digital_twin_bridge/geo_utils.py` (`gps_to_carla`, CARLA 0.10 branch),
pinned verbatim:

```
x =  (lon − lon0) · 111320 · cos(lat0)
y = −(lat − lat0) · 111320            ← Y NEGATED (UE4 left-handed)
inverse: lat = lat0 − y / 111320 ; lon = lon0 + x / (111320·cos(lat0))
```

with `lat0 = 37.9150891287087`, `lon0 = −122.333308830857`.
Implementation: `LegacyFlatEarthFrame` (`@simforge/maps/opendrive`,
`src/opendrive/legacy-flat-earth.ts`). Round-trip is algebraically exact.

### legacy flat-earth ↔ xodr-local

`(x_local, y_local) = (x_fe, −y_fe)` up to the equirectangular vs tmerc
divergence, which is **not zero**: it grows from 0 at the origin to ≈0.23 m at
the camera pole and ≈0.95 m at the NE corner of the site (see
`crossFrameDeltaMeters` per fixture point). Cause: `111320 m/deg` and the
origin-frozen `cos(lat0)` are approximations of the meridian scale at this
latitude (~110 995 m/deg true) and of the varying parallel scale.

**Rule:** artifacts authored by the deployed twin live in the legacy frame;
artifacts derived from map assets live in xodr-local. Convert explicitly via
WGS-84; never mix frames inside one consumer without a recorded conversion.

## 3. Digest rule (map identity)

Every V2X-facing artifact MUST carry `{mapId, xodrSha256}` and consumers MUST
refuse mismatched digests:

```json
{ "mapId": "richmond-field-station", "xodrSha256": "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643" }
```

The repo already enforces this pair for XODR/topology loads
(`packages/cli` xml14 suite audit). Lineages are NOT interchangeable even
when `mapId` matches — see §5.

## 4. Calibration dependency inventory (deployed twin, READ-ONLY sources)

| Artifact | Location | Encodes | Projection consumed via |
|---|---|---|---|
| Twin camera poses (×4 channels, shared pole) | `/home/path/V2XCarla/v2x-backend/config/cameras.json` (`site.lat/lon` 37.91560117034595, −122.33478756387032; per-channel `height_m`, `pitch_deg`, `yaw_deg`, `twin_pose` offsets) | pole position in WGS-84; orientation relative to a site survey frame (`frame_heading_deg` 226.3°, provisional joint fit, mean landmark residual 1.09 m) | `gps_to_carla` → **legacy flat-earth**, z snapped to road surface then raised by height |
| Landmark calibration fit | `apps/perception/calibration/ch*_calibration_errors.csv`, `docs/twin-projection-model.md` | surveyed landmarks scored against road centrelines | fitted against the **deployed lineage's** centreline geometry (0737f3d9) |
| User zones / geofences | runtime-authored, `[lon, lat]` polygons over WS (`sync_v2x_zones`) | polygon vertices in WGS-84 | `gps_to_carla` → legacy flat-earth (ephemeral; frontend redraws) |
| GPS trajectory playback | `apps/bridge/trajectories/*.json` (`[{t, lat, lon}]`) | waypoints in WGS-84 | `gps_to_carla` → legacy flat-earth |
| Live/historical detections | production HTTP API (`gps_location.lat/lon`) | actor positions in WGS-84 | `gps_to_carla` → legacy flat-earth |
| Spawn points | exported at runtime from CARLA (`world_state.py`) | map-frame metres | n/a (runtime-derived, not calibrated) |
| Intrinsics/distortion | `cameras.json` per channel | pixel space only | frame-independent |

Consequence: **every calibrated or geo-authored artifact flows through the
legacy flat-earth transform**, and their geometry ground truth is the
deployed lineage.

## 5. Lineage decision

Measured structural diff (full numbers in `research/v2x/map-lineage-diff-report.json`):

- Same georeference, same vendor; exports 2026‑04‑09 (Uni) vs 2026‑06‑11 (deployed).
- Deployed: 208 roads / 32 junctions / 35 signals / 589 objects; extents west −258.84, south −139.18.
- Uni: 206 roads / 31 junctions / 39 signals / 590 objects; extents west −219.23, south −131.43 → **the deployed revision extends ~40 m further west and ~8 m further south** (the SW fixture point lies outside Uni's extents).
- ID space is nearly disjoint: 140 shared road ids but only **35 of 140 have identical reference-line length (±1 cm)**; only 4 junction ids shared out of 32/31.
- Around the camera pole (120 m window): median ref-line offset **0.00 m**, p90 **1.46 m**, max **17.0 m** (81.5 % within 0.5 m).
- Junction 61 (the signalised junction the cameras face, ~50 m WSW): median **0.26 m**, p90 **5.96 m**, max **17.0 m**; approach lanes 62–70 individually ≤1.14 m.
- Road 14, **the nearest road to the camera pole (23 m)**: median offset **16.9 m**, worst **47.7 m** — a realignment, not noise. Roads 285/287 shift by 12.9 m near (−35, −114).

### Decision: (a) ingest the deployed `0737f3d9` XODR as a new Uni map derivative

Rationale:
1. All calibrations (§4) are geometrically anchored to the deployed lineage;
   the landmark fit and visual-parity acceptance would be invalidated by up to
   tens of metres in the camera frustums under option (b). Migration cost is
   unbounded re-survey; ingestion cost is bounded engineering.
2. Planimetric agreement near the sites between lineages is good but not
   sufficient (p90 ≈ 1.5–6 m in exactly the areas perception projects into),
   so "keep calibrations, swap pixels" is not a safe hybrid.

Executed first step (this branch):
- `dev-assets/richmond-field-station-carla0737/` created with the deployed
  XODR (`map.xodr`) and `lineage.json` pinning digest, source and status.
- The map pipeline was run against it to its precise blocker:
  `loadMapSources` requires `topology-index.json.gz`
  (`packages/maps/src/build/sources.ts`), which **no committed tooling
  regenerates** — it is an upstream authoring export (lane graph with ~1 m
  polylines, gates, turn relations; schema in
  `packages/engine/src/map/topology.ts`). Browser GLB tiles likewise come
  from RoadRunner/FBX sources that do not exist for the June revision.

Remaining prerequisites for full ingestion, in order:
1. Regenerate authoring exports for the June revision (RoadRunner source) —
   unblocks topology-index, lane-polygon/signal GeoJSONs and 3D tiles; OR
   build a committed OpenDRIVE→topology-index generator (data is derivable
   from lane links/junctions; effort bounded but non-trivial).
2. Register the map id in map-intel's `KNOWN_MAPS` and emit
   `derived/locations.json.gz` + `derived/topology-derived.json.gz`.
3. Re-pin facade/calibration consumers on `{mapId: richmond-field-station-carla0737,
   xodrSha256: 0737f3d9…}` per §3.

Until step 1 lands, V4 SensorRig should treat camera-pose placement as exact
(shared georef ⇒ identical planar projection) but must not claim pixel-level
ground-truth parity on Uni assets within ~150 m of the pole's west/south-west
sectors.

## 6. Golden fixtures

`fixtures/v2x-richmond-golden-projections.json` pins six points — the camera
pole, junction 61 centre, the map origin, and three extent/quadrant points —
each with WGS-84, strict xodr-local, legacy flat-earth values and the measured
cross-frame divergence. The vitest suite asserts: strict-tmerc recomputation
from WGS-84 (<1 mm), local↔WGS-84 round-trips, legacy-formula equality and
exact inverse round-trip, per-point cross-frame divergence reproduction, and
the deployed twin's pole placement. Run:

```
pnpm --filter @simforge/maps test
```
