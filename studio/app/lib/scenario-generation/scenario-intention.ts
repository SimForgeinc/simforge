import {
  GeneratedActorBehaviorMetadataSchema,
  GeneratedScenarioMetadataSchema,
  ScenarioIntentionSchema,
  baseClip,
  type CollisionFamilyId,
  type GeneratedActorBehaviorMetadata,
  type GeneratedScenarioMetadata,
  type RuntimeScenarioEditorActor,
  type ScenarioEditorActorDraft,
  type ScenarioIntention,
} from "@simforge-oss/studio-shared";
import {
  buildScenarioMetadata,
  type ScenarioMetadataSoftwareVersions,
} from "./scenario-metadata";
export { buildScenarioMetadata } from "./scenario-metadata";

export const NOMINAL_STRATEGY_IDS = [
  "lane_keep",
  "lane_change_left",
  "lane_change_right",
  "overtake_left",
  "overtake_right",
  "turn_left",
  "turn_right",
  "stop",
  "stop_at_stop_sign",
  "stop_at_yield_sign",
  "stop_at_traffic_light",
  "stop_at_uncontrolled",
  "queue_creep",
  "highway_lane_keep",
  "highway_lane_change_left",
  "highway_lane_change_right",
  "highway_exit",
  "highway_entry",
  "highway_queue_creep",
] as const;

export type NominalStrategyId = (typeof NOMINAL_STRATEGY_IDS)[number];

type IntentionDescriptor = {
  context: ScenarioIntention["context"];
  primaryManeuver: string;
  causalCategory: string;
  navPrompt: string;
  reasoningHint: string;
  primaryAction: string;
  resumeAllowed: boolean;
  successCriteria: readonly string[];
  subjectBehaviorIntent: string;
};

const COMMON_NOMINAL_SUCCESS = [
  "no_collision",
  "on_road",
  "route_followed",
  "stable_final_pose",
];

