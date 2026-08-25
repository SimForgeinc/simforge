import { z } from "zod";
import { COLLISION_FAMILY_IDS } from "./scenario-families/collision-templates";

const CollisionFamilyIdSchema = z.enum(COLLISION_FAMILY_IDS);

/**
 * Scenario validation contract (v1).
 *
 * A `ScenarioValidationReport` is the verdict of replaying a generated
 * collision-scenario draft as a deterministic fixed-dt kinematic simulation
 * (engine `"kinematic-v1"`), entirely in-process without CARLA.
 *
 * It exists to close the AI-search evaluation loop: when the LLM agent
 * proposes a draft, the builder replays the planned trajectories and asserts
 * the scenario actually does what the prompt asked — the requested conflict
 * happens, between the intended pair, near the location the user specified —
 * before the draft is ever returned to the agent or the user.
 *
 * The engine validates the *plan* (planned polylines + per-actor speed /
 * timing), not CARLA dynamics. That is deliberate: the failure modes this
 * targets ("the collision didn't happen", "the actor spawned too far from
 * the location") are geometry/timing bugs in the route planner + builder,
 * not physics-fidelity issues. UI must label a pass as "plan-validated" so
 * it is not mistaken for a CARLA simulation pass.
 */

export const SCENARIO_VALIDATION_ENGINE = "kinematic-v1" as const;

export const ValidationVerdictSchema = z.enum(["pass", "fail"]);
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export const ValidationCheckStatusSchema = z.enum(["pass", "fail", "warn"]);
export type ValidationCheckStatus = z.infer<typeof ValidationCheckStatusSchema>;

/**
 * Stable identifiers for the individual assertions. Kept as a closed enum so
 * the LLM repair path and the panel can switch on a known set rather than
 * parsing prose.
 */
const ValidationCheckIdEnum = z.enum([
  /** The intended pair came into contact within the scenario duration. */
  "collision_occurred",
  /** Contact happened within `regionRadiusM` of the intended location. */
  "collision_in_region",
  /** Contact time is within tolerance of the planned arrival time. */
  "collision_timing",
  /** The subject spawned within tolerance of the intended location. */
  "subject_spawn_offset",
  /** The conflicting actor spawned within tolerance of the intended location. */
  "target_spawn_offset",
  /** Every actor has a resolvable, non-degenerate path to drive. */
  "route_resolvable",
  /** The subject actually executes the family-defining maneuver (e.g. a left/
   *  right turn — net heading change — rather than a straight head-on). */
  "maneuver_executed",
  /** Planned actor motion stays within the shared plausibility thresholds. */
  "kinematic_lint",
]);

/**
 * Reports written before the subject rename carry `ego_spawn_offset`. They are
 * stored artifacts, so the id is normalized on read and never emitted again.
 */
export const ValidationCheckIdSchema = z.preprocess(
  (value) => (value === "ego_spawn_offset" ? "subject_spawn_offset" : value),
  ValidationCheckIdEnum,
);
export type ValidationCheckId = z.infer<typeof ValidationCheckIdEnum>;

export const ValidationPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type ValidationPoint = z.infer<typeof ValidationPointSchema>;

export const ValidationCheckSchema = z.object({
  id: ValidationCheckIdSchema,
  /** Specialized category annotation used by kinematic lint findings. */
  kind: z.literal("kinematic_lint").optional(),
  status: ValidationCheckStatusSchema,
  /** Short human-readable label for the panel chip. */
  label: z.string(),
  /** One-line explanation, safe to surface to the user and feed the agent. */
  detail: z.string(),
  /** The measured quantity this check evaluated (meters, seconds), if any. */
  measuredValue: z.number().nullable().default(null),
  /** The threshold the measurement was compared against, if any. */
  threshold: z.number().nullable().default(null),
});
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export const ValidationCollisionSchema = z.object({
  occurred: z.boolean(),
  /** Seconds since scenario start of first contact; null if no contact. */
  timeS: z.number().nullable().default(null),
  /** World point (runtime meters) of first contact; null if no contact. */
  point: ValidationPointSchema.nullable().default(null),
  /** Closing speed at contact in kph; null if no contact. */
  closingSpeedKph: z.number().nullable().default(null),
  /** Actor ids that made contact; null if no contact. */
  actorAId: z.string().nullable().default(null),
  actorBId: z.string().nullable().default(null),
});
export type ValidationCollision = z.infer<typeof ValidationCollisionSchema>;

export const ValidationActorDiagnosticSchema = z.object({
  actorId: z.string(),
  label: z.string(),
  role: z.string(),
  spawnPoint: ValidationPointSchema.nullable().default(null),
  /** Total drivable arc length of the actor's resolved path, meters. */
  pathArcLengthM: z.number().default(0),
  expectedSpeedKph: z.number().default(0),
  /** Distance from spawn to the intended location, meters (null if unknown). */
  spawnOffsetM: z.number().nullable().default(null),
  /** Did this actor reach the planned conflict point during the sim. */
  reachedConflict: z.boolean().default(false),
  /** When the actor reached the conflict point, seconds (null if never). */
  timeToConflictS: z.number().nullable().default(null),
});
export type ValidationActorDiagnostic = z.infer<typeof ValidationActorDiagnosticSchema>;

export const ValidationRepairSchema = z.object({
  attempted: z.boolean().default(false),
  /** Number of deterministic auto-tune + LLM revise attempts made. */
  attempts: z.number().int().min(0).default(0),
  succeeded: z.boolean().default(false),
  /** Ordered list of repair strategies applied, for diagnostics. */
  strategies: z.array(z.string()).default([]),
});
export type ValidationRepair = z.infer<typeof ValidationRepairSchema>;

export const ScenarioValidationReportSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.literal(SCENARIO_VALIDATION_ENGINE),
  verdict: ValidationVerdictSchema,
  family: CollisionFamilyIdSchema,
  /** Wall-clock of when the report was produced. */
  generatedAt: z.string(),
  /** Simulated horizon, seconds. */
  simulatedDurationS: z.number(),
  /** Fixed timestep used for the replay, seconds. */
  fixedDeltaS: z.number(),
  /** The pair whose contact the scenario is meant to produce. */
  intendedPair: z.object({
    subjectActorId: z.string(),
    targetActorId: z.string(),
  }),
  /** Intended scenario location (document/candidate center), runtime meters. */
  intendedLocation: ValidationPointSchema.nullable().default(null),
  /** Radius around `intendedLocation` a collision must fall inside. */
  regionRadiusM: z.number(),
  collision: ValidationCollisionSchema,
  /** Closest the intended pair ever got, meters (0 when they collided). */
  minPairwiseDistanceM: z.number(),
  checks: z.array(ValidationCheckSchema).default([]),
  actorDiagnostics: z.array(ValidationActorDiagnosticSchema).default([]),
  /** Machine-then-human fail reasons, ordered by severity. Empty on pass.
   *  Fed verbatim to the LLM repair path and rendered in the panel. */
  reasons: z.array(z.string()).default([]),
  repair: ValidationRepairSchema.nullable().default(null),
});
export type ScenarioValidationReport = z.infer<typeof ScenarioValidationReportSchema>;
