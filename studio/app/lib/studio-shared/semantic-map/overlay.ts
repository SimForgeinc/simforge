import { z } from "zod";
import { RuntimeTopologyProvenanceSchema, TurnRelationSchema, Vec2Schema } from "@simforge-oss/maps/topology";
import {
  SemanticMapAuthoringStatusSchema,
  SemanticMapDiagnosticCodeSchema,
} from "./types";
import {
  SemanticFeatureGeometrySchema,
  SemanticFeatureKindSchema,
  SemanticFeatureSourceSchema,
} from "./feature-graph";

export const SEMANTIC_MAP_OVERLAY_SCHEMA_VERSION =
  "simforge.semantic-map-overlay.v1" as const;

const OverlayPolylineSchema = z.array(Vec2Schema).min(2);

export const SemanticMapOverlaySchema = z.object({
  schemaVersion: z.literal(SEMANTIC_MAP_OVERLAY_SCHEMA_VERSION),
  graphRevision: z.string(),
  compilerVersion: z.string(),
  runtimeProvenance: RuntimeTopologyProvenanceSchema,
  authority: z.enum(["runtime_verified", "diagnostic_only"]),
  authoringReady: z.boolean(),
  viewport: z.object({
    minX: z.number(),
    minY: z.number(),
    maxX: z.number(),
    maxY: z.number(),
  }),
  corridors: z.array(z.object({
    id: z.string(),
    polyline: OverlayPolylineSchema,
    lengthM: z.number().nonnegative(),
    representativeWidthM: z.number().positive().nullable(),
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
    authoringStatus: SemanticMapAuthoringStatusSchema,
    diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
  })),
  approaches: z.array(z.object({
    id: z.string(),
    junctionId: z.string(),
    direction: z.enum(["incoming", "outgoing"]),
    boundaryCenter: Vec2Schema,
    headingRad: z.number(),
    corridorIds: z.array(z.string()),
    laneSlots: z.array(z.object({
      corridorId: z.string(),
      ordinalFromLeft: z.number().int().nonnegative(),
      role: z.enum(["single", "leftmost", "inner", "rightmost", "unknown"]),
    })),
    movementIds: z.array(z.string()),
    authoringStatus: SemanticMapAuthoringStatusSchema,
    diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
  })),
  movementVariants: z.array(z.object({
    id: z.string(),
    movementId: z.string(),
    incomingCorridorId: z.string(),
    outgoingCorridorId: z.string(),
    polyline: OverlayPolylineSchema,
    authoringStatus: SemanticMapAuthoringStatusSchema,
    diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
  })),
  movements: z.array(z.object({
    id: z.string(),
    junctionId: z.string(),
    incomingApproachId: z.string(),
    outgoingApproachId: z.string(),
    turnRelation: TurnRelationSchema,
    variantIds: z.array(z.string()),
    representativeVariantId: z.string(),
    conflictZoneIds: z.array(z.string()),
    authoringStatus: SemanticMapAuthoringStatusSchema,
    diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
  })),
  conflictZones: z.array(z.object({
    id: z.string(),
    junctionId: z.string(),
    kind: z.enum(["crossing", "merge", "diverge", "shared_path"]),
    movementIds: z.tuple([z.string(), z.string()]),
    center: Vec2Schema,
    radiusM: z.number().positive(),
    authoringStatus: z.enum(["authorable", "diagnostic_only"]),
    diagnosticCodes: z.array(SemanticMapDiagnosticCodeSchema),
  })),
  environmentFeatures: z.array(z.object({
    id: z.string(),
    kind: SemanticFeatureKindSchema,
    label: z.string(),
    geometry: SemanticFeatureGeometrySchema,
    primarySource: SemanticFeatureSourceSchema,
    runtimeBindingStatus: z.enum(["exact", "projected", "unbound"]),
    authoringStatus: z.enum(["authorable", "candidate", "diagnostic_only"]),
    diagnosticCodes: z.array(z.string()),
  }).strict()).default([]),
});
export type SemanticMapOverlay = z.infer<typeof SemanticMapOverlaySchema>;
