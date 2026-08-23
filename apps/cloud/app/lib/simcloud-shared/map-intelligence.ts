/**
 * Map Intelligence types — scene graph entities, detector evidence, and pipeline output.
 *
 * All types defined as Zod schemas for runtime validation + TypeScript inference.
 * Used by the scene graph builders, primitive features, detectors, and candidate engine.
 */

import { z } from "zod";
import { CandidateLocationRegionSchema } from "./map-candidate-location";

// ── Provenance ─────────────────────────────────────────────────────────────

export const ProvenanceSchema = z.object({
  sourceFile: z.enum(["geojson", "xodr", "rrdata_xml", "overture"]),
  sourceIds: z.array(z.string()),
  extractorVersion: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── Scene entity base ──────────────────────────────────────────────────────

export const SceneEntityKindSchema = z.enum([
  "junction",
  "road_segment",
  "crosswalk",
  "parking_cluster",
  "signal",
  "sign",
]);
export type SceneEntityKind = z.infer<typeof SceneEntityKindSchema>;

// ── Junction entity ────────────────────────────────────────────────────────

export const JunctionEntitySchema = z.object({
  entityId: z.string(),
  kind: z.literal("junction"),
  center: z.object({ lat: z.number(), lng: z.number() }),
  region: CandidateLocationRegionSchema,
  provenance: ProvenanceSchema,

  approachCount: z.number(),
  gateCount: z.number(),
  laneCount: z.number(),
  hasPhases: z.boolean(),
  xodrJunctionId: z.string().optional(),
  xodrRoadDegree: z.number().optional(),
  isSignalized: z.boolean(),
  hasStopSign: z.boolean(),
  isAllWayStop: z.boolean(),
  /**
   * Number of RoadRunner Gate features with TurnRelation=Left (or UTurnLeft)
   * whose midpoint falls inside this junction's polygon. Zero means no left
   * turn is represented at this junction.
   */
  leftTurnGateCount: z.number().default(0),
  /**
   * True when at least one of the signals governing this junction is a
   * protected left-turn signal — i.e. an XODR signal with MUTCD code R10-6
   * (Left Turn Signal), or a signal whose name matches a left-arrow /
   * left-turn-signal pattern. Populated via xodrJunctionInfo; stays false
   * when only GeoJSON is available.
   */
  hasProtectedLeftSignal: z.boolean().default(false),
  /** Outer ring of the junction polygon in [lng, lat] pairs. */
  polygon: z.array(z.tuple([z.number(), z.number()])),
});
export type JunctionEntity = z.infer<typeof JunctionEntitySchema>;

// ── Road segment entity ────────────────────────────────────────────────────

export const RoadSegmentEntitySchema = z.object({
  entityId: z.string(),
  kind: z.literal("road_segment"),
  center: z.object({ lat: z.number(), lng: z.number() }),
  region: CandidateLocationRegionSchema,
  provenance: ProvenanceSchema,

  roadId: z.string(),
  lengthM: z.number(),
  laneCountByType: z.record(z.number()),
  speedLimitMph: z.number().optional(),
  gradePct: z.number().optional(),
  hasSidewalk: z.boolean(),
  hasBikeLane: z.boolean(),
  hasParkingLane: z.boolean(),
  signalCategories: z.array(z.string()),
  isJunctionInternal: z.boolean(),
});
export type RoadSegmentEntity = z.infer<typeof RoadSegmentEntitySchema>;

// ── Crosswalk entity ───────────────────────────────────────────────────────

export const CrosswalkEntitySchema = z.object({
  entityId: z.string(),
  kind: z.literal("crosswalk"),
  center: z.object({ lat: z.number(), lng: z.number() }),
  region: CandidateLocationRegionSchema,
  provenance: ProvenanceSchema,

  xodrObjectId: z.string().optional(),
  isNearJunction: z.boolean(),
  nearestJunctionEntityId: z.string().optional(),
});
export type CrosswalkEntity = z.infer<typeof CrosswalkEntitySchema>;

// ── Parking cluster entity ─────────────────────────────────────────────────

export const ParkingAccessPointSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  roadId: z.string().optional(),
  bearingDeg: z.number().optional(),
});
export type ParkingAccessPoint = z.infer<typeof ParkingAccessPointSchema>;

