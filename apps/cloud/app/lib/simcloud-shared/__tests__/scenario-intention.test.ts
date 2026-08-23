import { describe, expect, it } from "vitest";
import currentV2Draft from "./fixtures/scenario-editor-v2-current.json";
import {
  ActorBehaviorMetadataSchema,
  GeneratedActorBehaviorMetadataSchema,
  ScenarioEditorDraftSchema,
  ScenarioIntentionSchema,
} from "../index";

const validIntention = {
  schema_version: "simforge.scenario-intention.v1",
  subject: "vehicle",
  outcome: "collision_avoidance",
  context: "unprotected_left",
  category: "vehicle collision avoidance at unprotected left turn",
  primary_maneuver_category: "turn_left",
  alpamayo_causal_category: "yield_to_vru_or_vehicle",
  failure_mode_target: "nominal",
  modifiers: {
    traffic: "medium",
    parked: "light",
    weather: "clear",
    occlusion: null,
    heavy_lead: false,
    signalized: false,
  },
  nav_prompt: "Yield to the oncoming vehicle and complete the turn.",
  reasoning_hint: "The oncoming vehicle crosses the ego turn path.",
  expected_behavior: {
    primary_action: "yield_then_turn",
    resume_allowed: true,
  },
  success_criteria: [
    "no_collision",
    "turn_completed_into_receiving_lane",
    "on_road",
    "recovered_to_cruise",
  ],
} as const;

describe("ScenarioIntentionSchema", () => {
  it("parses the complete §2.3 block", () => {
    expect(ScenarioIntentionSchema.parse(validIntention)).toEqual(validIntention);
  });

  it("rejects the wrong schema version, taxonomy values, and incomplete blocks", () => {
    expect(
      ScenarioIntentionSchema.safeParse({
        ...validIntention,
        schema_version: "simforge.scenario-intention.v2",
      }).success,
    ).toBe(false);
    expect(
      ScenarioIntentionSchema.safeParse({
        ...validIntention,
        outcome: "avoided",
      }).success,
    ).toBe(false);
    const { success_criteria: _omitted, ...incomplete } = validIntention;
    expect(ScenarioIntentionSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe("ActorBehaviorMetadataSchema", () => {
  it("accepts progressive editor metadata but requires completeness for generated output", () => {
    expect(
      ActorBehaviorMetadataSchema.parse({
        behavior_intent: "follow_lane",
      }),
    ).toEqual({ behavior_intent: "follow_lane" });
    expect(
      GeneratedActorBehaviorMetadataSchema.safeParse({
        role: "ego",
        behavior_intent: "follow_lane",
        behavior_class: "compliant",
        control_mode: "traffic_manager",
        trajectory_mode: "follow",
      }).success,
    ).toBe(true);
    expect(
      GeneratedActorBehaviorMetadataSchema.safeParse({
        role: "ego",
        behavior_intent: "follow_lane",
      }).success,
    ).toBe(false);
    expect(
      ActorBehaviorMetadataSchema.safeParse({
        behavior_class: "reckless",
      }).success,
    ).toBe(false);
  });
});

describe("scenario editor v2 compatibility", () => {
  it("parses the current v2 fixture without either optional metadata block", () => {
    const parsed = ScenarioEditorDraftSchema.parse(currentV2Draft);
    expect(parsed.version).toBe(2);
    expect(parsed.metadata.scenarioIntention).toBeUndefined();
    expect(parsed.actors[0]!.behaviorMetadata).toBeUndefined();
  });

  it("accepts both blocks when present without changing the draft version", () => {
    const parsed = ScenarioEditorDraftSchema.parse({
      ...currentV2Draft,
      metadata: {
        ...currentV2Draft.metadata,
        scenarioIntention: validIntention,
      },
      actors: currentV2Draft.actors.map((actor) => ({
        ...actor,
        behaviorMetadata: {
          role: "ego",
          behavior_intent: "follow_lane",
          behavior_class: "compliant",
          control_mode: "traffic_manager",
          trajectory_mode: "follow",
        },
      })),
    });
    expect(parsed.version).toBe(2);
    expect(parsed.metadata.scenarioIntention).toEqual(validIntention);
  });
});
