/**
 * Step 2 of the build recipe: adopt the search index.
 *
 * The search index is ~80% of the catalog for free — 700 typed objects on Yale,
 * 159 on Richmond — with facts that are already flat primitives. Rebuilding
 * them would be waste; the value we add is (a) an actual road anchor, (b)
 * content-stable ids, (c) unique handles, (d) directional relations.
 *
 * Two identity caveats about the source data, both handled here:
 *
 * - `junction:<n>` — `<n>` is the **xodr junction id**, stable across rebuilds.
 *   Adopted directly as the identity key.
 * - `street:<n>` — `<n>` is a **positional index** into the builder's own
 *   enumeration, exactly the renumbering hazard the id design forbids. Streets
 *   are therefore re-keyed on their sorted lane-reference set, which is
 *   content-derived and order-independent.
 */

import { asLocationId } from '../types/ids.js';
import type {
  Affordance,
  FactValue,
  LocationExtent,
  LocationType,
  ProvenanceEntry,
} from '../types/location.js';
import type { SearchObject } from '../types/sources.js';
import { anchorFacts, anchorOnLane, liftAnchor } from './anchor-lift.js';
import type { BuildContext } from './context.js';
import type { LocationDraft } from './draft.js';
import { makeLocationIdString } from './hash.js';
import { slugify } from './slug.js';

/** How a search-index `kind` maps into our taxonomy. */
interface KindMapping {
  type: LocationType;
  subtype?: string;
  affordances: Affordance[];
}

const KIND_MAP: Record<string, KindMapping> = {
  junction: { type: 'junction', affordances: ['route', 'conflictPoint', 'vehicleSpawn'] },
  street: { type: 'driving_corridor', affordances: ['route', 'vehicleSpawn'] },
  road_segment_feature: {
    type: 'driving_corridor',
    subtype: 'road_segment_feature',
    affordances: ['route', 'vehicleSpawn'],
  },
  occlusion: { type: 'occlusion_zone', affordances: ['occluder', 'propPlacement'] },
  crosswalk_zone: { type: 'crosswalk', affordances: ['crossing', 'pedestrianSpawn'] },
  sidewalk_segment: { type: 'sidewalk', affordances: ['pedestrianSpawn', 'route'] },
  street_parking: { type: 'parking_lane', affordances: ['parkedVehicle', 'propPlacement'] },
  parking_lot: { type: 'parking_area', affordances: ['parkedVehicle', 'vehicleSpawn'] },
  bus_stop: { type: 'bus_stop', affordances: ['pedestrianSpawn', 'stopPoint'] },
  address: { type: 'address', affordances: [] },
  school_frontage: { type: 'poi_frontage', subtype: 'school', affordances: ['pedestrianSpawn'] },
  restaurant_frontage: {
    type: 'poi_frontage',
    subtype: 'restaurant',
    affordances: ['pedestrianSpawn'],
  },
  retail_frontage: { type: 'poi_frontage', subtype: 'retail', affordances: ['pedestrianSpawn'] },
  hospital_approach: { type: 'poi_frontage', subtype: 'hospital', affordances: ['pedestrianSpawn'] },
  gas_station_approach: {
    type: 'poi_frontage',
    subtype: 'gas_station',
    affordances: ['pedestrianSpawn'],
  },
  hotel_approach: { type: 'poi_frontage', subtype: 'hotel', affordances: ['pedestrianSpawn'] },
};

/** Adopted-object output, plus the id table relation wiring needs. */
export interface AdoptionResult {
  drafts: LocationDraft[];
  /** Search-index object id → our {@link LocationDraft.id}. */
  idBySourceObject: Map<string, string>;
  /** Search-index object ids we did not know how to adopt. */
  skippedKinds: Record<string, number>;
  /** Lane references reached exactly through the feature-ref join, per object. */
  lanesBySourceObject: Map<string, string[]>;
}

