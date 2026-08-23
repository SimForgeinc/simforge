import { describe, expect, it } from "vitest";
import {
  ACTOR_BEHAVIOR_SCHEMA_VERSION,
  ActorBehaviorProgramSchema,
  BEHAVIOR_ACTION_KINDS,
  BEHAVIOR_ROUTE_ANCHOR_CAP,
  BEHAVIOR_TRIGGER_KINDS,
  BehaviorClipSchema,
  BehaviorTriggerSchema,
  DivertPathActionSchema,
  LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
  ReactionProfileSchema,
  migrateActorDraft,
  migrateActorDraftReactionProfile,
  migrateActorDraftToBehaviorProgram,
  quantizeBehaviorTimeSeconds,
  readBehaviorEvents,
} from "../scenario-behavior";
import type { BehaviorAction } from "../scenario-behavior";
import { ScenarioEditorActorDraftSchema } from "../scenario-editor";
import type { ScenarioEditorActorDraft } from "../scenario-editor";

function makeDraft(overrides: Record<string, unknown> = {}): ScenarioEditorActorDraft {
  return ScenarioEditorActorDraftSchema.parse({
    id: "actor-1",
    label: "Car 1",
    kind: "vehicle",
    blueprint: "vehicle.tesla.model3",
    spawn: { road_id: "road-10", s_fraction: 0.25, lane_id: -1, section_id: 0 },
    speed_kph: 40,
    ...overrides,
  });
}

function timelineClip(overrides: Record<string, unknown>) {
  return { id: "clip-1", start_time: 0, action: "set_speed", enabled: true, ...overrides };
}

function instructionRow(overrides: Record<string, unknown>) {
  return {
    id: "tii_1",
    timestampSeconds: 0,
    rowOrder: 0,
    enabled: true,
    primitiveId: "lane_follow",
    args: {},
    source: "manual",
    validationErrors: [],
    ...overrides,
  };
}

function timedInstructions(intent: Record<string, unknown>[]) {
  return {
    schemaVersion: "simforge.timed-instructions.v1",
    intent,
    resolvedPlan: null,
    status: "draft",
    manifest: [],
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe("behavior vocabulary", () => {
  it("exposes every trigger kind the plan's condition table names", () => {
    expect([...BEHAVIOR_TRIGGER_KINDS]).toEqual([
      "at_time",
      "after_clip",
      "reach",
      "proximity",
      "ttc",
      "headway",
      "speed",
      "standstill",
      "signal_state",
    ]);
    const parsedKinds = BehaviorTriggerSchema.options.map((option) => option.shape.kind.value);
    expect(parsedKinds).toEqual([...BEHAVIOR_TRIGGER_KINDS]);
  });

  it("exposes every action kind in the plan's vocabulary table", () => {
    expect([...BEHAVIOR_ACTION_KINDS]).toEqual([
      "cruise",
      "stop",
      "creep",
      "reverse",
      "hold",
      "lane_change",
      "lane_offset",
      "turn_at_next_intersection",
      "follow_route",
      "follow_path",
      "go_to",
      "divert_path",
      "yield_to",
      "follow_actor",
      "intercept",
      "cut_in",
      "avoid",
      "autopilot",
      "walk_path",
    ]);
  });
});

describe("divert_path carries only what it may", () => {
  /**
   * The three absences are the design, so they are asserted rather than assumed.
   * `.strict()` turns each into a parse failure, which is what makes them
   * enforceable at all — a merely-undocumented field would be written by the
   * first caller that had one lying around.
   */
  it("takes clip-owned waypoints", () => {
    expect(
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }).waypoints,
    ).toHaveLength(2);
  });

  it("refuses a speed of its own", () => {
    // The base clip already answered "how fast". A second answer here has no
    // tiebreak, so the field is absent rather than optional.
    expect(() =>
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [{ x: 1, y: 2 }],
        speed_kph: 40,
      }),
    ).toThrow();
  });

  it("refuses a schedule", () => {
    // `timed` means the waypoint times are a contract solved at generation time.
    // A divert fires off a trigger, so there is no such moment.
    expect(() =>
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [{ x: 1, y: 2 }],
        timed: true,
      }),
    ).toThrow();
  });

  it("needs at least one waypoint", () => {
    expect(() =>
      DivertPathActionSchema.parse({ kind: "divert_path", waypoints: [] }),
    ).toThrow();
  });
});