export const NOMINAL_STRATEGY_INTENTION = {
  lane_keep: {
    context: "mid_block",
    primaryManeuver: "lane_keep",
    causalCategory: "plain_route_following",
    navPrompt: "Continue straight and stay in your current lane.",
    reasoningHint: "The route continues along the current lane with no staged conflict.",
    primaryAction: "follow_lane",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "lane_centered"],
    subjectBehaviorIntent: "follow_lane",
  },
  lane_change_left: {
    context: "lane_change",
    primaryManeuver: "lane_change_left",
    causalCategory: "lane_change",
    navPrompt: "When there is a safe gap, change one lane to the left and continue.",
    reasoningHint: "The route calls for a controlled merge into the lane on the left.",
    primaryAction: "merge_left",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "target_lane_reached"],
    subjectBehaviorIntent: "merge",
  },
  lane_change_right: {
    context: "lane_change",
    primaryManeuver: "lane_change_right",
    causalCategory: "lane_change",
    navPrompt: "When there is a safe gap, change one lane to the right and continue.",
    reasoningHint: "The route calls for a controlled merge into the lane on the right.",
    primaryAction: "merge_right",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "target_lane_reached"],
    subjectBehaviorIntent: "merge",
  },
  overtake_left: {
    context: "overtake",
    primaryManeuver: "lane_change_left",
    causalCategory: "slow_for_lead_vehicle",
    navPrompt: "Pass the slower lead vehicle on the left when there is a safe gap.",
    reasoningHint: "A slower lead vehicle motivates the passing maneuver.",
    primaryAction: "overtake_left",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "lead_vehicle_passed"],
    subjectBehaviorIntent: "overtake",
  },
  overtake_right: {
    context: "overtake",
    primaryManeuver: "lane_change_right",
    causalCategory: "slow_for_lead_vehicle",
    navPrompt: "Pass the slower lead vehicle on the right when there is a safe gap.",
    reasoningHint: "A slower lead vehicle motivates the passing maneuver.",
    primaryAction: "overtake_right",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "lead_vehicle_passed"],
    subjectBehaviorIntent: "overtake",
  },
  turn_left: {
    context: "unprotected_left",
    primaryManeuver: "turn_left",
    causalCategory: "plain_route_following",
    navPrompt: "Yield as required and make the upcoming left turn.",
    reasoningHint: "The navigation route requires a left turn through the junction.",
    primaryAction: "turn_left",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "turn_completed_into_receiving_lane"],
    subjectBehaviorIntent: "turn_across_path",
  },
  turn_right: {
    context: "right_turn",
    primaryManeuver: "turn_right",
    causalCategory: "plain_route_following",
    navPrompt: "Yield as required and make the upcoming right turn.",
    reasoningHint: "The navigation route requires a right turn through the junction.",
    primaryAction: "turn_right",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "turn_completed_into_receiving_lane"],
    subjectBehaviorIntent: "turn_across_path",
  },
  stop: {
    context: "mid_block",
    primaryManeuver: "stop",
    causalCategory: "stop_for_lead_vehicle",
    navPrompt: "Stop for the constraint ahead, then continue when the way is clear.",
    reasoningHint: "A visible road user or control requires the subject to stop safely.",
    primaryAction: "stop_then_resume",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "valid_stop", "safe_stopping_gap"],
    subjectBehaviorIntent: "yield",
  },
  stop_at_stop_sign: {
    context: "stop_sign",
    primaryManeuver: "stop",
    causalCategory: "stop_for_traffic_light_or_sign",
    navPrompt: "Come to a complete stop at the stop sign, then proceed when clear.",
    reasoningHint: "The stop sign controls the subject approach.",
    primaryAction: "stop_at_sign",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "stopped_before_stop_line"],
    subjectBehaviorIntent: "stop_at_signal",
  },
  stop_at_yield_sign: {
    context: "junction_crossing",
    primaryManeuver: "stop",
    causalCategory: "stop_for_traffic_light_or_sign",
    navPrompt: "Yield at the upcoming sign, stopping if needed, then proceed when clear.",
    reasoningHint: "The yield sign controls the subject approach.",
    primaryAction: "yield_at_sign",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "yield_control_obeyed"],
    subjectBehaviorIntent: "yield",
  },
  stop_at_traffic_light: {
    context: "junction_crossing",
    primaryManeuver: "stop",
    causalCategory: "stop_for_traffic_light_or_sign",
    navPrompt: "Stop for the traffic light when required, then proceed on a permissive signal.",
    reasoningHint: "The traffic light controls whether the subject may enter the junction.",
    primaryAction: "stop_at_signal",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "traffic_signal_obeyed"],
    subjectBehaviorIntent: "stop_at_signal",
  },
  stop_at_uncontrolled: {
    context: "junction_crossing",
    primaryManeuver: "lane_keep",
    causalCategory: "plain_route_following",
    navPrompt: "Check for other road users and proceed through the uncontrolled junction.",
    reasoningHint: "The junction has no attributed control, so the subject must proceed cautiously.",
    primaryAction: "proceed_cautiously",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "junction_cleared"],
    subjectBehaviorIntent: "follow_lane",
  },
  queue_creep: {
    context: "mid_block",
    primaryManeuver: "queue_creep",
    causalCategory: "stop_for_lead_vehicle",
    navPrompt: "Follow the stop-and-go queue, moving only when a safe gap opens.",
    reasoningHint: "Queued lead vehicles create a repeated stop-and-creep constraint.",
    primaryAction: "queue_creep",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "safe_following_gap", "queue_progress"],
    subjectBehaviorIntent: "follow_lane",
  },
  highway_lane_keep: {
    context: "highway",
    primaryManeuver: "highway_lane_keep",
    causalCategory: "plain_route_following",
    navPrompt: "Continue along the highway in the current lane at a safe speed.",
    reasoningHint: "The route continues along a highway corridor.",
    primaryAction: "follow_highway_lane",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "lane_centered"],
    subjectBehaviorIntent: "follow_lane",
  },
  highway_lane_change_left: {
    context: "highway",
    primaryManeuver: "highway_lane_change_left",
    causalCategory: "lane_change",
    navPrompt: "When safe, change one highway lane to the left and continue.",
    reasoningHint: "The highway route calls for a controlled merge to the left.",
    primaryAction: "merge_left",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "target_lane_reached"],
    subjectBehaviorIntent: "merge",
  },
  highway_lane_change_right: {
    context: "highway",
    primaryManeuver: "highway_lane_change_right",
    causalCategory: "lane_change",
    navPrompt: "When safe, change one highway lane to the right and continue.",
    reasoningHint: "The highway route calls for a controlled merge to the right.",
    primaryAction: "merge_right",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "target_lane_reached"],
    subjectBehaviorIntent: "merge",
  },
  highway_exit: {
    context: "highway",
    primaryManeuver: "highway_lane_change_right",
    causalCategory: "lane_change_preparation",
    navPrompt: "Take the upcoming highway exit and slow appropriately for the ramp.",
    reasoningHint: "The navigation route leaves the highway through the exit ramp.",
    primaryAction: "take_highway_exit",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "exit_ramp_reached"],
    subjectBehaviorIntent: "merge",
  },
  highway_entry: {
    context: "highway",
    primaryManeuver: "highway_lane_change_left",
    causalCategory: "lane_change_preparation",
    navPrompt: "Use the on-ramp and merge onto the highway when a safe gap opens.",
    reasoningHint: "The navigation route enters the highway through a merge ramp.",
    primaryAction: "merge_onto_highway",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "highway_lane_reached"],
    subjectBehaviorIntent: "merge",
  },
  highway_queue_creep: {
    context: "highway",
    primaryManeuver: "highway_queue_creep",
    causalCategory: "stop_for_lead_vehicle",
    navPrompt: "Follow the stop-and-go highway queue while maintaining a safe gap.",
    reasoningHint: "Congested highway traffic creates a repeated stop-and-creep constraint.",
    primaryAction: "queue_creep",
    resumeAllowed: true,
    successCriteria: [...COMMON_NOMINAL_SUCCESS, "safe_following_gap", "queue_progress"],
    subjectBehaviorIntent: "follow_lane",
  },
} as const satisfies Record<NominalStrategyId, IntentionDescriptor>;

