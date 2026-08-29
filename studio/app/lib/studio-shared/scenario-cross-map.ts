import { z } from "zod";
import { CrossMapVariationRelaxationSchema } from "./carla-blueprint-substitution";
import { JunctionSignalPlanSchema, type JunctionSignalPlan } from "./scenario-signals";
import { ScenarioEditorActorDraftSchema } from "./scenario-editor";
import { RuntimeTopologyFamilySchema, Vec2Schema } from "@simforge-oss/maps/topology";
import {
  SceneFormationSchema,
  SceneFormationSolveReportSchema,
  SceneFormationSolutionSchema,
} from "./scene-formation";

export const CROSS_MAP_SCENE_MOTIF_SCHEMA_VERSION =
  "simforge.cross-map-scene-motif.v2" as const;
export const CROSS_MAP_VARIATION_SCHEMA_VERSION =
  "simforge.cross-map-variation.v2" as const;

export const CrossMapVariationConstraintSettingsSchema = z.object({
  preserveActorSpacing: z.boolean().default(true),
  preserveInteractionTiming: z.boolean().default(true),
  preserveActorTimelines: z.boolean().default(true),
  preserveHeadingAlignment: z.boolean().default(true),
  preserveSemanticContext: z.boolean().default(true),
}).strict();
export type CrossMapVariationConstraintSettings = z.infer<
  typeof CrossMapVariationConstraintSettingsSchema
>;

export const CrossMapMotifActorBehaviorSchema = z.enum([
  "junction_movement",
  "corridor_route",
  "parked_vehicle",
  "pedestrian_crossing",
  "static_prop",
]);

export const CrossMapMotifActorSchema = z.object({
  sourceActorId: z.string().trim().min(1),
  kind: z.enum(["vehicle", "walker", "prop"]),
  role: z.enum(["ego", "traffic", "pedestrian", "prop"]),
  isStatic: z.boolean(),
  behavior: CrossMapMotifActorBehaviorSchema,
  sourcePathLengthM: z.number().nonnegative(),
  sourceDurationS: z.number().nonnegative(),
  speedKph: z.number().nonnegative(),
  requiredFeatureKinds: z.array(z.string()).default([]),
  properties: z.record(z.unknown()).default({}),
}).strict();

export const CrossMapMotifRelationSchema = z.object({
  kind: z.enum([
    "interacts_at_conflict",
    "parked_along",
    "emerges_from_behind",
    "crosses_path_of",
    "occludes_from",
    "keeps_relative_side",
    "maneuvers_near",
  ]),
  subjectActorId: z.string().trim().min(1),
  objectActorId: z.string().trim().min(1).nullable().default(null),
  featureKind: z.string().trim().min(1).nullable().default(null),
  side: z.enum(["left", "right", "either"]).nullable().default(null),
  headingRelation: z.enum(["same", "opposing", "crossing"]).nullable().default(null),
  longitudinalOffsetM: z.number().finite().nullable().default(null),
  lateralOffsetM: z.number().finite().nullable().default(null),
  eventTimeS: z.number().nonnegative().nullable().default(null),
  tolerance: z.number().nonnegative().nullable().default(null),
}).strict();

export const CrossMapSceneMotifSchema = z.object({
  schemaVersion: z.literal(CROSS_MAP_SCENE_MOTIF_SCHEMA_VERSION),
  motifHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source: z.object({
    scenarioId: z.string().trim().min(1),
    mapAssetId: z.string().trim().min(1),
    mapName: z.string().trim().min(1),
    runtime: RuntimeTopologyFamilySchema,
    featureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  primaryActorId: z.string().trim().min(1),
  actors: z.array(CrossMapMotifActorSchema).min(1).max(32),
  relations: z.array(CrossMapMotifRelationSchema).default([]),
  formations: z.array(SceneFormationSchema).min(1),
  formationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceDraftHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  sourceBehaviorHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  timingToleranceS: z.number().positive().default(1),
  spatialToleranceM: z.number().positive().default(3),
}).strict();
export type CrossMapSceneMotif = z.infer<typeof CrossMapSceneMotifSchema>;

/**
 * Explicitly annotated (Input widened to `unknown`): the refined
 * `JunctionSignalPlanSchema` object pushes the inferred preview-response type
 * past the compiler's serialization cap (TS7056). Runtime behavior is the
 * plain `z.array(JunctionSignalPlanSchema).default([])`.
 */
const CrossMapSignalPlansFieldSchema: z.ZodType<
  JunctionSignalPlan[],
  z.ZodTypeDef,
  unknown
> = z.array(JunctionSignalPlanSchema).default([]);

export const CrossMapVariationDiagnosticSchema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().trim().min(1),
  actorId: z.string().nullable().optional(),
  featureId: z.string().nullable().optional(),
  details: z.record(z.unknown()).optional(),
}).strict();

