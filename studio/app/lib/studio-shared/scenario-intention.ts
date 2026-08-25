import { z } from "zod";

export const SCENARIO_INTENTION_SCHEMA_VERSION =
  "simforge.scenario-intention.v1" as const;

export const ScenarioIntentionSubjectSchema = z.enum([
  "none",
  "vehicle",
  "pedestrian",
  "bicycle",
  "motorcycle",
]);

export const ScenarioIntentionOutcomeSchema = z.enum([
  "nominal",
  "collision",
  "collision_avoidance",
  "near_miss",
]);

/**
 * Context vocabulary from docs/automated-scenario-creation.md §2. The stored
 * ids use underscores while `category` carries the reader-facing wording.
 */
export const ScenarioIntentionContextSchema = z.enum([
  "unprotected_left",
  "right_turn",
  "junction_crossing",
  "mid_block",
  "occluded",
  "lane_change",
  "overtake",
  "stop_sign",
  "highway",
  "rear_approach",
  "adjacent_lane",
]);

export const ScenarioIntentionModifiersSchema = z
  .object({
    traffic: z.enum(["normal", "medium", "heavy"]),
    parked: z.enum(["none", "light", "moderate", "heavy"]),
    weather: z.enum(["clear", "wet_raining"]),
    occlusion: z
      .enum(["bus_stop", "delivery_truck", "parked_car"])
      .nullable(),
    heavy_lead: z.boolean(),
    signalized: z.boolean(),
  })
  .strict();

export const ScenarioExpectedBehaviorSchema = z
  .object({
    primary_action: z.string().trim().min(1),
    resume_allowed: z.boolean(),
  })
  .strict();

/**
 * Emit-time scenario-intention record specified in
 * docs/automated-scenario-creation.md §2.3.
 */
export const ScenarioIntentionSchema = z
  .object({
    schema_version: z.literal(SCENARIO_INTENTION_SCHEMA_VERSION),
    subject: ScenarioIntentionSubjectSchema,
    outcome: ScenarioIntentionOutcomeSchema,
    context: ScenarioIntentionContextSchema,
    category: z.string().trim().min(1),
    primary_maneuver_category: z.string().trim().min(1),
    alpamayo_causal_category: z.string().trim().min(1),
    failure_mode_target: z.string().trim().min(1),
    modifiers: ScenarioIntentionModifiersSchema,
    nav_prompt: z.string().trim().min(1),
    reasoning_hint: z.string().trim().min(1),
    expected_behavior: ScenarioExpectedBehaviorSchema,
    success_criteria: z.array(z.string().trim().min(1)).min(1),
    /**
     * Which CoT kind the scene's run artifacts are expected to carry.
     * "event_grounded" = the run-derived cot.json sidecar
     * (services/carla-worker/carla_worker/cot_narration.py) — narration
     * derived from scenario_events.json + actor_track.json, every sentence
     * evidence-backed. Absent on scenes emitted before the marker existed
     * (their CoT, if any, is the plan-derived legacy layer).
     */
    cot_kind: z.literal("event_grounded").optional(),
  })
  .strict();

export type ScenarioIntention = z.infer<typeof ScenarioIntentionSchema>;

/**
 * Progressive authoring contract: every field is optional for hand-authored
 * editor drafts. Generated scenarios are checked against the required form at
 * their emit boundary.
 */
export const ActorBehaviorMetadataSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    behavior_intent: z.string().trim().min(1).optional(),
    behavior_class: z
      .enum([
        "compliant",
        "imperfect_plausible",
        "violating",
        "adversarial",
        "infeasible_diagnostic",
      ])
      .optional(),
    control_mode: z
      .enum(["open_loop", "closed_loop", "traffic_manager", "reactive"])
      .optional(),
    trajectory_mode: z.enum(["position", "follow"]).optional(),
  })
  .strict();

export type ActorBehaviorMetadata = z.infer<
  typeof ActorBehaviorMetadataSchema
>;

/** Required generated-output form used by emit-time enforcement. */
export const GeneratedActorBehaviorMetadataSchema =
  ActorBehaviorMetadataSchema.required();
export type GeneratedActorBehaviorMetadata = z.infer<
  typeof GeneratedActorBehaviorMetadataSchema
>;
