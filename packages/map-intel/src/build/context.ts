/**
 * The shared build context: everything derived once and read by every step.
 *
 * The two non-obvious joins live here:
 *
 * 1. **`geojson_feature_uuids[i] === mapGeojson.features[i].properties.Id`** —
 *    verified exactly on all five dev maps. So a search-index `feature_ref`'s
 *    `geojson_feature_id` is a *positional index* into the RoadRunner GeoJSON,
 *    which yields a RoadRunner GUID.
 * 2. **`lane-polygons.geojson.lane_guid` → `road:section:lane`** — the only
 *    artifact that carries the GUID ↔ `rsl` mapping.
 *
 * Chaining them turns a search-index `street` object into an *exact* set of
 * lane references, which is what lets adopted streets anchor at quality
 * `exact` instead of being projected from a centroid. It is also the source of
 * the per-lane road-name table, which every handle in the catalog depends on.
 */

import { CoordinateFrame } from '@uniscenarios/xodr-tools';

import { ElevationField } from '../geometry/elevation.js';
import { LaneGraph } from '../geometry/lane-graph.js';
import type { Point2 } from '../geometry/vec.js';
import type { GeoPoint, ScenePoint } from '../types/location.js';
import type { MapSources } from './sources.js';

/** Derived lookups shared by every build step. */
export interface BuildContext {
  sources: MapSources;
  graph: LaneGraph;
  frame: CoordinateFrame;
  elevation: ElevationField;
  /** RoadRunner GUID → `rsl`. */
  guidToRsl: Map<string, string>;
  /** `mapGeojson.features` index → RoadRunner GUID. */
  featureIndexToGuid: string[];
  /** `rsl` → display road name (may be absent). */
  roadNameByRsl: Map<string, string>;
  /** `roadId` (as string) → display road name. */
  roadNameByRoadId: Map<string, string>;
  /** WGS84 → xodr-local metres. */
  toLocal(lng: number, lat: number): Point2;
  /** xodr-local metres → WGS84. */
  toGeo(p: Point2): GeoPoint;
  /** xodr-local metres → y-up scene metres, with sampled ground elevation. */
  toScene(p: Point2): ScenePoint;
}

/** Build the shared context for one map. */
export function createBuildContext(sources: MapSources): BuildContext {
  const graph = new LaneGraph(sources.topology);
  const frame = sources.frame;

  // --- GUID ↔ rsl ---------------------------------------------------------
  const guidToRsl = new Map<string, string>();
  for (const f of sources.lanePolygons?.features ?? []) {
    const p = f.properties;
    if (!p.lane_guid || p.road_id === undefined || p.lane_id === undefined) continue;
    guidToRsl.set(p.lane_guid, `${p.road_id}:${p.section_id ?? 0}:${p.lane_id}`);
  }

  const featureIndexToGuid: string[] = [];
  const uuids = (sources.searchIndex as unknown as { geojson_feature_uuids?: string[] } | null)
    ?.geojson_feature_uuids;
  if (uuids && sources.mapGeojson && uuids.length === sources.mapGeojson.features.length) {
    featureIndexToGuid.push(...uuids);
  } else if (sources.mapGeojson) {
    // Fall back to reading the ids directly; identical in practice, but the
    // uuid sidecar is the documented contract so it is preferred when present.
    for (const f of sources.mapGeojson.features) featureIndexToGuid.push(f.properties.Id ?? '');
  }

  // --- elevation ----------------------------------------------------------
  const elevation = new ElevationField();
  for (const f of sources.mapGeojson?.features ?? []) {
    if (f.properties.Type !== 'Lane') continue;
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords)) continue;
    for (const raw of coords as unknown[]) {
      if (!Array.isArray(raw) || raw.length < 3) continue;
      const [lng, lat, z] = raw as number[];
      if (typeof lng !== 'number' || typeof lat !== 'number' || typeof z !== 'number') continue;
      const [x, y] = frame.wgs84ToLocal(lng, lat);
      elevation.add(x, y, z);
    }
  }
  elevation.finalise();

  // --- road names ---------------------------------------------------------
  const roadNameByRsl = new Map<string, string>();
  const roadNameByRoadId = new Map<string, string>();
  for (const obj of Object.values(sources.searchIndex?.objects ?? {})) {
    if (obj.kind !== 'street') continue;
    const name = String(obj.facts?.['resolved_name'] ?? obj.name ?? '').trim();
    if (!name) continue;
    for (const ref of obj.feature_refs ?? []) {
      const guid = featureIndexToGuid[ref.geojson_feature_id];
      const rsl = guid ? guidToRsl.get(guid) : undefined;
      if (!rsl) continue;
      roadNameByRsl.set(rsl, name);
      const roadId = rsl.split(':')[0];
      if (roadId && !roadNameByRoadId.has(roadId)) roadNameByRoadId.set(roadId, name);
    }
  }
  // An authored `roadNames` table is the weakest claim of the three, so it only
  // fills roads the search index left unnamed — but it must be applied before
  // the propagation below, or the names would never reach individual lanes.
  for (const [roadId, rawName] of Object.entries(sources.roadNames ?? {})) {
    const name = rawName.trim();
    if (!name || roadNameByRoadId.has(roadId)) continue;
    roadNameByRoadId.set(roadId, name);
  }
  // Propagate a road's name to every lane on that road, including the lanes the
  // search index did not enumerate (shoulders, bike lanes, sidewalks).
  for (const lane of graph.allLanes()) {
    const key = lane.rsl as string;
    if (roadNameByRsl.has(key)) continue;
    const name = roadNameByRoadId.get(String(lane.raw.roadId));
    if (name) roadNameByRsl.set(key, name);
  }
  // Signals carry `street_name` too; use it only where nothing else knows.
  for (const f of sources.signals?.features ?? []) {
    const roadId = f.properties.road_id;
    const name = f.properties.street_name?.trim();
    if (!roadId || !name || roadNameByRoadId.has(roadId)) continue;
    roadNameByRoadId.set(roadId, name);
  }

  return {
    sources,
    graph,
    frame,
    elevation,
    guidToRsl,
    featureIndexToGuid,
    roadNameByRsl,
    roadNameByRoadId,
    toLocal(lng, lat) {
      const [x, y] = frame.wgs84ToLocal(lng, lat);
      return { x, y };
    },
    toGeo(p) {
      const [lng, lat] = frame.localToWgs84(p.x, p.y);
      return { lng, lat };
    },
    toScene(p) {
      const z = elevation.at(p);
      const [x, y, sz] = frame.localToScene(p.x, p.y, z);
      return { x, y, z: sz };
    },
  };
}

/** Road name for a lane, falling back to its road, then to `''`. */
export function roadNameFor(ctx: BuildContext, rsl: string): string {
  const direct = ctx.roadNameByRsl.get(rsl);
  if (direct) return direct;
  const roadId = rsl.split(':')[0];
  return (roadId && ctx.roadNameByRoadId.get(roadId)) || '';
}