export const ParkingClusterEntitySchema = z.object({
  entityId: z.string(),
  kind: z.literal("parking_cluster"),
  center: z.object({ lat: z.number(), lng: z.number() }),
  region: CandidateLocationRegionSchema,
  provenance: ProvenanceSchema,

  parkingLaneIds: z.array(z.string()),
  /**
   * Indices of in-house RoadRunner ParkingSpace features that belong to this
   * cluster. For lane-backed clusters, these are the ParkingSpaces absorbed
   * via lane-proximity. For Overture-aggregated lot clusters, these are the
   * ParkingSpaces whose centroid falls inside the Overture polygon. Empty
   * for Overture lots with no in-house spaces inside (still emitted when
   * the lot passes the road-proximity filter).
   */
  parkingSpaceIds: z.array(z.string()).optional(),
  totalLengthM: z.number(),
  spaceCount: z.number().optional(),
  isStreetParking: z.boolean(),
  isLotParking: z.boolean(),
  /**
   * True when the cluster was built solely from ParkingSpace polygons with no
   * adjacent parking lane — a standalone off-street parking lot.
   */
  isStandaloneLot: z.boolean().optional(),
  /**
   * Points along the lot boundary where it meets a driving lane — candidate
   * vehicle entry/exit locations.
   */
  accessPoints: z.array(ParkingAccessPointSchema).optional(),
});
export type ParkingClusterEntity = z.infer<typeof ParkingClusterEntitySchema>;

// ── Signal / Sign entity ───────────────────────────────────────────────────

export const SignalEntitySchema = z.object({
  entityId: z.string(),
  kind: z.enum(["signal", "sign"]),
  center: z.object({ lat: z.number(), lng: z.number() }),
  region: CandidateLocationRegionSchema,
  provenance: ProvenanceSchema,

  signalCategory: z.string(),
  roadId: z.string(),
  mutcdCode: z.string().optional(),
  displayName: z.string(),
});
export type SignalEntity = z.infer<typeof SignalEntitySchema>;

// ── Detector evidence ──────────────────────────────────────────────────────

export const DetectorEvidenceSchema = z.object({
  detectorId: z.string(),
  detectorVersion: z.string(),
  /** Primitive values that drove the detector decision. */
  primitives: z.record(z.union([z.number(), z.boolean(), z.string()])),
  confidence: z.number().min(0).max(1),
  matchedTags: z.array(z.string()),
  explanation: z.string(),
});
export type DetectorEvidence = z.infer<typeof DetectorEvidenceSchema>;

// ── Detector result (output of a single detector invocation) ───────────────

export const DetectorResultSchema = z.object({
  anchorEntityId: z.string(),
  evidence: DetectorEvidenceSchema,
});
export type DetectorResult = z.infer<typeof DetectorResultSchema>;

// ── Detector interface ─────────────────────────────────────────────────────

/** Runtime detector descriptor. Not a Zod schema — used as a plain interface. */
export type Detector = {
  id: string;
  version: string;
  detect(sceneGraph: MapSceneGraph): DetectorResult[];
};

// ── Map scene graph ────────────────────────────────────────────────────────

export const MapSceneGraphSchema = z.object({
  mapAssetId: z.string(),
  computedAt: z.string(),
  junctions: z.array(JunctionEntitySchema),
  roadSegments: z.array(RoadSegmentEntitySchema),
  crosswalks: z.array(CrosswalkEntitySchema),
  parkingClusters: z.array(ParkingClusterEntitySchema),
  signals: z.array(SignalEntitySchema),
  signs: z.array(SignalEntitySchema),
});
export type MapSceneGraph = z.infer<typeof MapSceneGraphSchema>;