type CollisionDescriptor = IntentionDescriptor & {
  subject: ScenarioIntention["subject"];
  principalBehaviorIntent: string;
  principalBehaviorClass:
    | "compliant"
    | "imperfect_plausible"
    | "violating"
    | "adversarial";
};

const COLLISION_FAMILY_INTENTION_BASE = {
  unprotected_left_turn: {
    subject: "vehicle",
    context: "unprotected_left",
    primaryManeuver: "turn_left",
    causalCategory: "yield_to_vru_or_vehicle",
    navPrompt: "Yield to oncoming traffic and complete the unprotected left turn when safe.",
    reasoningHint: "The subject should yield because an oncoming vehicle crosses the turn path.",
    primaryAction: "yield_then_turn",
    resumeAllowed: true,
    successCriteria: ["no_collision", "turn_completed_into_receiving_lane", "on_road", "recovered_to_cruise"],
    subjectBehaviorIntent: "turn_across_path",
    principalBehaviorIntent: "follow_lane",
    principalBehaviorClass: "compliant",
  },
  unsafe_cut_in: {
    subject: "vehicle",
    context: "adjacent_lane",
    primaryManeuver: "lane_keep",
    causalCategory: "vehicle_cut_in",
    navPrompt: "Continue safely while responding to a vehicle cutting in from an adjacent lane.",
    reasoningHint: "The subject must respond to an adjacent vehicle entering with insufficient gap.",
    primaryAction: "brake_for_cut_in",
    resumeAllowed: true,
    successCriteria: ["no_collision", "on_road", "lane_centered", "recovered_to_cruise"],
    subjectBehaviorIntent: "yield",
    principalBehaviorIntent: "cut_in",
    principalBehaviorClass: "violating",
  },
  pedestrian_crossing: {
    subject: "pedestrian",
    context: "junction_crossing",
    primaryManeuver: "lane_keep",
    causalCategory: "yield_to_vru",
    navPrompt: "Continue through the area while yielding to pedestrians entering the road.",
    reasoningHint: "A pedestrian enters the subject path and requires a yield or stop.",
    primaryAction: "yield_to_pedestrian",
    resumeAllowed: true,
    successCriteria: ["no_collision", "pedestrian_cleared", "on_road", "recovered_to_cruise"],
    subjectBehaviorIntent: "yield",
    principalBehaviorIntent: "cross_road",
    principalBehaviorClass: "imperfect_plausible",
  },
  rear_end: {
    subject: "vehicle",
    context: "rear_approach",
    primaryManeuver: "stop",
    causalCategory: "risky_driving",
    navPrompt: "Maintain a safe stopped or slowing state while monitoring traffic approaching from behind.",
    reasoningHint: "A trailing vehicle closes too quickly on the subject from the rear.",
    primaryAction: "hold_lane",
    resumeAllowed: false,
    successCriteria: ["on_road", "lane_centered", "intended_outcome_observed"],
    subjectBehaviorIntent: "stop_at_signal",
    principalBehaviorIntent: "follow_lane",
    principalBehaviorClass: "imperfect_plausible",
  },
  sideswipe: {
    subject: "vehicle",
    context: "adjacent_lane",
    primaryManeuver: "lane_keep",
    causalCategory: "risky_driving",
    navPrompt: "Hold the current lane while responding to an adjacent vehicle drifting laterally.",
    reasoningHint: "An adjacent vehicle drifts into the subject lane.",
    primaryAction: "hold_lane",
    resumeAllowed: true,
    successCriteria: ["on_road", "lane_centered", "intended_outcome_observed"],
    subjectBehaviorIntent: "follow_lane",
    principalBehaviorIntent: "merge",
    principalBehaviorClass: "imperfect_plausible",
  },
  right_turn_hook: {
    subject: "vehicle",
    context: "right_turn",
    primaryManeuver: "turn_right",
    causalCategory: "yield_to_vru_or_vehicle",
    navPrompt: "Yield to through road users on the right before completing the right turn.",
    reasoningHint: "A through road user continues beside the subject across its right-turn path.",
    primaryAction: "yield_then_turn",
    resumeAllowed: true,
    successCriteria: ["no_collision", "turn_completed_into_receiving_lane", "on_road", "recovered_to_cruise"],
    subjectBehaviorIntent: "turn_across_path",
    principalBehaviorIntent: "follow_lane",
    principalBehaviorClass: "compliant",
  },
} as const;

