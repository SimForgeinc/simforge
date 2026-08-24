/**
 * `DerivedMapIndex` — the matcher's view of a map.
 *
 * This is the **normalizer seam** with `packages/maps`: the matcher never
 * reads a raw artifact, it reads this shape. `normalize.ts` adapts map-intel's
 * `derived/topology-derived.json` onto it, and `derive.ts` builds the same
 * shape straight from `topology-index.json.gz` so this lane is not blocked on
 * the sibling. Both paths are covered by tests.
 *
 * Shapes follow `docs/research/retargeting.md` § Derived per-map indexes and
 * `docs/research/location-catalog.md`.
 */

import { z } from 'zod';
import type { JunctionControl, Turn, ApproachRelation } from './anchor.js';

/** `road:section:lane` key. A *placement* id — never a display string. */
export type LaneRsl = string;

export interface Point2 {
  x: number;
  y: number;
}

export interface WidthSample {
  s: number;
  widthM: number;
}

export interface AdjacentLaneRef {
  laneRsl: LaneRsl | null;
  sameDirection: boolean;
}

export interface LaneChangePermission {
  side: 'left' | 'right';
  startS: number;
  endS: number;
  allowed: boolean;
}

/**
 * A lane, in **travel-direction order**.
 *
 * `polyline` here is normalized so that index 0 is where a vehicle *enters* the
 * lane. The raw topology index stores polylines in OpenDRIVE `s` order, which
 * runs backwards for positive lane ids; `derive.ts` flips them, and every
 * consumer downstream can assume travel order.
 */
export interface DerivedLane {
  rsl: LaneRsl;
  roadId: number;
  section: number;
  laneId: number;
  laneType: string;
  isJunction: boolean;
  junctionId: string | null;
  /** Travel-ordered centreline, ~1 m sampling. */
  polyline: Point2[];
  lengthM: number;
  speedLimitKph: number;
  representativeWidthM: number;
  widthSamples: WidthSample[];
  adjacentLanes: { left: AdjacentLaneRef; right: AdjacentLaneRef };
  laneChangePermissions: LaneChangePermission[];
  /** Travel-direction predecessors/successors, geometry-verified. */
  predecessors: LaneRsl[];
  successors: LaneRsl[];
}

export interface DerivedGate {
  id: string;
  junctionId: string;
  turnRelation: Turn;
  headingChangeRad: number;
  approachLaneRsl: LaneRsl;
  connectingLaneRsl: LaneRsl;
  exitLaneRsls: LaneRsl[];
}

/**
 * A precomputed crossing between two junction gates — "the single
 * highest-value derived fact" (Scenic's `conflictingManeuvers`).
 */
export interface ConflictPair {
  gateA: string;
  gateB: string;
  point: Point2;
  /** Arc length along gate A's connecting lane at the crossing. */
  sOnA: number;
  sOnB: number;
  /** Absolute crossing angle of the two paths, degrees in [0, 180]. */
  crossingAngleDeg: number;
  /** Where B comes from, seen from A's approach. */
  relation: ApproachRelation;
}

export interface JunctionApproach {
  /** Stable per-junction approach id (`<junctionId>#<roadId>:<section>`). */
  id: string;
  laneRsls: LaneRsl[];
  /** Inbound heading at the stop line, degrees CCW from +x. */
  bearingDeg: number;
  turnOptions: Turn[];
  gateIds: string[];
  /** Same-direction driving lanes on this approach at the stop line. */
  throughLanes: number;
}

export interface JunctionDescriptor {
  junctionId: string;
  /** Distinct inbound arms (approaches merged by bearing). */
  arms: number;
  approaches: JunctionApproach[];
  control: JunctionControl | 'unknown';
  /** Diagonal extent of the junction-internal geometry, metres. */
  sizeM: number;
  conflictPairs: ConflictPair[];
  /** Crossing (crosswalk) ids per approach id — empty when the map index has no crossing layer. */
  crossingsByApproach: Record<string, string[]>;
  gateIds: string[];
  internalLaneRsls: LaneRsl[];
}

/** Piecewise profile sample over a segment's arc length. */
export interface SegmentProfileSample {
  s: number;
  laneRsl: LaneRsl;
  throughLanesSameDir: number;
  throughLanesOpposing: number;
  laneWidthM: number;
  speedLimitKph: number;
  curvatureDegPer10m: number;
  adjacentKinds: string[];
}