describe("behavior schema validation", () => {
  it("defaults a clip to an at_time=0 trigger, completion end and enabled", () => {
    const clip = BehaviorClipSchema.parse({
      id: "clip-a",
      action: { kind: "cruise", speed_kph: 30 },
    });
    expect(clip).toEqual({
      id: "clip-a",
      enabled: true,
      trigger: { kind: "at_time", t: 0 },
      end: { kind: "completion" },
      action: { kind: "cruise", speed_kph: 30 },
    });
  });

  it("defaults the program envelope", () => {
    expect(ActorBehaviorProgramSchema.parse({})).toEqual({
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      clips: [],
      conflict_policy: "overwrite",
    });
  });

  it("accepts explicit clip roles and rejects multiple base clips", () => {
    const result = ActorBehaviorProgramSchema.safeParse({
      clips: [
        { id: "base-a", role: "base", action: { kind: "hold" } },
        { id: "base-b", role: "base", action: { kind: "cruise", speed_kph: 20 } },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/At most one clip.*base/);
    }
  });

  it.each(["follow_route", "follow_path", "walk_path"] as const)(
    "rejects %s on a role-stamped interaction but keeps legacy clips parseable",
    (kind) => {
      const action =
        kind === "follow_route"
          ? { kind, anchors: [{ road_id: "road-1", s_fraction: 0.5 }] }
          : kind === "follow_path"
            ? { kind, waypoints: [{ x: 1, y: 2 }] }
            : { kind, waypoints: [{ x: 1, y: 2 }] };
      const interaction = ActorBehaviorProgramSchema.safeParse({
        clips: [{ id: "route", role: "interaction", action }],
      });
      expect(interaction.success).toBe(false);
      if (!interaction.success) {
        expect(interaction.error.issues[0]?.message).toBe(
          `${kind} is a route, not an interaction: its waypoints live on the actor, so it is only legal as the base clip.`,
        );
      }
      expect(
        ActorBehaviorProgramSchema.safeParse({
          clips: [{ id: "legacy-route", action }],
        }).success,
      ).toBe(true);
    },
  );

  it("quantizes at_time triggers to the 0.1s authoring grid", () => {
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 4.2 }).success).toBe(true);
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 4.25 }).success).toBe(false);
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: -1 }).success).toBe(false);
    expect(quantizeBehaviorTimeSeconds(4.267)).toBe(4.3);
    expect(quantizeBehaviorTimeSeconds(-3)).toBe(0);
  });

  it("requires positive distances and times on the conditional triggers", () => {
    expect(
      BehaviorTriggerSchema.safeParse({
        kind: "proximity",
        other: { actor_id: "ego" },
        distance_m: 0,
      }).success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "ttc", other: { actor_id: "ego" }, seconds: 0 })
        .success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "reach", point: { x: 1, y: 2 }, radius_m: -3 })
        .success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "standstill", seconds: 2 }).success,
    ).toBe(true);
  });

  it("defaults the trigger subject to self and accepts an explicit actor ref", () => {
    const proximity = BehaviorTriggerSchema.parse({
      kind: "proximity",
      other: { actor_id: "ego" },
      distance_m: 20,
    });
    expect(proximity).toEqual({
      kind: "proximity",
      actor: "self",
      other: { actor_id: "ego" },
      distance_m: 20,
      mode: "closer",
    });
    expect(
      BehaviorTriggerSchema.safeParse({
        kind: "speed",
        actor: { actor_id: "car-2" },
        kph: 10,
        rule: "below",
      }).success,
    ).toBe(true);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "proximity", other: { actor_id: "" }, distance_m: 5 })
        .success,
    ).toBe(false);
  });

  it("rejects unknown parameters on the closed vocabularies", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "cruise", speed_kph: 30, speedKph: 30 },
      }).success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 1, delay: 2 }).success,
    ).toBe(false);
  });

  it("requires follow_actor to carry a headway or a distance", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_actor", actor: { actor_id: "ego" } },
      }).success,
    ).toBe(false);
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_actor", actor: { actor_id: "ego" }, headway_s: 2 },
      }).success,
    ).toBe(true);
  });

  it("rejects a clip that waits on itself", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        trigger: { kind: "after_clip", clip_id: "clip-a" },
        action: { kind: "hold" },
      }).success,
    ).toBe(false);
  });

  it("caps follow_route anchors at 32 and requires at least one", () => {
    const anchor = { road_id: "road-1", s_fraction: 0.5 };
    const withCount = (count: number) =>
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_route", anchors: Array.from({ length: count }, () => anchor) },
      }).success;
    expect(withCount(0)).toBe(false);
    expect(withCount(BEHAVIOR_ROUTE_ANCHOR_CAP)).toBe(true);
    expect(withCount(BEHAVIOR_ROUTE_ANCHOR_CAP + 1)).toBe(false);
  });

  it("applies the worker's legacy defaults for creep and reverse speeds", () => {
    const creep = BehaviorClipSchema.parse({ id: "c", action: { kind: "creep" } });
    const reverse = BehaviorClipSchema.parse({ id: "r", action: { kind: "reverse" } });
    expect(creep.action).toEqual({ kind: "creep", speed_kph: 5 });
    expect(reverse.action).toEqual({ kind: "reverse", speed_kph: 10 });
  });

  it("keeps the reaction profile an actor-level, mode-plus-aggressiveness knob", () => {
    expect(ReactionProfileSchema.parse({ mode: "brake_and_swerve" })).toEqual({
      mode: "brake_and_swerve",
      aggressiveness: 0.5,
      exempt_actor_ids: [],
    });
    expect(ReactionProfileSchema.safeParse({ mode: "brake", aggressiveness: 1.4 }).success).toBe(
      false,
    );
    expect(ReactionProfileSchema.safeParse({ mode: "swerve" }).success).toBe(false);
  });
});