export const CrossMapVariationMatchSchema = z.object({
  matchId: z.string().trim().min(1),
  targetMapAssetId: z.string().trim().min(1),
  targetMapName: z.string().trim().min(1),
  runtime: RuntimeTopologyFamilySchema,
  featureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["matched", "incompatible"]),
  fidelity: z.enum(["exact_semantic", "adapted", "incompatible"]),
  score: z.number().min(0).max(1),
  targetAnchor: Vec2Schema.nullable(),
  targetJunctionId: z.string().nullable(),
  actors: z.array(ScenarioEditorActorDraftSchema).nullable(),
  diagnostics: z.array(CrossMapVariationDiagnosticSchema),
  /** Documented relaxations applied to make this target feasible (e.g.
   * class-preserving blueprint substitution). Empty when the transfer needed
   * no relaxation. */
  relaxations: z.array(CrossMapVariationRelaxationSchema).default([]),
  /**
   * Signal plans rebuilt on the TARGET junction's movement table for this
   * match (empty when the source authored none, or when every plan was
   * dropped — each drop then appears in `relaxations`). Materialize persists
   * these verbatim onto the created draft; the source plans are keyed by the
   * source map's junction/movement ids and are never carried over.
   */
  signalPlans: CrossMapSignalPlansFieldSchema,
  selectedFeatureIds: z.array(z.string()).default([]),
  formationContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  formationReports: z.array(SceneFormationSolveReportSchema).default([]),
  formationSolutions: z.array(SceneFormationSolutionSchema).default([]),
  runtimeVerificationRequired: z.boolean().default(false),
}).strict();
export type CrossMapVariationMatch = z.infer<typeof CrossMapVariationMatchSchema>;

export const CrossMapVariationPreviewRequestSchema = z.object({
  schemaVersion: z.literal(CROSS_MAP_VARIATION_SCHEMA_VERSION).default(
    CROSS_MAP_VARIATION_SCHEMA_VERSION,
  ),
  targetMapAssetIds: z.array(z.string().trim().min(1)).length(1),
  maxVariationsPerMap: z.number().int().min(1).max(8).default(1),
  constraints: CrossMapVariationConstraintSettingsSchema.default({
    preserveActorSpacing: true,
    preserveInteractionTiming: true,
    preserveActorTimelines: true,
    preserveHeadingAlignment: true,
    preserveSemanticContext: true,
  }),
}).strict();

/** Same TS7056 cap as `CrossMapSignalPlansFieldSchema`: annotate the array so
 * the response node's inferred type stays serializable. */
const CrossMapVariationMatchesFieldSchema: z.ZodType<
  CrossMapVariationMatch[],
  z.ZodTypeDef,
  unknown
> = z.array(CrossMapVariationMatchSchema);

export const CrossMapVariationPreviewResponseSchema = z.object({
  schemaVersion: z.literal(CROSS_MAP_VARIATION_SCHEMA_VERSION),
  motif: CrossMapSceneMotifSchema,
  matches: CrossMapVariationMatchesFieldSchema,
  generatedAt: z.string(),
}).strict();

export const CrossMapVariationMaterializeRequestSchema = z.object({
  schemaVersion: z.literal(CROSS_MAP_VARIATION_SCHEMA_VERSION).default(
    CROSS_MAP_VARIATION_SCHEMA_VERSION,
  ),
  datasetId: z.string().trim().min(1).optional(),
  motifHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  constraints: CrossMapVariationConstraintSettingsSchema.default({
    preserveActorSpacing: true,
    preserveInteractionTiming: true,
    preserveActorTimelines: true,
    preserveHeadingAlignment: true,
    preserveSemanticContext: true,
  }),
  matches: z.array(z.object({
    matchId: z.string().trim().min(1),
    targetMapAssetId: z.string().trim().min(1),
    displayName: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.matches.map((match) => match.targetMapAssetId)).size > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matches"],
      message: "Materialize one target map per request.",
    });
  }
});

export const CrossMapVariationMaterializeResponseSchema = z.object({
  schemaVersion: z.literal(CROSS_MAP_VARIATION_SCHEMA_VERSION),
  sourceScenarioId: z.string(),
  datasetId: z.string().nullable(),
  created: z.array(z.object({
    matchId: z.string(),
    scenarioId: z.string(),
    mapAssetId: z.string(),
    displayName: z.string(),
    /** Relaxations carried over from the materialized preview match. */
    relaxations: z.array(CrossMapVariationRelaxationSchema).default([]),
  }).strict()),
}).strict();

export type CrossMapVariationPreviewRequest = z.infer<
  typeof CrossMapVariationPreviewRequestSchema
>;
export type CrossMapVariationPreviewResponse = z.infer<
  typeof CrossMapVariationPreviewResponseSchema
>;
export type CrossMapVariationMaterializeRequest = z.infer<
  typeof CrossMapVariationMaterializeRequestSchema
>;
export type CrossMapVariationMaterializeResponse = z.infer<
  typeof CrossMapVariationMaterializeResponseSchema
>;
