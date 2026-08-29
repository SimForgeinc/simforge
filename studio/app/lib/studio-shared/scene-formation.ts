import { z } from "zod";
import { RuntimeTopologyFamilySchema, Vec2Schema } from "@simforge-oss/maps/topology";

const FormationVec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
}).strict();

export const SCENE_FORMATION_SCHEMA_VERSION =
  "simforge.scene-formation.v2" as const;

export const SceneFormationTransferPolicySchema = z.enum([
  "rigid",
  "lane_warped",
  "event_constrained",
]);

export const SceneFormationKindSchema = z.enum([
  "ambient_traffic",
  "vehicle_interaction",
  "pedestrian_occlusion",
  "construction_zone",
  "temporary_traffic_control",
  "emergency_scene",
  "queue_or_convoy",
  "static_hazard",
  "parking_interaction",
  "generic",
]);

export const SceneFormationAnchorSchema = z.object({
  id: z.string().trim().min(1),
  frameKind: z.enum([
    "conflict",
    "emergence",
    "corridor",
    "movement",
    "shoulder",
    "parking",
    "walking",
    "point",
  ]),
  featureId: z.string().trim().min(1).nullable().default(null),
  featureKind: z.string().trim().min(1).nullable().default(null),
  origin: FormationVec3Schema,
  tangent: Vec2Schema,
  normal: Vec2Schema,
  stationM: z.number().finite().default(0),
  lateralOriginM: z.number().finite().default(0),
  usableIntervalM: z.tuple([z.number().finite(), z.number().finite()]).nullable().default(null),
  widthM: z.number().positive().nullable().default(null),
  curvaturePerM: z.number().finite().nullable().default(null),
  grade: z.number().finite().nullable().default(null),
  runtimeBindingIds: z.array(z.string().trim().min(1)).default([]),
  laneRole: z.enum(["single", "leftmost", "inner", "rightmost", "unknown"]).nullable().optional(),
  sameDirectionLaneCount: z.number().int().positive().nullable().optional(),
  junctionExcluded: z.boolean().optional(),
  adjacentOpenLaneRequired: z.boolean().optional(),
  corridorProgress: z.number().min(0).max(1).nullable().optional(),
  corridorProgressReference: z.enum(["formation_anchor", "primary_spawn"]).nullable().optional(),
  corridorLengthM: z.number().positive().nullable().optional(),
  corridorBoundaryKinds: z.tuple([
    z.enum(["map_boundary", "junction", "branch", "dead_end", "cycle"]),
    z.enum(["map_boundary", "junction", "branch", "dead_end", "cycle"]),
  ]).nullable().optional(),
}).strict();

export const SceneFormationFootprintSchema = z.object({
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  geometryRevision: z.string().trim().min(1),
  runtimeFamily: RuntimeTopologyFamilySchema,
}).strict();

export const SceneFormationMemberPoseSchema = z.object({
  longitudinalM: z.number().finite(),
  lateralM: z.number().finite(),
  verticalM: z.number().finite().default(0),
  yawDeltaDeg: z.number().finite().default(0),
  pitchDeltaDeg: z.number().finite().default(0),
  rollDeltaDeg: z.number().finite().default(0),
}).strict();

export const SceneFormationEventSampleSchema = z.object({
  eventId: z.string().trim().min(1),
  timeS: z.number().nonnegative(),
  longitudinalM: z.number().finite(),
  lateralM: z.number().finite(),
  yawDeltaDeg: z.number().finite().default(0),
}).strict();

export const SceneFormationMemberSchema = z.object({
  sourceActorId: z.string().trim().min(1),
  kind: z.enum(["vehicle", "walker", "prop"]),
  role: z.enum(["ego", "traffic", "pedestrian", "prop"]),
  blueprint: z.string().trim().min(1),
  isStatic: z.boolean(),
  anchorId: z.string().trim().min(1),
  pose: SceneFormationMemberPoseSchema,
  footprint: SceneFormationFootprintSchema.nullable().default(null),
  requiredFeatureKinds: z.array(z.string().trim().min(1)).default([]),
  eventSamples: z.array(SceneFormationEventSampleSchema).default([]),
  pattern: z.object({
    pathLengthM: z.number().nonnegative(),
    spacingM: z.number().positive(),
    instanceCount: z.number().int().positive(),
  }).strict().nullable().default(null),
}).strict();

export const SceneFormationConstraintKindSchema = z.enum([
  "relative_pose",
  "pairwise_distance",
  "longitudinal_gap",
  "lateral_gap",
  "minimum_clearance",
  "between_members",
  "ordered_along_feature",
  "occupies_lane",
  "occupies_shoulder",
  "parked_along",
  "faces_direction",
  "crosses_path_of",
  "interacts_at_conflict",
  "keeps_headway",
  "occluded_by",
  "emerges_between",
  "visibility_transition",
  "pattern_spacing",
  "pattern_extent",
  "formation_boundary",
  "event_time",
  "time_to_conflict",
  "relative_pose_at_event",
]);