/** Adopt every object in the search index. */
export function adoptSearchIndex(ctx: BuildContext): AdoptionResult {
  const search = ctx.sources.searchIndex;
  const drafts: LocationDraft[] = [];
  const idBySourceObject = new Map<string, string>();
  const lanesBySourceObject = new Map<string, string[]>();
  const skippedKinds: Record<string, number> = {};
  if (!search) return { drafts, idBySourceObject, skippedKinds, lanesBySourceObject };

  // Sorted for determinism: object iteration order must never reach the output.
  for (const key of Object.keys(search.objects).sort()) {
    const obj = search.objects[key];
    if (!obj) continue;
    const mapping = KIND_MAP[obj.kind];
    if (!mapping) {
      skippedKinds[obj.kind] = (skippedKinds[obj.kind] ?? 0) + 1;
      continue;
    }
    const lanes = laneRefsFor(ctx, obj);
    if (lanes.length > 0) lanesBySourceObject.set(obj.id, lanes);
    const draft = adoptOne(ctx, obj, mapping, lanes);
    if (!draft) continue;
    drafts.push(draft);
    idBySourceObject.set(obj.id, draft.id as string);
  }
  return { drafts, idBySourceObject, skippedKinds, lanesBySourceObject };
}

/** Resolve a search object's `feature_refs` to lane references, sorted. */
function laneRefsFor(ctx: BuildContext, obj: SearchObject): string[] {
  const out = new Set<string>();
  for (const ref of obj.feature_refs ?? []) {
    const guid = ctx.featureIndexToGuid[ref.geojson_feature_id];
    if (!guid) continue;
    const rsl = ctx.guidToRsl.get(guid);
    if (rsl && ctx.graph.get(rsl)) out.add(rsl);
  }
  return [...out].sort();
}

function adoptOne(
  ctx: BuildContext,
  obj: SearchObject,
  mapping: KindMapping,
  lanes: string[],
): LocationDraft | null {
  const mapId = ctx.sources.mapId as string;
  const identityKey = identityKeyFor(obj, lanes);
  const id = asLocationId(makeLocationIdString(mapId, mapping.type, identityKey));

  const centroidLocal = ctx.toLocal(obj.centroid[0], obj.centroid[1]);

  // Anchoring strategy depends on how much the source already tells us.
  let lift = null as ReturnType<typeof liftAnchor> | null;
  if (obj.kind === 'street' && lanes.length > 0) {
    // The feature-ref join names the exact lanes; anchor mid-way along the
    // median lane rather than projecting a bbox centroid onto whatever is near.
    const chosen = lanes[Math.floor(lanes.length / 2)] as string;
    const lane = ctx.graph.get(chosen);
    if (lane) lift = anchorOnLane(ctx, chosen, lane.lengthM / 2);
  } else if (obj.kind === 'junction') {
    const junction = ctx.sources.topology.junctions[stripPrefix(obj.id)];
    const internal = junction?.internalLaneRsls ?? [];
    if (internal.length > 0) {
      lift = liftAnchor(ctx, centroidLocal, {
        onlyRsls: new Set(internal),
        maxDistanceM: 300,
        forceQuality: 'exact',
      });
    }
  }
  if (!lift) {
    lift = liftAnchor(ctx, centroidLocal, anchorPreferences(obj.kind));
  }

  const facts: Record<string, FactValue> = {};
  for (const [k, v] of Object.entries(obj.facts ?? {})) {
    const flat = asFactValue(v);
    if (flat !== undefined) facts[k] = flat;
  }
  Object.assign(facts, anchorFacts(lift.anchor));

  const affordances = new Set<Affordance>(mapping.affordances);
  if (facts['vehicle_spawn'] === true) affordances.add('vehicleSpawn');
  if (facts['pedestrian_spawn'] === true) affordances.add('pedestrianSpawn');
  if (facts['cyclist_spawn'] === true) affordances.add('cyclistSpawn');
  if (lift.anchor.road === null) {
    // Nothing placeable: strip spawn affordances so the query surface never
    // promises a placement it cannot honour.
    affordances.delete('vehicleSpawn');
    affordances.delete('cyclistSpawn');
  }

  const provenance: ProvenanceEntry[] = [
    { source: 'search-index', ref: obj.id, confidence: 0.9 },
  ];
  if (lift.anchor.road) {
    provenance.push({
      source: 'topology-index',
      ref: lift.anchor.road.rsl as string,
      confidence: lift.quality === 'exact' ? 1 : lift.quality === 'projected' ? 0.8 : 0.5,
    });
  }

  return {
    id,
    name: obj.name,
    type: mapping.type,
    subtype: mapping.subtype,
    tags: normaliseTags(obj.scenario_tags),
    anchor: lift.anchor,
    extent: extentFor(obj),
    affordances: [...affordances].sort(),
    facts,
    provenance,
    quality: { anchor: lift.quality, confidence: confidenceFor(facts, lift.quality) },
    naming: namingFor(ctx, obj, mapping, lift.anchor.road?.rsl as string | undefined),
    sourceObjectId: obj.id,
    identityKey,
  };
}