describe("migrateActorDraftToBehaviorProgram goldens", () => {
  it("migrates a legacy timeline verbatim (order, ids, times, spans)", () => {
    const draft = makeDraft({
      route: [
        { road_id: "road-10", s_fraction: 0.2 },
        { road_id: "road-11", s_fraction: 0.8, lane_id: -1, section_id: 0 },
      ],
      timeline: [
        timelineClip({ id: "clip-route", action: "follow_route", start_time: 0, target_speed_kph: 45 }),
        timelineClip({
          id: "clip-stop",
          action: "stop",
          start_time: 6.04,
          end_time: 9.04,
          decel_window_seconds: 2,
        }),
        timelineClip({ id: "clip-hold", action: "hold_position", start_time: 9, end_time: 12 }),
        timelineClip({ id: "clip-swerve", action: "swerve", start_time: 13, enabled: false }),
      ],
    });

    expect(migrateActorDraftToBehaviorProgram(draft)).toEqual({
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      conflict_policy: "overwrite",
      clips: [
        {
          id: "clip-route",
          enabled: true,
          trigger: { kind: "at_time", t: 0 },
          end: { kind: "completion" },
          action: {
            kind: "follow_route",
            speed_kph: 45,
            anchors: [
              { road_id: "road-10", s_fraction: 0.2 },
              { road_id: "road-11", s_fraction: 0.8, lane_id: -1, section_id: 0 },
            ],
          },
        },
        {
          id: "clip-stop",
          enabled: true,
          // 6.04 is off-grid legacy data; the migration snaps it to 0.1s.
          trigger: { kind: "at_time", t: 6 },
          end: { kind: "duration", seconds: 3.04 },
          action: { kind: "stop", decel_window_s: 2 },
        },
        {
          id: "clip-hold",
          enabled: true,
          trigger: { kind: "at_time", t: 9 },
          end: { kind: "duration", seconds: 3 },
          action: { kind: "hold" },
        },
        {
          id: "clip-swerve",
          enabled: false,
          trigger: { kind: "at_time", t: 13 },
          end: { kind: "completion" },
          action: { kind: "lane_offset", offset_m: -1 },
        },
      ],
    });
  });

  it("migrates a routeless follow_route clip to the cruise the worker actually runs", () => {
    const draft = makeDraft({
      timeline: [timelineClip({ id: "c", action: "follow_route", target_speed_kph: 33 })],
    });
    expect(migrateActorDraftToBehaviorProgram(draft).clips[0]!.action).toEqual({
      kind: "cruise",
      speed_kph: 33,
    });
  });

  it("migrates the interactive legacy actions with their runtime defaults", () => {
    const draft = makeDraft({
      timeline: [
        timelineClip({ id: "chase", action: "chase_actor", target_actor_id: "ego", target_speed_kph: 60 }),
        timelineClip({ id: "ram", action: "ram_actor", target_actor_id: "ego", start_time: 3 }),
        timelineClip({
          id: "yield",
          action: "yield_to_actor",
          target_actor_id: "ego",
          following_distance_m: 12,
          start_time: 5,
        }),
        timelineClip({ id: "rev", action: "drive_reverse", start_time: 7 }),
        timelineClip({ id: "creep", action: "creep_forward", start_time: 9 }),
      ],
    });
    const actions = migrateActorDraftToBehaviorProgram(draft).clips.map((clip) => clip.action);
    expect(actions).toEqual<BehaviorAction[]>([
      { kind: "follow_actor", actor: { actor_id: "ego" }, distance_m: 5, max_speed_kph: 60 },
      { kind: "intercept", actor: { actor_id: "ego" } },
      { kind: "yield_to", actor: { actor_id: "ego" }, gap_m: 12 },
      { kind: "reverse", speed_kph: 10 },
      { kind: "creep", speed_kph: 5 },
    ]);
  });

  it("migrates timed-instruction rows to at_time clips ordered by timestamp then rowOrder", () => {
    const draft = makeDraft({
      timedInstructions: timedInstructions([
        instructionRow({ id: "tii_late", timestampSeconds: 4.2, primitiveId: "lane_change_left", args: { transitionMeters: 25 } }),
        instructionRow({ id: "tii_hold", timestampSeconds: 1, primitiveId: "hold_position", args: { durationSeconds: 2 }, rowOrder: 1 }),
        instructionRow({ id: "tii_speed", timestampSeconds: 1, primitiveId: "set_speed", args: { speedKph: 25 }, rowOrder: 0 }),
        instructionRow({ id: "tii_off", timestampSeconds: 8, primitiveId: "stop", args: { brakingWindowSeconds: 4 }, enabled: false }),
      ]),
    });

    expect(migrateActorDraftToBehaviorProgram(draft).clips).toEqual([
      {
        id: "tii_speed",
        enabled: true,
        trigger: { kind: "at_time", t: 1 },
        end: { kind: "completion" },
        action: { kind: "cruise", speed_kph: 25 },
      },
      {
        id: "tii_hold",
        enabled: true,
        trigger: { kind: "at_time", t: 1 },
        end: { kind: "duration", seconds: 2 },
        action: { kind: "hold" },
      },
      {
        id: "tii_late",
        enabled: true,
        trigger: { kind: "at_time", t: 4.2 },
        end: { kind: "completion" },
        action: { kind: "lane_change", direction: "left", transition_m: 25 },
      },
      {
        id: "tii_off",
        enabled: false,
        trigger: { kind: "at_time", t: 8 },
        end: { kind: "completion" },
        action: { kind: "stop", decel_window_s: 4 },
      },
    ]);
  });

  it("migrates timed waypoints to a single follow_path clip that keeps the timed flag", () => {
    const waypoints = [
      { x: 1, y: 2, time: 0, speed_kph: 20 },
      { x: 12, y: 2, time: 3.5, direction: "forward" as const },
    ];
    const timed = makeDraft({ placement_mode: "timed_path", timed_waypoints: waypoints });
    expect(migrateActorDraftToBehaviorProgram(timed).clips).toEqual([
      {
        id: "bhv_path_actor-1",
        enabled: true,
        trigger: { kind: "at_time", t: 0 },
        end: { kind: "completion" },
        action: { kind: "follow_path", timed: true, waypoints },
      },
    ]);

    const ordered = makeDraft({ placement_mode: "path", timed_waypoints: waypoints });
    const orderedAction = migrateActorDraftToBehaviorProgram(ordered).clips[0]!.action;
    expect(orderedAction).toMatchObject({ kind: "follow_path", timed: false });
  });

  it("migrates a walker's path to walk_path, time-triggered when nothing conflicts with it", () => {
    const walker = makeDraft({
      id: "ped-1",
      kind: "walker",
      role: "pedestrian",
      blueprint: "walker.pedestrian.0001",
      speed_kph: 5,
      placement_mode: "timed_path",
      timed_waypoints: [
        { x: 0, y: 0, time: 2 },
        { x: 0, y: 8, time: 8 },
      ],
    });
    expect(migrateActorDraftToBehaviorProgram(walker).clips).toEqual([
      {
        id: "bhv_path_ped-1",
        enabled: true,
        trigger: { kind: "at_time", t: 0 },
        end: { kind: "completion" },
        action: {
          kind: "walk_path",
          speed_kph: 5,
          waypoints: [
            { x: 0, y: 0, time: 2 },
            { x: 0, y: 8, time: 8 },
          ],
        },
      },
    ]);
  });

  it("rebuilds the hardcoded walker conflict trigger as a proximity-armed crossing", () => {
    const walker = makeDraft({
      id: "ped-1",
      kind: "walker",
      role: "pedestrian",
      blueprint: "walker.pedestrian.0001",
      speed_kph: 5,
      placement_mode: "timed_path",
      timed_waypoints: [
        { x: 0, y: 0, time: 2 },
        { x: 0, y: 8, time: 8 },
      ],
    });
    const ego = makeDraft({ id: "ego", role: "ego", collision_target_id: "ped-1" });

    const clips = migrateActorDraftToBehaviorProgram(walker, { actors: [ego, walker] }).clips;
    expect(clips[0]!.trigger).toEqual({
      kind: "proximity",
      actor: "self",
      other: { actor_id: "ego" },
      distance_m: 15,
      mode: "closer",
    });
    expect(LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M).toBe(15);
    expect(clips[0]!.action.kind).toBe("walk_path");
    // The ego side is a reaction-profile exemption, not a pursuit maneuver.
    expect(migrateActorDraftToBehaviorProgram(ego, { actors: [ego, walker] }).clips).toEqual([]);
  });

  it("migrates all three legacy systems on one actor, in source order", () => {
    const draft = makeDraft({
      id: "car-2",
      placement_mode: "timed_path",
      route: [{ road_id: "road-10", s_fraction: 0.5 }],
      reactive_braking: true,
      collision_target_id: "ped-1",
      timeline: [timelineClip({ id: "clip-1", action: "disable_autopilot" })],
      timedInstructions: timedInstructions([
        instructionRow({ id: "tii_1", timestampSeconds: 2, primitiveId: "turn_right_at_next_intersection" }),
      ]),
      timed_waypoints: [
        { x: 0, y: 0, time: 0 },
        { x: 10, y: 0, time: 2 },
      ],
    });

    const result = migrateActorDraft(draft);
    expect(result.behavior.clips.map((clip) => [clip.id, clip.action.kind])).toEqual([
      ["clip-1", "autopilot"],
      ["tii_1", "turn_at_next_intersection"],
      ["bhv_path_car-2", "follow_path"],
    ]);
    expect(result.reaction_profile).toEqual({
      mode: "brake",
      aggressiveness: 0.5,
      exempt_actor_ids: ["ped-1"],
    });
    expect(ActorBehaviorProgramSchema.safeParse(result.behavior).success).toBe(true);
  });

  it("keeps clip ids unique when legacy sources collide", () => {
    const draft = makeDraft({
      timeline: [
        timelineClip({ id: "dup", action: "stop" }),
        timelineClip({ id: "dup", action: "hold_position", start_time: 2 }),
        timelineClip({ id: "", action: "creep_forward", start_time: 3 }),
      ],
    });
    expect(migrateActorDraftToBehaviorProgram(draft).clips.map((clip) => clip.id)).toEqual([
      "dup",
      "dup#2",
      "bhv_timeline_2",
    ]);
  });

  it("returns an empty program for an actor with no legacy control systems", () => {
    const draft = makeDraft();
    expect(migrateActorDraftToBehaviorProgram(draft)).toEqual({
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      clips: [],
      conflict_policy: "overwrite",
    });
    expect(migrateActorDraftReactionProfile(draft)).toBeNull();
  });
});