export const COLLISION_FAMILY_INTENTION = {
  ...COLLISION_FAMILY_INTENTION_BASE,
  // The two NEAR-MISS families. `CollisionFamilyId` gained them when the
  // near-miss templates landed in `@simforge-oss/studio-shared/scenario-families`, which
  // happened on the branch this file merged with (2026-07-27) — so this record
  // was written against a six-family union and `satisfies` now demands both.
  //
  // Each reuses its collision counterpart's geometry (collision-templates.ts:19)
  // and differs only in outcome: the conflict is set up and then RESOLVED, so
  // the descriptor keeps the same subject/context/causal category and swaps the
  // reasoning for the successful-avoidance reading.
  near_miss_cut_in: {
    ...COLLISION_FAMILY_INTENTION_BASE.unsafe_cut_in,
    reasoningHint:
      "An adjacent vehicle enters the subject path with a small but sufficient gap; the subject yields and the conflict resolves without contact.",
  },
  near_miss_pedestrian: {
    ...COLLISION_FAMILY_INTENTION_BASE.pedestrian_crossing,
    reasoningHint:
      "A pedestrian enters the subject path far enough ahead that yielding clears the conflict without contact.",
  },
} as const satisfies Record<CollisionFamilyId, CollisionDescriptor>;

const EXTRA_COLLISION_FAMILY_INTENTION = {
  bicycle_merge: {
    ...COLLISION_FAMILY_INTENTION.unsafe_cut_in,
    subject: "bicycle",
    context: "lane_change",
    causalCategory: "vehicle_cut_in",
    navPrompt: "Continue safely while responding to a cyclist merging into the subject lane.",
    reasoningHint: "A cyclist merges from a parallel bicycle lane into the subject path.",
    principalBehaviorIntent: "merge",
    principalBehaviorClass: "imperfect_plausible",
  },
  // Turn-across-crosswalk pedestrian conflict (dib 2026-07-21): the subject turns
  // at a junction while a pedestrian crosses the DESTINATION-leg crosswalk.
  left_turn_ped_crosswalk: {
    subject: "pedestrian",
    context: "unprotected_left",
    primaryManeuver: "turn_left",
    causalCategory: "yield_to_vru",
    navPrompt: "Yield to the pedestrian in the destination crosswalk before completing the left turn.",
    reasoningHint: "A pedestrian crosses the destination-leg crosswalk while the subject turns left.",
    primaryAction: "yield_then_turn",
    resumeAllowed: true,
    successCriteria: ["no_collision", "pedestrian_cleared", "turn_completed_into_receiving_lane", "on_road", "recovered_to_cruise"],
    subjectBehaviorIntent: "turn_across_path",
    principalBehaviorIntent: "cross_road",
    principalBehaviorClass: "compliant",
  },
  right_turn_ped_crosswalk: {
    subject: "pedestrian",
    context: "right_turn",
    primaryManeuver: "turn_right",
    causalCategory: "yield_to_vru",
    navPrompt: "Yield to the pedestrian in the destination crosswalk before completing the right turn.",
    reasoningHint: "A pedestrian crosses the destination-leg crosswalk while the subject turns right.",
    primaryAction: "yield_then_turn",
    resumeAllowed: true,
    successCriteria: ["no_collision", "pedestrian_cleared", "turn_completed_into_receiving_lane", "on_road", "recovered_to_cruise"],
    subjectBehaviorIntent: "turn_across_path",
    principalBehaviorIntent: "cross_road",
    principalBehaviorClass: "compliant",
  },
} as const satisfies Record<
  "bicycle_merge" | "left_turn_ped_crosswalk" | "right_turn_ped_crosswalk",
  CollisionDescriptor
>;