export const SceneFormationConstraintSchema = z.object({
  id: z.string().trim().min(1),
  kind: SceneFormationConstraintKindSchema,
  strength: z.enum(["hard", "soft"]),
  subjectMemberId: z.string().trim().min(1),
  observerMemberId: z.string().trim().min(1).nullable().default(null),
  objectMemberIds: z.array(z.string().trim().min(1)).default([]),
  eventId: z.string().trim().min(1).nullable().default(null),
  metric: z.enum([
    "meters",
    "degrees",
    "seconds",
    "boolean",
    "ordered",
    "pose",
    "visibility",
  ]),
  expected: z.object({
    value: z.number().finite().nullable().default(null),
    longitudinalM: z.number().finite().nullable().default(null),
    lateralM: z.number().finite().nullable().default(null),
    verticalM: z.number().finite().nullable().default(null),
    yawDeltaDeg: z.number().finite().nullable().default(null),
    timeS: z.number().nonnegative().nullable().default(null),
    boolean: z.boolean().nullable().default(null),
    order: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
  compileTolerance: z.number().nonnegative(),
  runtimeTolerance: z.number().nonnegative(),
  source: z.enum(["authored", "semantic", "inferred"]),
  reason: z.string().trim().min(1),
}).strict();

export const SceneFormationSchema = z.object({
  schemaVersion: z.literal(SCENE_FORMATION_SCHEMA_VERSION),
  id: z.string().trim().min(1),
  kind: SceneFormationKindSchema,
  transferPolicy: SceneFormationTransferPolicySchema,
  source: z.object({
    scenarioId: z.string().trim().min(1),
    mapAssetId: z.string().trim().min(1),
    mapName: z.string().trim().min(1),
    runtime: RuntimeTopologyFamilySchema,
    featureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  anchors: z.array(SceneFormationAnchorSchema).min(1),
  members: z.array(SceneFormationMemberSchema).min(1).max(32),
  constraints: z.array(SceneFormationConstraintSchema).default([]),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const SceneFormationResidualSchema = z.object({
  constraintId: z.string().trim().min(1),
  kind: SceneFormationConstraintKindSchema,
  strength: z.enum(["hard", "soft"]),
  residual: z.number().nonnegative(),
  tolerance: z.number().nonnegative(),
  passed: z.boolean(),
  details: z.record(z.unknown()).default({}),
}).strict();

export const SceneFormationSolveReportSchema = z.object({
  formationId: z.string().trim().min(1),
  formationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["exact", "adapted", "incompatible"]),
  targetAnchor: SceneFormationAnchorSchema.nullable(),
  residuals: z.array(SceneFormationResidualSchema),
  maximumHardResidualRatio: z.number().nonnegative(),
  maximumSoftResidualRatio: z.number().nonnegative(),
  runtimeVisibilityValidationRequired: z.boolean().default(false),
  diagnostics: z.array(z.string()).default([]),
}).strict();

export const SCENE_FORMATION_SOLUTION_SCHEMA_VERSION =
  "simforge.scene-formation-solution.v1" as const;

export const SceneFormationSolvedMemberSchema = z.object({
  sourceActorId: z.string().trim().min(1),
  spawn: FormationVec3Schema,
  yawDeg: z.number().finite(),
  expectedFootprint: SceneFormationFootprintSchema.nullable().default(null),
  path: z.array(FormationVec3Schema).default([]),
  timedPath: z.array(z.object({
    timeS: z.number().nonnegative(),
    position: FormationVec3Schema,
  }).strict()).default([]),
  patternSpacingM: z.number().positive().nullable().default(null),
}).strict();

/** Immutable target-side compile result persisted alongside source intent. */
export const SceneFormationSolutionSchema = z.object({
  schemaVersion: z.literal(SCENE_FORMATION_SOLUTION_SCHEMA_VERSION),
  formationId: z.string().trim().min(1),
  formationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  target: z.object({
    mapAssetId: z.string().trim().min(1),
    mapName: z.string().trim().min(1),
    runtime: RuntimeTopologyFamilySchema,
    featureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  targetAnchor: SceneFormationAnchorSchema,
  members: z.array(SceneFormationSolvedMemberSchema).min(1).max(32),
  constraints: z.array(SceneFormationConstraintSchema).default([]),
  report: SceneFormationSolveReportSchema,
  contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export type SceneFormation = z.infer<typeof SceneFormationSchema>;
export type SceneFormationAnchor = z.infer<typeof SceneFormationAnchorSchema>;
export type SceneFormationMember = z.infer<typeof SceneFormationMemberSchema>;
export type SceneFormationConstraint = z.infer<typeof SceneFormationConstraintSchema>;
export type SceneFormationResidual = z.infer<typeof SceneFormationResidualSchema>;
export type SceneFormationSolveReport = z.infer<typeof SceneFormationSolveReportSchema>;
export type SceneFormationSolution = z.infer<typeof SceneFormationSolutionSchema>;

function canonicalize(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Formation contracts require finite numbers.");
    return Math.round(value * 1_000);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalSceneFormationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