describe("reaction profile migration", () => {
  it("maps reactive_braking and the worker-only anti_plow flag to brake", () => {
    expect(migrateActorDraftReactionProfile(makeDraft({ reactive_braking: true }))).toEqual({
      mode: "brake",
      aggressiveness: 0.5,
      exempt_actor_ids: [],
    });
    expect(migrateActorDraftReactionProfile(makeDraft({ anti_plow: true }))).toEqual({
      mode: "brake",
      aggressiveness: 0.5,
      exempt_actor_ids: [],
    });
  });

  it("carries collision_target_id as an exemption, not as a braking mode", () => {
    expect(migrateActorDraftReactionProfile(makeDraft({ collision_target_id: "ped-1" }))).toEqual({
      mode: "none",
      aggressiveness: 0.5,
      exempt_actor_ids: ["ped-1"],
    });
  });

  it("produces a profile that validates", () => {
    const profile = migrateActorDraftReactionProfile(
      makeDraft({ reactive_braking: true, collision_target_id: "ped-1" }),
    );
    expect(ReactionProfileSchema.safeParse(profile).success).toBe(true);
  });
});

describe("migration is non-destructive", () => {
  it("never mutates the draft and copies the waypoint array", () => {
    const draft = makeDraft({
      placement_mode: "timed_path",
      reactive_braking: true,
      timeline: [timelineClip({ id: "clip-1", action: "set_speed", target_speed_kph: 20 })],
      timed_waypoints: [{ x: 0, y: 0, time: 0 }],
    });
    const before = structuredClone(draft);
    deepFreeze(draft);

    const result = migrateActorDraft(draft);

    expect(draft).toEqual(before);
    expect(draft.behavior).toBeUndefined();
    expect(draft.reaction_profile).toBeUndefined();
    expect(draft.timeline).toHaveLength(1);
    expect(result.behavior.clips).toHaveLength(2);
    const pathAction = result.behavior.clips[1]!.action;
    expect(pathAction.kind === "follow_path" && pathAction.waypoints).not.toBe(
      draft.timed_waypoints,
    );
  });
});