type CollisionGeneratorFamily = CollisionFamilyId | keyof typeof EXTRA_COLLISION_FAMILY_INTENTION;

const CONTEXT_LABEL: Record<ScenarioIntention["context"], string> = {
  unprotected_left: "unprotected left turn",
  right_turn: "right turn",
  junction_crossing: "junction crossing",
  mid_block: "mid-block",
  occluded: "occluded mid-block",
  lane_change: "lane change",
  overtake: "overtake",
  stop_sign: "stop sign",
  highway: "highway",
  rear_approach: "rear approach",
  adjacent_lane: "adjacent lane",
};

function categoryFor(
  subject: ScenarioIntention["subject"],
  outcome: ScenarioIntention["outcome"],
  context: ScenarioIntention["context"],
): string {
  const outcomeLabel = outcome.replaceAll("_", " ");
  return outcome === "nominal"
    ? `nominal at ${CONTEXT_LABEL[context]}`
    : `${subject} ${outcomeLabel} at ${CONTEXT_LABEL[context]}`;
}

/**
 * Reconstruct the M2.1 classification record for pre-M2.1 drafts during the
 * metadata backfill. This deliberately uses the same mapping tables as live
 * emission; callers should prefer an already-stored scenarioIntention.
 */
export function inferScenarioIntentionForBackfill(input: {
  family?: string | null;
  strategy?: string | null;
  plannedOutcome?: "collision" | "near_miss" | null;
  weather?: string | null;
}): ScenarioIntention | null {
  const wet = /rain|wet|puddle/i.test(input.weather ?? "");
  if (
    input.family &&
    (Object.prototype.hasOwnProperty.call(
      COLLISION_FAMILY_INTENTION,
      input.family,
    ) ||
      Object.prototype.hasOwnProperty.call(
        EXTRA_COLLISION_FAMILY_INTENTION,
        input.family,
      ))
  ) {
    const family = input.family as CollisionGeneratorFamily;
    const base =
      family in EXTRA_COLLISION_FAMILY_INTENTION
        ? EXTRA_COLLISION_FAMILY_INTENTION[
            family as keyof typeof EXTRA_COLLISION_FAMILY_INTENTION
          ]
        : COLLISION_FAMILY_INTENTION[family as CollisionFamilyId];
    const outcome = input.plannedOutcome ?? "collision";
    return {
      schema_version: "simforge.scenario-intention.v1",
      // Downstream marker: runs of this scene carry the run-derived
      // event-grounded cot.json sidecar (not plan-derived narration).
      cot_kind: "event_grounded",
      subject: base.subject,
      outcome,
      context: base.context,
      category: categoryFor(base.subject, outcome, base.context),
      primary_maneuver_category: base.primaryManeuver,
      alpamayo_causal_category: base.causalCategory,
      failure_mode_target:
        outcome === "collision" ? "at_fault_collision" : "nominal",
      modifiers: {
        traffic: "normal",
        parked: "none",
        weather: wet ? "wet_raining" : "clear",
        occlusion: null,
        heavy_lead: false,
        signalized: false,
      },
      nav_prompt: base.navPrompt,
      reasoning_hint: base.reasoningHint,
      expected_behavior: {
        primary_action:
          outcome === "collision"
            ? "execute_planned_conflict"
            : base.primaryAction,
        resume_allowed: outcome === "collision" ? false : base.resumeAllowed,
      },
      success_criteria:
        outcome === "collision"
          ? [
              "intended_contact",
              "contact_with_principal_actor",
              "on_road_until_contact",
            ]
          : [...base.successCriteria],
    };
  }
  if (
    input.strategy &&
    Object.prototype.hasOwnProperty.call(
      NOMINAL_STRATEGY_INTENTION,
      input.strategy,
    )
  ) {
    const strategy = input.strategy as NominalStrategyId;
    const base = NOMINAL_STRATEGY_INTENTION[strategy];
    return {
      schema_version: "simforge.scenario-intention.v1",
      // Downstream marker: runs of this scene carry the run-derived
      // event-grounded cot.json sidecar (not plan-derived narration).
      cot_kind: "event_grounded",
      subject: "none",
      outcome: "nominal",
      context: base.context,
      category: categoryFor("none", "nominal", base.context),
      primary_maneuver_category: base.primaryManeuver,
      alpamayo_causal_category: base.causalCategory,
      failure_mode_target: "nominal",
      modifiers: {
        traffic: "normal",
        parked: "none",
        weather: wet ? "wet_raining" : "clear",
        occlusion: null,
        heavy_lead: false,
        signalized: strategy === "stop_at_traffic_light",
      },
      nav_prompt: base.navPrompt,
      reasoning_hint: base.reasoningHint,
      expected_behavior: {
        primary_action: base.primaryAction,
        resume_allowed: base.resumeAllowed,
      },
      success_criteria: [...base.successCriteria],
    };
  }
  return null;
}

