/**
 * The location catalog record shape.
 *
 * Design notes carried over from `docs/research/location-catalog.md`:
 *
 * - **Three-part identity** — `id` (content-derived, stable), `name` (human,
 *   *not* unique), `handle` (unique, typeable, LLM-facing).
 * - **Three-level anchor** — geographic, scene, and road-network. The road
 *   anchor is what makes a location *draftable*; without it a location is
 *   searchable but not placeable, which is the authorability cliff we are
 *   explicitly avoiding.
 * - **Flat facts** — primitives and arrays of primitives only. No nesting, ever;
 *   nested facts are what make a fact vocabulary unqueryable.
 */

import type { GateId, Handle, JunctionId, LaneRef, LocationId, MapId } from './ids.js';

/** Catalog taxonomy. Closed vocabulary — injected into LLM tool schemas verbatim. */
export const LOCATION_TYPES = [
  'junction',
  'junction_movement',
  'driving_corridor',
  'bike_corridor',
  'walking_corridor',
  'midblock_segment',
  'merge_zone',
  'lane_drop',
  'parking_lane',
  'parking_space',
  'parking_area',
  'parking_access_point',
  'driveway',
  'loading_zone',
  'bus_stop',
  'crosswalk',
  'sidewalk',
  'curb',
  'median',
  'refuge_island',
  'building_entrance',
  'school_zone',
  'work_zone_suitable',
  'occlusion_zone',
  'conflict_zone',
  'poi_frontage',
  'address',
] as const;

/** A member of {@link LOCATION_TYPES}. */
export type LocationType = (typeof LOCATION_TYPES)[number];

/** What a location can be used for when placing actors and props. */
export const AFFORDANCES = [
  'vehicleSpawn',
  'pedestrianSpawn',
  'cyclistSpawn',
  'parkedVehicle',
  'occluder',
  'route',
  'crossing',
  'stopPoint',
  'propPlacement',
  'conflictPoint',
] as const;

/** A member of {@link AFFORDANCES}. */
export type Affordance = (typeof AFFORDANCES)[number];

/** How trustworthy the road anchor is. */
export type AnchorQuality = 'exact' | 'projected' | 'inferred' | 'unanchored';

/** A flat fact value. Nesting is deliberately impossible. */
export type FactValue = string | number | boolean | readonly string[] | readonly number[];

/** WGS84 position. */
export interface GeoPoint {
  lng: number;
  lat: number;
}

/** y-up scene position (metres), same frame as the glTF tiles. */
export interface ScenePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * The road-network anchor — the level the prior system never derived.
 *
 * `s` is arc length along the lane's own polyline from its start, and
 * `offsetM` is signed lateral distance from the lane centreline (positive to
 * the lane's left). Together with `headingRad` this is directly usable as an
 * OpenSCENARIO `LanePosition`.
 */
export interface RoadAnchor {
  /** Placement anchor. Branded so it cannot be confused with a display string. */
  rsl: LaneRef;
  /**
   * Arc length along the lane **in the direction of travel**, metres from where
   * a vehicle enters the lane.
   *
   * This is *not* OpenDRIVE `s`: the topology index stores polylines in `s`
   * order, and a positive-id lane travels against `s`, so the two run opposite
   * on ~40% of lanes. Travel order is what every consumer actually wants (a
   * spawn point 20 m into the lane, a conflict 8 m into a movement); an
   * exporter that needs OpenDRIVE `s` converts with `LaneGraph.toXodrS`.
   */
  s: number;
  /** Signed lateral offset from the lane centreline, metres (left positive). */
  offsetM: number;
  /** Lane travel heading at `s`, radians, xodr-local (0 = +x/east, CCW). */
  headingRad: number;
  /** `driving` | `biking` | `sidewalk` | `parking` | `shoulder` | ... */
  laneType: string;
  /** Distance from the subject's own point to the anchored lane point, metres. */
  distanceM: number;
  /** Junction the anchor lane belongs to, when it is junction-internal. */
  junctionId?: JunctionId;
  /** Gate the anchor lane realises, when it is a junction movement. */
  gateId?: GateId;
  /** Speed limit of the anchor lane, kph. */
  speedLimitKph?: number;
}

/** Three-level anchor. `road` is `null` when nothing was within reach. */
export interface LocationAnchor {
  geo: GeoPoint;
  scene: ScenePoint;
  road: RoadAnchor | null;
}

/** Spatial footprint, when the location is more than a point. */
export interface LocationExtent {
  /** `[minLng, minLat, maxLng, maxLat]`. */
  bboxGeo: readonly [number, number, number, number];
  /** Along-road length, metres, when meaningful. */
  lengthM?: number;
  /** Circumscribing radius, metres. */
  radiusM?: number;
}

/** Where a location (or one of its facts) came from. */
export interface ProvenanceEntry {
  /** `search-index` | `topology-index` | `map-geojson` | `signals-geojson` | `overlay-payload` */
  source: string;
  /** Identifier within that source (search-index object id, gate id, GUID, ...). */
  ref: string;
  /** 0..1 — how much to trust this source for this record. */
  confidence: number;
}

/** A catalog record. */
export interface StudioLocation {
  id: LocationId;
  /** Unique per map. What agents and the CLI address locations by. */
  handle: Handle;
  /** Display only. Not unique, never a placement reference. */
  name: string;
  type: LocationType;
  subtype?: string;
  /** Scenario tags (`PEDESTRIAN_DARTOUT`, ...) plus derived tags. Sorted. */
  tags: string[];
  anchor: LocationAnchor;
  extent?: LocationExtent;
  /** Sorted. */
  affordances: Affordance[];
  /** Flat primitives only. Keys sorted on emit. */
  facts: Record<string, FactValue>;
  provenance: ProvenanceEntry[];
  quality: {
    anchor: AnchorQuality;
    /** 0..1 aggregate confidence. */
    confidence: number;
  };
}

/** Directional relation vocabulary. */
export const RELATION_KINDS = [
  'approaches',
  'anchors_to',
  'accesses',
  'part_of',
  'contains',
  'crosses',
  'adjacent_to',
  'conflicts_with',
] as const;

/** A member of {@link RELATION_KINDS}. */
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * A directed edge between two catalog records.
 *
 * `bearingDeg` is the compass bearing (0 = north, clockwise) from `from` to
 * `to`, which is the directional vocabulary the prior system lacked entirely.
 */
export interface LocationRelation {
  from: LocationId;
  to: LocationId;
  kind: RelationKind;
  bearingDeg: number;
  distanceM: number;
}

/** The built, serialisable catalog. */
export interface LocationCatalog {
  catalogVersion: number;
  /** sha256 over the sorted source hashes — the cache key. */
  catalogRevision: string;
  mapId: MapId;
  /** Full map asset id, e.g. `yale-street_20260409-234639`. */
  mapAssetId: string;
  sourceHashes: Record<string, string>;
  builtAt: string;
  locations: StudioLocation[];
  relations: LocationRelation[];
  stats: CatalogStats;
}

/** Build-time summary, emitted for reporting and regression checks. */
export interface CatalogStats {
  locationCount: number;
  byType: Record<string, number>;
  anchorQuality: Record<AnchorQuality, number>;
  relationCount: number;
  handleCollisionsResolved: number;
  /** Rung of the disambiguation ladder → how many handles needed it. */
  handleLadderUsage: Record<string, number>;
}
