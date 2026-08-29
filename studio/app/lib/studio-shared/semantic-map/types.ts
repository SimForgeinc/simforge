import { z } from "zod";
import {
  RuntimeBoundMapTopologyIndexSchema,
  RuntimeTopologyProvenanceSchema,
  TurnRelationSchema,
} from "@simforge-oss/maps/topology";

export const SEMANTIC_MAP_SCHEMA_VERSION = "simforge.semantic-map.v1" as const;
/**
 * Bumped to v3 on 2026-07-29 for the crawl-truncation fix in
 * `runtime-lane-geometry.ts`, which changes lane geometry, junction seam
 * verdicts and therefore `authoringStatus` across every map. A stored
 * publication is validated against this literal, so the bump is what stops the
 * v2 artifacts from being served in preference to a corrected live compile
 * (`readCompatibleSemanticGraphPublication` treats the parse failure as "no
 * publication"). Republishing re-stamps them.
 *
 * Bumped to v4 on 2026-07-30 for link-attested lane binding
 * (`build-runtime-parity.ts`), which binds lanes the CARLA crawl never sampled
 * and moves 2186 junction gates from unbound to bound across the nine dev maps.
 * Every corridor, variant and `authoringStatus` on every map changes, so serving
 * a v3 artifact next to a v4 compile would mean two callers disagreeing about
 * whether a car can turn left.
 *
 * Bumped to v5 on 2026-07-31: a movement is now named after the turn its
 * geometry actually describes rather than the gate's declared `turnRelation`,
 * and `MOVEMENT_TURN_MISMATCH` no longer demotes the variant that disagreed. On
 * Di Rosa that is 191 corridors -> 181 and 252 authorable variants -> 274.
 *
 * THE BUMP IS THE INVALIDATION. `getSemanticMapGraph` serves
 * `readCompatibleSemanticGraphPublication` in preference to compiling, and that
 * read only misses when the stored artifact fails to parse — which it does
 * because this constant is pinned by `z.literal` below. Changing the compiler's
 * OUTPUT without changing this string leaves every map pinned to the previous
 * compile forever: republishing then reads the old graph back and writes it
 * out unchanged, which is exactly what happened before this bump.
 */
export const SEMANTIC_MAP_COMPILER_VERSION = "semantic-map-compiler.v5" as const;

export const SemanticMapPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().nullable(),
});
export type SemanticMapPoint = z.infer<typeof SemanticMapPointSchema>;

export const SemanticMapAuthoringStatusSchema = z.enum([
  "authorable",
  "diagnostic_only",
  "unbound",
]);
export type SemanticMapAuthoringStatus = z.infer<
  typeof SemanticMapAuthoringStatusSchema
>;

export const SemanticMapDiagnosticCodeSchema = z.enum([
  "SOURCE_XODR_HASH_MISSING",
  "RUNTIME_PARITY_MISSING",
  "RUNTIME_PARITY_PARTIAL",
  "RUNTIME_PARITY_INCOMPATIBLE",
  "RUNTIME_XODR_HASH_MISMATCH",
  "RUNTIME_GRAPH_HASH_MISSING",
  "RUNTIME_LANE_UNBOUND",
  "RUNTIME_LANE_GEOMETRY_MISSING",
  "PROJECTION_IDENTITY_MISSING",
  "SEMANTIC_ID_COLLISION",
  "LANE_GEOMETRY_MISSING",
  "LANE_DIRECTION_UNRESOLVED",
  "CORRIDOR_LINK_NONRECIPROCAL",
  "CORRIDOR_BRANCH_BOUNDARY",
  "CORRIDOR_SEAM_GAP",
  "CORRIDOR_SEAM_HEADING",
  "CORRIDOR_WIDTH_DISCONTINUITY",
  "CORRIDOR_ELEVATION_DISCONTINUITY",
  "CORRIDOR_CYCLE",
  "GATE_LANE_MISSING",
  "GATE_RUNTIME_UNBOUND",
  "GATE_APPROACH_UNBOUND",
  "GATE_INTERNAL_PATH_MISSING",
  "GATE_INTERNAL_PATH_AMBIGUOUS",
  "GATE_INTERNAL_PATH_LIMIT",
  "GATE_EXIT_UNBOUND",
  "GATE_GEOMETRY_DISCONTINUITY",
  "APPROACH_CLUSTER_AMBIGUOUS",
  "APPROACH_ELEVATION_AMBIGUOUS",
  "MOVEMENT_TURN_MISMATCH",
  "CONFLICT_ENDPOINT_ONLY",
  "CONFLICT_ELEVATION_UNKNOWN",
  "CONFLICT_ZONE_AMBIGUOUS",
  "CONFLICT_ZONE_SPREAD_EXCEEDED",
]);
export type SemanticMapDiagnosticCode = z.infer<
  typeof SemanticMapDiagnosticCodeSchema