function controlModeFor(
  actor: ScenarioEditorActorDraft,
  behaviorIntent: string,
): GeneratedActorBehaviorMetadata["control_mode"] {
  // Generator intermediates still carry the legacy keys top-level; a migrated
  // draft carries residue in the wire envelope and its Auto baseline as an
  // `autopilot` base clip.
  const legacy = actor as RuntimeScenarioEditorActor;
  if (
    actor.reaction_profile?.mode === "brake" ||
    actor.reaction_profile?.mode === "brake_and_swerve" ||
    legacy.reactive_braking ||
    actor.legacy_wire?.reactive_braking ||
    behaviorIntent === "yield"
  ) {
    return "reactive";
  }
  const autopilotBase = actor.behavior
    ? baseClip(actor.behavior)?.action.kind === "autopilot"
    : undefined;
  if (autopilotBase ?? legacy.autopilot) return "traffic_manager";
  const legacyTimeline = legacy.timeline ?? actor.legacy_wire?.timeline ?? [];
  if (
    actor.behavior?.clips.some(
      (clip) => clip.action.kind === "intercept" || clip.action.kind === "follow_actor",
    ) ||
    legacyTimeline.some(
      (clip) => clip.action === "ram_actor" || clip.action === "chase_actor",
    )
  ) {
    return "closed_loop";
  }
  if (actor.placement_mode === "path" || actor.placement_mode === "timed_path") {
    return "open_loop";
  }
  return actor.is_static ? "open_loop" : "closed_loop";
}

function withBehavior(
  actor: ScenarioEditorActorDraft,
  metadata: Omit<GeneratedActorBehaviorMetadata, "control_mode" | "trajectory_mode">,
): ScenarioEditorActorDraft {
  return {
    ...actor,
    behaviorMetadata: {
      ...metadata,
      control_mode: controlModeFor(actor, metadata.behavior_intent),
      trajectory_mode: actor.placement_mode === "road" ? "follow" : "position",
    },
  };
}

function normalizedOcclusion(
  subtype: string | null | undefined,
): ScenarioIntention["modifiers"]["occlusion"] {
  const value = subtype?.toLowerCase() ?? "";
  if (value.includes("bus")) return "bus_stop";
  if (value.includes("delivery") || value.includes("commercial")) return "delivery_truck";
  if (value) return "parked_car";
  return null;
}

function isHeavyVehicle(actor: ScenarioEditorActorDraft): boolean {
  return /(bus|truck|fuso|firetruck|carlacola|sprinter)/i.test(
    `${actor.blueprint} ${actor.label}`,
  );
}

function nominalActorIntent(
  actor: ScenarioEditorActorDraft,
  descriptor: IntentionDescriptor,
): string {
  if (actor.role === "subject") return descriptor.subjectBehaviorIntent;
  if (actor.id.startsWith("batch-stop-vru")) return "cross_road";
  if (actor.id.startsWith("batch-stop-lead")) return "stop_in_lane";
  if (actor.id.includes("overtake-lead")) return "follow_lane";
  if (actor.is_static) return "parked";
  if (actor.kind === "walker") return "walk_along_sidewalk";
  return "follow_lane";
}

function nominalActorRole(actor: ScenarioEditorActorDraft): string {
  if (actor.role === "subject") return "subject";
  if (actor.id.startsWith("batch-stop-vru")) return "conflict_walker";
  if (
    actor.id.startsWith("batch-stop-lead") ||
    actor.id.includes("overtake-lead") ||
    actor.id.includes("queue-lead")
  ) {
    return "principal_other_vehicle";
  }
  return "ambient";
}

