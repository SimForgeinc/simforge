import { z } from "zod";
import { ScenarioEditorActorDraftSchema } from "./scenario-editor";
import { TurnRelationSchema, Vec2Schema } from "./map-topology/types";

export const SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION =
  "simforge.scenario-interaction-relocation.v1" as const;

export const ScenarioInteractionRelocationStatusSchema = z.enum([
  "exact_semantic",
  "adapted",
  "incompatible",
]);

export const ScenarioInteractionRelocationDiagnosticCodeSchema = z.enum([
  "SOURCE_ACTOR_COUNT_UNSUPPORTED",
  "SOURCE_ACTOR_KIND_UNSUPPORTED",
  "SOURCE_STATIC_ACTOR_UNSUPPORTED",
  "SOURCE_PLACEMENT_UNSUPPORTED",
  "SOURCE_BEHAVIOR_UNSUPPORTED",
  "SOURCE_PRIMARY_ACTOR_NOT_FOUND",
  "SOURCE_ACTOR_REFERENCE_UNRESOLVED",
  "SOURCE_JUNCTION_NOT_FOUND",
  "SOURCE_JUNCTION_AMBIGUOUS",
  "SOURCE_GATE_NOT_FOUND",
  "SOURCE_GATE_AMBIGUOUS",
  "SOURCE_CONFLICT_NOT_FOUND",
  "SOURCE_TIMING_INVALID",
  "SOURCE_TOPOLOGY_STALE",
  "TARGET_JUNCTION_NOT_FOUND",
  "TARGET_SAME_JUNCTION",
  "TARGET_POINT_TOO_FAR",
  "TARGET_SEMANTIC_GRAPH_STALE",
  "TARGET_SEMANTIC_MOVEMENT_NOT_FOUND",
  "TARGET_SEMANTIC_MOVEMENT_UNAUTHORABLE",
  "TARGET_SEMANTIC_VARIANT_NOT_FOUND",
  "TARGET_SEMANTIC_VARIANT_MISMATCH",
  "TARGET_SEMANTIC_VARIANT_UNAUTHORABLE",
  "TARGET_MOVEMENT_UNAVAILABLE",
  "TARGET_ARM_MAPPING_UNAVAILABLE",
  "TARGET_CONFLICT_NOT_FOUND",
  "TARGET_RUNUP_INSUFFICIENT",
  "TARGET_SPAWN_OVERLAP",
  "TARGET_TIMING_INFEASIBLE",
  "TARGET_CANDIDATE_OUT_OF_RANGE",
  "TARGET_ACTOR_REFERENCE_UNRESOLVED",
]);