/**
 * Content identity key for an adopted object.
 *
 * Never the object's array position, and never anything a threshold tweak in
 * the upstream detectors can renumber.
 */
function identityKeyFor(obj: SearchObject, lanes: string[]): string {
  switch (obj.kind) {
    case 'junction':
      // `junction:115` — 115 is the xodr junction id.
      return `junction:${stripPrefix(obj.id)}`;
    case 'street':
      // `street:0` is positional; re-key on the lane set it actually covers.
      return lanes.length > 0 ? `lanes:${lanes.join(',')}` : `search:${obj.id}`;
    case 'address':
      // `address:addr_<overture hash>` — already content-derived upstream.
      return `overture:${stripPrefix(obj.id)}`;
    default:
      // `poi:<kind>:<slug>-<hash>` — slug + content hash, stable enough to adopt.
      return `search:${obj.id}`;
  }
}

function stripPrefix(id: string): string {
  const idx = id.indexOf(':');
  return idx < 0 ? id : id.slice(idx + 1);
}

function anchorPreferences(kind: string): { laneTypes?: string[]; maxDistanceM?: number } {
  switch (kind) {
    case 'crosswalk_zone':
    case 'sidewalk_segment':
      return { maxDistanceM: 60 };
    case 'street_parking':
      return { maxDistanceM: 40 };
    case 'address':
      return { maxDistanceM: 120 };
    default:
      return { maxDistanceM: 150 };
  }
}

function extentFor(obj: SearchObject): LocationExtent | undefined {
  const b = obj.bbox;
  if (!b || b.length < 4) return undefined;
  const [minLng, minLat, maxLng, maxLat] = b;
  if (minLng === maxLng && minLat === maxLat) return undefined;
  const perLng = 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const w = Math.abs(maxLng - minLng) * perLng;
  const h = Math.abs(maxLat - minLat) * 110_574;
  return {
    bboxGeo: [minLng, minLat, maxLng, maxLat],
    radiusM: Math.round(Math.hypot(w, h) / 2),
  };
}

function confidenceFor(facts: Record<string, FactValue>, quality: string): number {
  const base = typeof facts['confidence'] === 'number' ? (facts['confidence'] as number) : 0.85;
  const penalty = quality === 'exact' ? 0 : quality === 'projected' ? 0.05 : quality === 'inferred' ? 0.15 : 0.3;
  return Math.max(0, Math.round((base - penalty) * 100) / 100);
}

/** Flatten a foreign fact value; nested objects are dropped, not stringified. */
function asFactValue(v: unknown): FactValue | undefined {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return [...(v as string[])].sort();
    if (v.every((x) => typeof x === 'number')) return v as number[];
  }
  return undefined;
}

function normaliseTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))].sort();
}

function namingFor(
  ctx: BuildContext,
  obj: SearchObject,
  mapping: KindMapping,
  rsl: string | undefined,
): LocationDraft['naming'] {
  const roadNames = new Set<string>();
  const connected = obj.facts?.['connected_road_names'];
  if (Array.isArray(connected)) for (const n of connected) if (typeof n === 'string') roadNames.add(n);
  const resolved = obj.facts?.['resolved_name'];
  if (typeof resolved === 'string' && resolved) roadNames.add(resolved);
  if (rsl) {
    const laneRoad = ctx.roadNameByRsl.get(rsl);
    if (laneRoad) roadNames.add(laneRoad);
  }
  const stems: string[] = [];
  if (mapping.type === 'junction') {
    const sorted = [...roadNames].sort();
    if (sorted.length >= 2) stems.push(`${slugify(sorted[0] as string)}-at-${slugify(sorted[1] as string)}`);
    if (sorted.length === 1) stems.push(slugify(sorted[0] as string));
  } else {
    if (obj.name) stems.push(slugify(obj.name));
    const first = [...roadNames].sort()[0];
    if (first) stems.push(slugify(first));
  }
  if (stems.length === 0) stems.push(slugify(mapping.subtype ?? mapping.type));
  return { stems: stems.filter(Boolean), roadNames: [...roadNames].sort() };
}