export function stampNominalGeneratedOutput(input: {
  generator: string;
  seed?: string | number;
  strategy: NominalStrategyId;
  actors: ScenarioEditorActorDraft[];
  stopVariant?: string | null;
  traffic: "normal" | "medium" | "heavy";
  parked: "none" | "light" | "moderate" | "heavy";
  weather?: string | null;
  environmentPreset?: unknown;
  heavyVehicles?: boolean;
  signalized?: boolean;
  softwareVersions?: ScenarioMetadataSoftwareVersions;
}): {
  scenarioIntention: ScenarioIntention;
  scenarioMetadata: GeneratedScenarioMetadata;
  actors: ScenarioEditorActorDraft[];
} {
  const base = NOMINAL_STRATEGY_INTENTION[input.strategy];
  const isVruYield = input.strategy === "stop" && input.stopVariant === "vru_yield";
  const subject: ScenarioIntention["subject"] = isVruYield
    ? "pedestrian"
    : input.strategy === "stop" && input.stopVariant !== "stop_sign"
      ? "vehicle"
      : "none";
  const outcome: ScenarioIntention["outcome"] = isVruYield
    ? "collision_avoidance"
    : "nominal";
  const causalCategory = isVruYield ? "yield_to_vru" : base.causalCategory;
  const actors = input.actors.map((actor) =>
    withBehavior(actor, {
      role: nominalActorRole(actor),
      behavior_intent: nominalActorIntent(actor, base),
      behavior_class: "compliant",
    }),
  );
  const heavyLead =
    (input.strategy === "overtake_left" || input.strategy === "overtake_right") &&
    actors.some((actor) => actor.id.includes("overtake-lead") && isHeavyVehicle(actor));
  const context = base.context;
  const scenarioIntention: ScenarioIntention = {
    schema_version: "simforge.scenario-intention.v1",
    // Downstream marker: runs of this scene carry the run-derived
    // event-grounded cot.json sidecar (not plan-derived narration).
    cot_kind: "event_grounded",
    subject,
    outcome,
    context,
    category: categoryFor(subject, outcome, context),
    primary_maneuver_category: base.primaryManeuver,
    alpamayo_causal_category: causalCategory,
    failure_mode_target: "nominal",
    modifiers: {
      traffic: input.traffic,
      parked: input.parked,
      weather: /rain|wet/i.test(input.weather ?? "") ? "wet_raining" : "clear",
      occlusion: null,
      heavy_lead: heavyLead,
      signalized:
        input.signalized ??
        input.strategy === "stop_at_traffic_light",
    },
    nav_prompt: base.navPrompt,
    reasoning_hint: isVruYield
      ? "A crossing pedestrian requires the subject to yield, stop, and resume after the path clears."
      : base.reasoningHint,
    expected_behavior: {
      primary_action: isVruYield ? "yield_then_resume" : base.primaryAction,
      resume_allowed: base.resumeAllowed,
    },
    success_criteria: [...base.successCriteria],
  };
  const scenarioMetadata = buildScenarioMetadata({
    generator: input.generator,
    seed: input.seed,
    classificationReference: `strategy:${input.strategy}`,
    scenarioIntention,
    actors,
    traffic: input.traffic,
    weather: input.weather,
    environmentPreset: input.environmentPreset,
    softwareVersions: input.softwareVersions,
  });
  assertGeneratedScenarioMetadata({
    generator: input.generator,
    scenarioIntention,
    scenarioMetadata,
    actors,
  });
  return { scenarioIntention, scenarioMetadata, actors };
}

