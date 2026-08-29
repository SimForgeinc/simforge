/** Portable contracts for local esmini validation and repair attempts. */
import { z } from "zod";
import { ScenarioLintCompactReportSchema } from "./scenario-lint/summary";

export const ScenarioValidationJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
]);
export type ScenarioValidationJobStatus = z.infer<
  typeof ScenarioValidationJobStatusSchema
>;

export const ScenarioValidationJobPurposeSchema = z.enum([
  "validation",
  "export_replay",
]);
export type ScenarioValidationJobPurpose = z.infer<
  typeof ScenarioValidationJobPurposeSchema
>;

/**
 * `pass` and `fail` are the binary outcomes the orchestrator branches on.
 * `inconclusive` is reserved for cases where esmini ran cleanly but the
 * metrics extractor could not decide (e.g. the intended collision is outside
 * the simulation horizon); these surface as advisory failures.
 */
export const ScenarioValidationVerdictSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
]);
export type ScenarioValidationVerdict = z.infer<
  typeof ScenarioValidationVerdictSchema
>;

/**
 * Tags the *origin* of an attempt so the UI can surface a "why this needed
 * repair" trace and so we can measure repair efficacy in production. The
 * initial attempt is `initial`; subsequent rows are tagged with the specific
 * deterministic adjustment that produced them, or `llm` when the LLM repaired
 * the plan.
 */
const ScenarioValidationRepairKindEnum = z.enum([
  "initial",
  "scale_spawn_distance",
  "scale_npc_speed",
  "snap_spawn_to_drivable",
  "rerun_pedestrian_timing",
  // Nudge the conflict pedestrian's spawn + curb-hold waypoints toward the road
  // when a 2D run flags `ped_incomplete` (the ped wedged on non-navmesh) so it
  // steps off onto reachable mesh and completes the crossing.
  "nudge_pedestrian_path",
  // Shift the conflict NPC vehicle's absolute waypoint TIMES (turn families) —
  // spawn-distance / speed scaling are no-ops for an absolute-timed FollowTrajectory.
  "retime_npc",
  // SPATIAL repair (turn families): rigid-translate the conflict NPC's path so
  // it crosses the subject's OBSERVED closest-approach point. Turning subjects
  // drive a CARLA-native arc that passes ~3-4m from the PLANNED conflict point;
  // when timing is already aligned, no retime can close the lateral gap
  // (collision-regen 2026-07-06: left-turn misses pinned at a 3.0-4.0m floor).
  "shift_npc_path",
  "retime_subject",
  "llm",
]);

/**
 * Repair records written before the subject rename carry `retime_ego`. They are
 * stored job history, so the kind is normalized on read and never emitted again.
 */
export const ScenarioValidationRepairKindSchema = z.preprocess(
  (value) => (value === "retime_ego" ? "retime_subject" : value),
  ScenarioValidationRepairKindEnum,
);
export type ScenarioValidationRepairKind = z.infer<
  typeof ScenarioValidationRepairKindEnum
>;

/**
 * Per-actor trajectory point parsed out of the esmini state log. Time is in
 * simulation seconds, position in OpenDRIVE world coordinates (meters), yaw
 * in radians, speed in m/s. We use the same conventions as the writer so the
 * round-trip is trivial.
 */
export const EsminiTrajectoryPointSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  yaw: z.number(),
  speed: z.number(),
});
export type EsminiTrajectoryPoint = z.infer<typeof EsminiTrajectoryPointSchema>;

export const EsminiActorTrajectorySchema = z.object({
  actor_id: z.string(),
  points: z.array(EsminiTrajectoryPointSchema),
});
export type EsminiActorTrajectory = z.infer<typeof EsminiActorTrajectorySchema>;

/**
 * A collision event reported by esmini. The pair is unordered so the
 * deterministic repair can match against actor roles without caring which
 * actor esmini called "A". `ttc_at_trigger_s` is the TTC at the moment the
 * collision event fired (~0 by definition); it is included for completeness
 * because some downstream callers want it explicitly.
 */
export const EsminiCollisionEventSchema = z.object({
  t: z.number(),
  actor_a: z.string(),
  actor_b: z.string(),
  point: z.object({ x: z.number(), y: z.number() }),
  relative_speed_mps: z.number(),
  ttc_at_trigger_s: z.number(),
});
export type EsminiCollisionEvent = z.infer<typeof EsminiCollisionEventSchema>;

/** Aggregate metrics produced by a local headless esmini validation run. */
export const EsminiValidationMetricsSchema = z.object({
  duration_s: z.number(),
  actor_trajectories: z.array(EsminiActorTrajectorySchema),
  collisions: z.array(EsminiCollisionEventSchema),
  /**
   * Report-only kinematic plausibility findings from the parsed trajectories.
   * New summaries always include this block; it remains optional at the read
   * boundary because already-persisted validation attempts predate M1.2.
   */
  lint: ScenarioLintCompactReportSchema.optional(),
  /**
   * Smallest absolute distance (meters) between *any* pair of actors over
   * the whole rollout, with the (actors, time) at which it occurred.
   */
  min_distance: z
    .object({
      meters: z.number(),
      t: z.number(),
      actor_a: z.string(),
      actor_b: z.string(),
    })
    .nullable(),
  /**
   * Constant-velocity time to predicted closest approach, computed at every
   * saved step and guarded by the conflict corridor. The minimum (with which
   * actors and at what time) is reported. Null when no qualifying closing
   * trajectory existed.
   */
  min_ttc: z
    .object({
      seconds: z.number(),
      t: z.number(),
      actor_a: z.string(),
      actor_b: z.string(),
    })
    .nullable(),
  /**
   * Post-encroachment time (seconds) at the closest spatial conflict zone.
   * Null when no pair of actor paths traverses the shared 4 m corridor.
   * Optional so metrics persisted before PET was introduced remain readable.
   */
  pet_s: z.number().nullable().optional(),
  /**
   * Free-form diagnostic field for esmini's exit code, parse warnings, or
   * runner anomalies. Surfaced to the UI under a collapsed "details" toggle.
   */
  warnings: z.array(z.string()).default([]),
});
export type EsminiValidationMetrics = z.infer<typeof EsminiValidationMetricsSchema>;

/** One local validation attempt projected for Studio consumption. */
export const ScenarioValidationJobSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  purpose: ScenarioValidationJobPurposeSchema,
  attempt: z.number().int(),
  status: ScenarioValidationJobStatusSchema,
  verdict: ScenarioValidationVerdictSchema.nullable(),
  repair_kind: ScenarioValidationRepairKindSchema.nullable(),
  metrics: EsminiValidationMetricsSchema.nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type ScenarioValidationJob = z.infer<typeof ScenarioValidationJobSchema>;

/** Expected outcome of the scripted esmini rollout. */
export type EsminiExpectedOutcome = "collision" | "near_miss";