>;

export const SemanticMapDiagnosticSchema = z.object({
  code: SemanticMapDiagnosticCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  scope: z.enum([
    "graph",
    "corridor",
    "approach",
    "movement",
    "variant",
    "conflict_zone",
  ]),
  entityId: z.string().optional(),
  message: z.string(),
  laneRsls: z.array(z.string()).default([]),
  gateIds: z.array(z.string()).default([]),
  details: z.record(z.unknown()).optional(),
});
export type SemanticMapDiagnostic = z.infer<typeof SemanticMapDiagnosticSchema>;

export const SemanticMapBuildConfigSchema = z.object({
  maximumSeamGapM: z.number().positive(),
  maximumSeamHeadingDeltaRad: z.number().positive(),
  maximumSeamWidthRatio: z.number().min(1),
  maximumSeamElevationDeltaM: z.number().positive(),
  maximumApproachBoundaryDistanceM: z.number().positive(),
  maximumApproachHeadingDeltaRad: z.number().positive(),
  maximumApproachElevationDeltaM: z.number().positive(),
  maximumInternalFragments: z.number().int().positive(),
  maximumVariantsPerGate: z.number().int().positive(),
  minimumConflictAngleRad: z.number().positive(),
  conflictEndpointExclusionM: z.number().nonnegative(),
  conflictClusterRadiusM: z.number().positive(),
});
export type SemanticMapBuildConfig = z.infer<typeof SemanticMapBuildConfigSchema>;

export const RuntimeBoundLaneGeometrySchema = z.object({
  rsl: z.string(),
  storedOrder: z.enum(["road_s", "travel"]).default("road_s"),
  polyline: z.array(SemanticMapPointSchema).min(2),
  representativeWidthM: z.number().positive().nullable().default(null),
});
export type RuntimeBoundLaneGeometry = z.infer<
  typeof RuntimeBoundLaneGeometrySchema
>;

export const CorridorEndpointSchema = z.object({
  point: SemanticMapPointSchema,
  headingRad: z.number(),
  kind: z.enum(["map_boundary", "junction", "branch", "dead_end", "cycle"]),
  junctionId: z.string().nullable(),
});
export type CorridorEndpoint = z.infer<typeof CorridorEndpointSchema>;

export const CorridorSeamSchema = z.object({
  fromRsl: z.string(),
  toRsl: z.string(),
  reciprocal: z.boolean(),
  endpointGapM: z.number().nonnegative(),
  headingDeltaRad: z.number().nonnegative(),
  widthRatio: z.number().min(1).nullable(),
  elevationDeltaM: z.number().nonnegative().nullable(),
  accepted: z.boolean(),
});
export type CorridorSeam = z.infer<typeof CorridorSeamSchema>;

export const LaneCorridorSchema = z.object({
  id: z.string(),
  laneType: z.string(),
  runtimeFragments: z.array(
    z.object({
      rsl: z.string(),
      startArcM: z.number().nonnegative(),
      endArcM: z.number().nonnegative(),
    }),
  ).min(1),
  polyline: z.array(SemanticMapPointSchema).min(2),
  lengthM: z.number().nonnegative(),
  representativeWidthM: z.number().positive().nullable(),
  minWidthM: z.number().positive().nullable(),
  maxWidthM: z.number().positive().nullable(),
  speedLimitKph: z.number().nonnegative().nullable(),
  start: CorridorEndpointSchema,
  end: CorridorEndpointSchema,
  predecessorCorridorIds: z.array(z.string()),
  successorCorridorIds: z.array(z.string()),
  lateralAdjacencies: z.array(z.object({
    side: z.enum(["left", "right"]),
    targetCorridorId: z.string(),
    sameDirection: z.boolean(),
    permissionIntervals: z.array(z.object({
      startM: z.number().nonnegative(),
      endM: z.number().nonnegative(),
      allowed: z.boolean(),
      marking: z.string().nullable(),
      source: z.enum(["xodr_lane_link", "derived_same_section", "unknown"]),
    })),
  })).default([]),
  seams: z.array(CorridorSeamSchema),
  authoringStatus: SemanticMapAuthoringStatusSchema,
  diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
});
export type LaneCorridor = z.infer<typeof LaneCorridorSchema>;

export const JunctionApproachSchema = z.object({
  id: z.string(),
  junctionId: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  boundaryCenter: SemanticMapPointSchema,
  headingRad: z.number(),
  corridorIds: z.array(z.string()).min(1),
  laneSlots: z.array(z.object({
    corridorId: z.string(),
    ordinalFromLeft: z.number().int().nonnegative(),
    role: z.enum(["single", "leftmost", "inner", "rightmost", "unknown"]),
    lateralOffsetM: z.number(),
  })).min(1),
  movementIds: z.array(z.string()),
  authoringStatus: SemanticMapAuthoringStatusSchema,
  diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
});
export type JunctionApproach = z.infer<typeof JunctionApproachSchema>;