/** A maximal lane chain between junctions. */
export interface Segment {
  id: string;
  laneRsls: LaneRsl[];
  lengthM: number;
  profile: SegmentProfileSample[];
  entryJunctionId: string | null;
  exitJunctionId: string | null;
  /** Min/max over the profile — the cheap pre-filter for candidate generation. */
  minThroughLanesSameDir: number;
  maxThroughLanesSameDir: number;
  minSpeedLimitKph: number;
  maxSpeedLimitKph: number;
}

/**
 * Optional point features from the location catalog (crossings, parking zones,
 * bus stops, driveways). Absent in a self-derived index — clauses that need
 * them then report `supported: false` rather than silently passing.
 */
export interface PointFeature {
  id: string;
  kind: 'crossing' | 'parking_zone' | 'bus_stop' | 'driveway' | 'school_zone' | 'work_zone_suitable' | 'occlusion_zone' | 'crest';
  laneRsl: LaneRsl;
  s: number;
  /** Feature world point in xodr-local metres, when the source catalog carries it. */
  point?: Point2;
  side?: 'left' | 'right' | 'both';
  junctionId?: string;
  /**
   * The location's published facts.
   *
   * String arrays are carried through rather than flattened away because the
   * single most useful fact in the catalog — an occlusion zone's
   * `supported_scenario_templates` whitelist — is one, and the old scalar-only
   * filter discarded it before any clause could ask.
   */
  facts?: Record<string, string | number | boolean | readonly string[]>;
}

/** Inverted maps for selectivity-ordered candidate generation. */
export interface FactIndex {
  junctionsByControl: Record<string, string[]>;
  junctionsByArms: Record<string, string[]>;
  junctionsByTurnOption: Record<string, string[]>;
  segmentsByLaneCount: Record<string, string[]>;
  segmentIdsByLane: Record<LaneRsl, string>;
  pointFeaturesByKind: Record<string, string[]>;
  /** Total counts, used to order clauses by selectivity. */
  totals: { junctions: number; segments: number; lanes: number };
}

export interface DerivedMapIndex {
  mapId: string;
  /** Content hash of the topology inputs — part of every `siteId`. */
  topologyDigest: string;
  /** Traffic handedness of the map. */
  handedness: 'right' | 'left';
  lanes: Record<LaneRsl, DerivedLane>;
  gates: DerivedGate[];
  junctions: Record<string, { junctionId: string; gateIds: string[]; internalLaneRsls: LaneRsl[]; approachLaneRsls: LaneRsl[] }>;
  segments: Segment[];
  junctionDescriptors: Record<string, JunctionDescriptor>;
  pointFeatures: PointFeature[];
  factIndex: FactIndex;
  /** Which optional layers this index actually carries. */
  capabilities: IndexCapabilities;
  provenance: { source: 'map-intel' | 'self-derived'; contractVersion: string; notes: string[] };
}

/**
 * What the index can answer. A clause over a missing capability fails loudly
 * (required) or is skipped with a note (preferred/cosmetic) — it never scores
 * a silent 1.0.
 */
export interface IndexCapabilities {
  /** z is available on lane polylines (needed by `gradePct`). */
  grade: boolean;
  /** Crossing/crosswalk layer present (`hasCrossingOnLeg`, `on_crossing`). */
  crossings: boolean;
  /** Parking-zone layer present (`in_parking_zone`). */
  parkingZones: boolean;
  /** Pre-derived stretches where a lane closure/taper can physically fit. */
  workZones: boolean;
  /** Catalog evidence for a sight-line obstruction/occluder placement. */
  occlusionZones: boolean;
  /** Junction control is real rather than assumed. */
  junctionControl: boolean;
}

export const Point2Schema = z.strictObject({ x: z.number(), y: z.number() });

/** Loose schema for the *external* derived-index file (map-intel's output). */
export const ExternalDerivedIndexSchema = z.looseObject({
  mapId: z.string().optional(),
  topologyDigest: z.string().optional(),
  lanes: z.record(z.string(), z.unknown()).optional(),
  gates: z.array(z.unknown()).optional(),
  junctions: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  segments: z.array(z.unknown()).optional(),
  junctionDescriptors: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional(),
  factIndex: z.unknown().optional(),
});