export function stampCollisionGeneratedOutput(input: {
  generator: string;
  seed?: string | number;
  family: CollisionGeneratorFamily;
  actors: ScenarioEditorActorDraft[];
  principalActorIds: ReadonlySet<string>;
  plannedOutcome: "collision" | "near_miss";
  subjectReactive?: boolean;
  npcVehicleType?: "car" | "bicycle" | "motorcycle" | null;
  traffic?: "normal" | "medium" | "heavy";
  parked?: "none" | "light" | "moderate" | "heavy";
  weather?: string | null;
  environmentPreset?: unknown;
  occlusionSubtype?: string | null;
  signalized?: boolean;
  contextHint?: ScenarioIntention["context"];
  softwareVersions?: ScenarioMetadataSoftwareVersions;
}): {
  scenarioIntention: ScenarioIntention;
  scenarioMetadata: GeneratedScenarioMetadata;
  actors: ScenarioEditorActorDraft[];
} {
  const base =
    input.family in EXTRA_COLLISION_FAMILY_INTENTION
      ? EXTRA_COLLISION_FAMILY_INTENTION[
          input.family as keyof typeof EXTRA_COLLISION_FAMILY_INTENTION
        ]
      : COLLISION_FAMILY_INTENTION[input.family as CollisionFamilyId];
  const outcome: ScenarioIntention["outcome"] = input.subjectReactive
    ? "collision_avoidance"
    : input.plannedOutcome;
  const occlusion = normalizedOcclusion(input.occlusionSubtype);
  const subject: ScenarioIntention["subject"] =
    input.family === "right_turn_hook" && input.npcVehicleType === "bicycle"
      ? "bicycle"
      : input.family === "right_turn_hook" && input.npcVehicleType === "motorcycle"
        ? "motorcycle"
        : base.subject;
  const context =
    occlusion &&
    (input.family === "pedestrian_crossing" ||
      input.family === "right_turn_hook")
      ? "occluded"
      : (input.contextHint ?? base.context);
  const actors = input.actors.map((actor) => {
    const principal = input.principalActorIds.has(actor.id) && actor.role !== "subject";
    const behaviorIntent =
      actor.role === "subject"
        ? input.subjectReactive
          ? "yield"
          : base.subjectBehaviorIntent
        : principal
          ? actor.kind === "walker" && occlusion
            ? "emerge_from_occlusion"
            : base.principalBehaviorIntent
          : actor.is_static
            ? "parked"
            : actor.kind === "walker"
              ? "walk_along_sidewalk"
              : "follow_lane";
    return withBehavior(actor, {
      role:
        actor.role === "subject"
          ? "subject"
          : principal
            ? actor.kind === "walker"
              ? "conflict_walker"
              : "principal_other_vehicle"
            : "ambient",
      behavior_intent: behaviorIntent,
      behavior_class:
        actor.role === "subject"
          ? outcome === "collision"
            ? "infeasible_diagnostic"
            : "compliant"
          : principal
            ? base.principalBehaviorClass
            : "compliant",
    });
  });
  const scenarioIntention: ScenarioIntention = {
    schema_version: "simforge.scenario-intention.v1",
    // Downstream marker: runs of this scene carry the run-derived
    // event-grounded cot.json sidecar (not plan-derived narration).
    cot_kind: "event_grounded",
    subject,
    outcome,
    context,
    category: categoryFor(subject, outcome, context),
    primary_maneuver_category: base.primaryManeuver,
    alpamayo_causal_category: base.causalCategory,
    failure_mode_target: outcome === "collision" ? "at_fault_collision" : "nominal",
    modifiers: {
      traffic: input.traffic ?? "normal",
      parked: input.parked ?? "none",
      weather: /rain|wet/i.test(input.weather ?? "") ? "wet_raining" : "clear",
      occlusion,
      heavy_lead: false,
      signalized: input.signalized ?? false,
    },
    nav_prompt: base.navPrompt,
    reasoning_hint: base.reasoningHint,
    expected_behavior: {
      primary_action: input.subjectReactive ? base.primaryAction : "execute_planned_conflict",
      resume_allowed: input.subjectReactive ? base.resumeAllowed : false,
    },
    success_criteria:
      outcome === "collision"
        ? ["intended_contact", "contact_with_principal_actor", "on_road_until_contact"]
        : [...base.successCriteria],
  };
  const scenarioMetadata = buildScenarioMetadata({
    generator: input.generator,
    seed: input.seed,
    classificationReference: `family:${input.family}`,
    scenarioIntention,
    actors,
    traffic: input.traffic ?? "normal",
    weather: input.weather,
    environmentPreset: input.environmentPreset,
    softwareVersions: input.softwareVersions,
  });
  assertGeneratedScenarioMetadata({
    generator: input.generator,
    scenarioIntention,
    scenarioMetadata,
    actors,
  });
  return { scenarioIntention, scenarioMetadata, actors };
}

export function assertGeneratedScenarioMetadata(input: {
  generator: string;
  scenarioIntention: unknown;
  scenarioMetadata: unknown;
  actors: ReadonlyArray<ScenarioEditorActorDraft>;
}): void {
  const intention = ScenarioIntentionSchema.safeParse(input.scenarioIntention);
  if (!intention.success) {
    throw new Error(
      `[${input.generator}] generated scenario emission rejected: scenario_intention is missing or invalid: ${intention.error.issues[0]?.message ?? "invalid block"}`,
    );
  }
  const metadata = GeneratedScenarioMetadataSchema.safeParse(
    input.scenarioMetadata,
  );
  if (!metadata.success) {
    throw new Error(
      `[${input.generator}] generated scenario emission rejected: scenario_metadata is missing or invalid: ${metadata.error.issues[0]?.message ?? "invalid block"}`,
    );
  }
  if (input.actors.length === 0) {
    throw new Error(
      `[${input.generator}] generated scenario emission rejected: at least one actor with behaviorMetadata is required.`,
    );
  }
  for (const actor of input.actors) {
    const behavior = GeneratedActorBehaviorMetadataSchema.safeParse(
      actor.behaviorMetadata,
    );
    if (!behavior.success) {
      throw new Error(
        `[${input.generator}] generated scenario emission rejected: actor '${actor.id}' is missing complete behaviorMetadata: ${behavior.error.issues[0]?.message ?? "invalid block"}`,
      );
    }
  }
}