describe("actor draft wiring", () => {
  it("accepts a draft carrying a behavior program and a reaction profile", () => {
    const draft = makeDraft({
      behavior: {
        clips: [
          {
            id: "clip-1",
            trigger: { kind: "ttc", other: { actor_id: "ego" }, seconds: 1.5 },
            action: { kind: "stop" },
          },
        ],
      },
      reaction_profile: { mode: "brake_and_swerve", aggressiveness: 0.8 },
    });

    expect(draft.behavior).toEqual({
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      conflict_policy: "overwrite",
      clips: [
        {
          id: "clip-1",
          enabled: true,
          trigger: { kind: "ttc", actor: "self", other: { actor_id: "ego" }, seconds: 1.5 },
          end: { kind: "completion" },
          action: { kind: "stop" },
        },
      ],
    });
    expect(draft.reaction_profile).toEqual({
      mode: "brake_and_swerve",
      aggressiveness: 0.8,
      exempt_actor_ids: [],
    });
  });

  it("leaves both fields absent on drafts that never author them", () => {
    const draft = makeDraft();
    expect(draft.behavior).toBeUndefined();
    expect(draft.reaction_profile).toBeUndefined();
  });

  it("rejects an invalid behavior program at draft parse", () => {
    expect(
      ScenarioEditorActorDraftSchema.safeParse({
        id: "a",
        label: "a",
        kind: "vehicle",
        blueprint: "vehicle.tesla.model3",
        spawn: { road_id: "road-1" },
        behavior: { clips: [{ id: "c", action: { kind: "not_an_action" } }] },
      }).success,
    ).toBe(false);
  });
});

describe("behavior events", () => {
  it("reads a well-formed behavior_events array off an artifact body", () => {
    expect(
      readBehaviorEvents({
        frames: [],
        behavior_events: [
          { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 4.2 },
        ],
      }),
    ).toEqual([
      { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 4.2 },
    ]);
  });

  it("treats an absent or unusable array as no events, never a throw", () => {
    for (const input of [
      null,
      undefined,
      "nope",
      [],
      { frames: [] },
      { behavior_events: null },
      { behavior_events: { actor_id: "a1" } },
    ]) {
      expect(readBehaviorEvents(input)).toEqual([]);
    }
  });

  it("drops malformed entries and strips unknown worker fields", () => {
    expect(
      readBehaviorEvents({
        behavior_events: [
          { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 0 },
          { actor_id: "a1", clip_id: "c2", kind: "trigger_fired", t: -1 },
          { clip_id: "c3", kind: "trigger_fired", t: 1 },
          {
            actor_id: "a1",
            clip_id: "c4",
            kind: "clip_ended",
            t: 2,
            reason: "until_trigger",
          },
        ],
      }),
    ).toEqual([
      { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 0 },
      { actor_id: "a1", clip_id: "c4", kind: "clip_ended", t: 2 },
    ]);
  });

});