export const ScenarioInteractionRelocationDiagnosticSchema = z.object({
  code: ScenarioInteractionRelocationDiagnosticCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  actorId: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export const ScenarioInteractionRelocationActorBindingSchema = z.object({
  actorId: z.string(),
  sourceGateId: z.string(),
  targetGateId: z.string(),
  sourceMovementId: z.string().optional(),
  sourceVariantId: z.string().optional(),
  targetMovementId: z.string().optional(),
  targetVariantId: z.string().optional(),
  sourceApproachLaneRsl: z.string(),
  targetApproachLaneRsl: z.string(),
  turnRelation: TurnRelationSchema,
  sourceArrivalTimeS: z.number().positive(),
  targetArrivalTimeS: z.number().positive(),
  sourceSpeedKph: z.number().nonnegative(),
  targetSpeedKph: z.number().nonnegative(),
});

export const ScenarioInteractionRelocationPreviewPathSchema = z.object({
  actorId: z.string(),
  points: z.array(Vec2Schema).min(2),
});

export const ScenarioInteractionRelocationCandidateSchema = z.object({
  candidateIndex: z.number().int().nonnegative(),
  targetJunctionId: z.string(),
  score: z.number().min(0).max(1),
  fidelity: z.enum(["exact_semantic", "adapted"]),
  targetConflictPoint: Vec2Schema,
  actorBindings: z.array(ScenarioInteractionRelocationActorBindingSchema).min(2),
  previewPaths: z.array(ScenarioInteractionRelocationPreviewPathSchema).min(2),
  diagnostics: z.array(ScenarioInteractionRelocationDiagnosticSchema).default([]),
});

export const ScenarioInteractionRelocationSourceSchema = z.object({
  junctionId: z.string(),
  primaryActorId: z.string(),
  conflictPoint: Vec2Schema,
  topologyXodrSha256: z.string().nullable(),
  actorBindings: z.array(
    z.object({
      actorId: z.string(),
      gateId: z.string(),
      approachLaneRsl: z.string(),
      turnRelation: TurnRelationSchema,
      arrivalTimeS: z.number().positive(),
    }),
  ),
});

export const ScenarioInteractionRelocationReportSchema = z.object({
  schemaVersion: z.literal(SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION),
  status: ScenarioInteractionRelocationStatusSchema,
  source: ScenarioInteractionRelocationSourceSchema.nullable(),
  target: z
    .object({
      junctionId: z.string(),
      conflictPoint: Vec2Schema.nullable(),
      topologyXodrSha256: z.string().nullable(),
    })
    .nullable(),
  diagnostics: z.array(ScenarioInteractionRelocationDiagnosticSchema),
  actorIdsPreserved: z.boolean(),
});

export const ScenarioInteractionRelocationRequestSchema = z.object({
  schemaVersion: z
    .literal(SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION)
    .default(SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION),
  sourceActors: z.array(ScenarioEditorActorDraftSchema).min(2).max(4),
  targetPoint: Vec2Schema,
  targetSemantic: z
    .object({
      kind: z.literal("movement"),
      graphRevision: z.string().trim().min(1),
      movementId: z.string().trim().min(1),
      variantId: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
  primaryActorId: z.string().optional(),
  candidateIndex: z.number().int().nonnegative().optional(),
  source: z
    .object({
      junctionId: z.string().optional(),
      topologyXodrSha256: z.string().nullable().optional(),
    })
    .optional(),
});

export const ScenarioInteractionRelocationResultSchema = z.object({
  schemaVersion: z.literal(SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION),
  status: ScenarioInteractionRelocationStatusSchema,
  candidates: z.array(ScenarioInteractionRelocationCandidateSchema),
  selectedCandidateIndex: z.number().int().nonnegative().nullable(),
  relocatedActors: z.array(ScenarioEditorActorDraftSchema).nullable(),
  report: ScenarioInteractionRelocationReportSchema,
  source: ScenarioInteractionRelocationSourceSchema.nullable(),
});

export type ScenarioInteractionRelocationStatus = z.infer<
  typeof ScenarioInteractionRelocationStatusSchema
>;
export type ScenarioInteractionRelocationDiagnosticCode = z.infer<
  typeof ScenarioInteractionRelocationDiagnosticCodeSchema
>;
export type ScenarioInteractionRelocationDiagnostic = z.infer<
  typeof ScenarioInteractionRelocationDiagnosticSchema
>;
export type ScenarioInteractionRelocationActorBinding = z.infer<
  typeof ScenarioInteractionRelocationActorBindingSchema
>;
export type ScenarioInteractionRelocationCandidate = z.infer<
  typeof ScenarioInteractionRelocationCandidateSchema
>;
export type ScenarioInteractionRelocationSource = z.infer<
  typeof ScenarioInteractionRelocationSourceSchema
>;
export type ScenarioInteractionRelocationReport = z.infer<
  typeof ScenarioInteractionRelocationReportSchema
>;
export type ScenarioInteractionRelocationRequest = z.infer<
  typeof ScenarioInteractionRelocationRequestSchema
>;
export type ScenarioInteractionRelocationResult = z.infer<
  typeof ScenarioInteractionRelocationResultSchema
>;