export const JunctionMovementVariantSchema = z.object({
  id: z.string(),
  movementId: z.string(),
  gateId: z.string(),
  incomingCorridorId: z.string(),
  outgoingCorridorId: z.string(),
  runtimeLaneRsls: z.array(z.string()).min(3),
  polyline: z.array(SemanticMapPointSchema).min(2),
  lengthM: z.number().nonnegative(),
  entryStationM: z.number().nonnegative(),
  exitStationM: z.number().nonnegative(),
  representativeWidthM: z.number().positive().nullable(),
  authoringStatus: SemanticMapAuthoringStatusSchema,
  diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
});
export type JunctionMovementVariant = z.infer<
  typeof JunctionMovementVariantSchema
>;

export const JunctionMovementSchema = z.object({
  id: z.string(),
  junctionId: z.string(),
  incomingApproachId: z.string(),
  outgoingApproachId: z.string(),
  turnRelation: TurnRelationSchema,
  variantIds: z.array(z.string()).min(1),
  representativeVariantId: z.string(),
  conflictZoneIds: z.array(z.string()),
  authoringStatus: SemanticMapAuthoringStatusSchema,
  diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
});
export type JunctionMovement = z.infer<typeof JunctionMovementSchema>;

export const ConflictZoneSchema = z.object({
  id: z.string(),
  junctionId: z.string(),
  kind: z.enum(["crossing", "merge", "diverge", "shared_path"]),
  movementIds: z.tuple([z.string(), z.string()]),
  center: SemanticMapPointSchema,
  radiusM: z.number().positive(),
  encounters: z.array(z.object({
    leftVariantId: z.string(),
    rightVariantId: z.string(),
    point: SemanticMapPointSchema,
    leftStationM: z.number().nonnegative(),
    rightStationM: z.number().nonnegative(),
    crossingAngleRad: z.number().nonnegative(),
    centerlineClearanceM: z.number().nonnegative(),
  })).min(1),
  authoringStatus: z.enum(["authorable", "diagnostic_only"]),
  diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
});
export type ConflictZone = z.infer<typeof ConflictZoneSchema>;

export const SemanticMapStatsSchema = z.object({
  eligibleRuntimeLanes: z.number().int().nonnegative(),
  boundRuntimeLanes: z.number().int().nonnegative(),
  corridors: z.number().int().nonnegative(),
  authorableCorridors: z.number().int().nonnegative(),
  approaches: z.number().int().nonnegative(),
  movements: z.number().int().nonnegative(),
  movementVariants: z.number().int().nonnegative(),
  conflictZones: z.number().int().nonnegative(),
  representedNonJunctionArcM: z.number().nonnegative(),
  eligibleNonJunctionArcM: z.number().nonnegative(),
  representedArcPct: z.number().min(0).max(100),
});
export type SemanticMapStats = z.infer<typeof SemanticMapStatsSchema>;

export const SemanticMapGraphSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_MAP_SCHEMA_VERSION),
  compilerVersion: z.literal(SEMANTIC_MAP_COMPILER_VERSION),
  graphRevision: z.string(),
  generatedAt: z.string(),
  source: z.object({
    mapName: z.string(),
    topologySchemaVersion: z.literal(3),
    runtimeProvenance: RuntimeTopologyProvenanceSchema,
  }),
  authority: z.enum(["runtime_verified", "diagnostic_only"]),
  authoringReady: z.boolean(),
  buildConfig: SemanticMapBuildConfigSchema,
  corridors: z.array(LaneCorridorSchema),
  approaches: z.array(JunctionApproachSchema),
  movementVariants: z.array(JunctionMovementVariantSchema),
  movements: z.array(JunctionMovementSchema),
  conflictZones: z.array(ConflictZoneSchema),
  diagnostics: z.array(SemanticMapDiagnosticSchema),
  stats: SemanticMapStatsSchema,
});
export type SemanticMapGraph = z.infer<typeof SemanticMapGraphSchema>;

export const BuildSemanticMapGraphInputSchema = z.object({
  topology: RuntimeBoundMapTopologyIndexSchema,
  runtimeLaneGeometry: z.record(z.string(), RuntimeBoundLaneGeometrySchema).default({}),
  generatedAt: z.string().optional(),
  config: SemanticMapBuildConfigSchema.partial().optional(),
});
export type BuildSemanticMapGraphInput = z.input<
  typeof BuildSemanticMapGraphInputSchema
>;
