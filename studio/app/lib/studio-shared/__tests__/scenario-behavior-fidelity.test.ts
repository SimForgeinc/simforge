import { describe, expect, it } from "vitest";

import {
  BEHAVIOR_ACTION_KINDS,
  type BehaviorAction,
  type BehaviorClip,
  type BehaviorTrigger,
} from "../scenario-behavior";
import {
  clipFidelity,
  fidelityContextForActor,
  hasFidelityLoss,
  signalPlanFidelity,
  summarizeFidelity,
} from "../scenario-behavior-fidelity";
import type { JunctionMovementBinding } from "../scenario-signals";
import type { ScenarioEditorActorDraft } from "../scenario-editor";

function clip(
  action: BehaviorAction,
  overrides: Partial<BehaviorClip> = {},
): BehaviorClip {
  return {
    id: "c1",
    enabled: true,
    trigger: { kind: "at_time", t: 0 },
    end: { kind: "completion" },
    action,
    ...overrides,
  };
}

const PROXIMITY: BehaviorTrigger = {
  kind: "proximity",
  other: { actor_id: "ego" },
  distance_m: 20,
  mode: "closer",
  actor: "self",
};

describe("clipFidelity", () => {
  it("has a verdict for every action kind, with a non-empty reason", () => {
    // The switch is exhaustive by construction; this proves it stays that way at
    // runtime too, and that nothing ships a blank tooltip.
    const samples: Record<string, BehaviorAction> = {
      cruise: { kind: "cruise", speed_kph: 40 },
      stop: { kind: "stop" },
      creep: { kind: "creep", speed_kph: 5 },
      reverse: { kind: "reverse", speed_kph: 10 },
      hold: { kind: "hold" },
      lane_change: { kind: "lane_change", direction: "left" },
      lane_offset: { kind: "lane_offset", offset_m: -1 },
      turn_at_next_intersection: { kind: "turn_at_next_intersection", direction: "left" },
      follow_route: {
        kind: "follow_route",
        anchors: [{ road_id: "1", s_fraction: 0.5, world_anchor: { x: 0, y: 0, z: 0, yaw: 0 } }],
      },
      follow_path: { kind: "follow_path", waypoints: [{ x: 0, y: 0 }], timed: false },
      go_to: { kind: "go_to", point: { x: 1, y: 1 } },
      divert_path: { kind: "divert_path", waypoints: [{ x: 0, y: 0 }] },
      yield_to: { kind: "yield_to", actor: { actor_id: "ego" }, gap_m: 5 },
      follow_actor: { kind: "follow_actor", actor: { actor_id: "ego" }, headway_s: 2 },
      intercept: { kind: "intercept", actor: { actor_id: "ego" } },
      cut_in: { kind: "cut_in", actor: { actor_id: "ego" }, side: "left" },
      avoid: { kind: "avoid", target: { actor_id: "ego" }, side: "left", clearance_m: 1 },
      autopilot: { kind: "autopilot", enabled: true },
      walk_path: { kind: "walk_path", waypoints: [{ x: 0, y: 0 }] },
    };
    for (const kind of BEHAVIOR_ACTION_KINDS) {
      const action = samples[kind];
      expect(action, `no sample for action kind "${kind}"`).toBeDefined();
      const verdict = clipFidelity(clip(action!));
      expect(verdict.reason.length, kind).toBeGreaterThan(10);
    }
  });

  it("scores the reactive family captured-only and cut_in faithful", () => {
    // The whole point of the split: `cut_in` composes to a real LaneChangeAction,
    // while yielding/following/avoiding depend on another actor's live state and
    // export as nothing at all.
    expect(
      clipFidelity(clip({ kind: "yield_to", actor: { actor_id: "ego" }, gap_m: 5 })).fidelity,
    ).toBe("captured_only");
    expect(
      clipFidelity(clip({ kind: "follow_actor", actor: { actor_id: "ego" }, headway_s: 2 }))
        .fidelity,
    ).toBe("captured_only");
    expect(
      clipFidelity(clip({ kind: "avoid", target: { actor_id: "v" }, side: "left", clearance_m: 1 }))
        .fidelity,
    ).toBe("captured_only");
    expect(
      clipFidelity(clip({ kind: "cut_in", actor: { actor_id: "ego" }, side: "left", gap_m: 10 }))
        .fidelity,
    ).toBe("faithful");
    expect(clipFidelity(clip({ kind: "intercept", actor: { actor_id: "ego" } })).fidelity).toBe(
      "approximated",
    );
  });

  it("downgrades a junction turn without resolved route geometry", () => {
    const turn = clip({ kind: "turn_at_next_intersection", direction: "left" });
    expect(clipFidelity(turn, { hasResolvedRouteGeometry: true }).fidelity).toBe("faithful");
    expect(clipFidelity(turn, { hasResolvedRouteGeometry: false }).fidelity).toBe("approximated");
  });

  it("downgrades a route whose anchors carry no world position", () => {
    // The world_anchor doctrine: a road id is a cache key, not a position.
    const unanchored = clip({
      kind: "follow_route",
      anchors: [{ road_id: "7", s_fraction: 0.5 }],
    });
    expect(clipFidelity(unanchored).fidelity).toBe("approximated");
  });

  it("downgrades a world-anchored route when its lane-graph corridor did not resolve", () => {
    const routed = clip({
      kind: "follow_route",
      anchors: [
        { road_id: "7", s_fraction: 0.5, world_anchor: { x: 0, y: 0 } },
        { road_id: "8", s_fraction: 0.5, world_anchor: { x: 10, y: 0 } },
      ],
    });
    expect(clipFidelity(routed, { hasResolvedRouteGeometry: true }).fidelity).toBe(
      "faithful",
    );
    expect(clipFidelity(routed, { hasResolvedRouteGeometry: false }).fidelity).toBe(
      "approximated",
    );
  });

  it("downgrades a lane offset whose auto-return cannot be scheduled", () => {
    const action: BehaviorAction = { kind: "lane_offset", offset_m: -1, return_after_s: 2 };
    expect(clipFidelity(clip(action)).fidelity).toBe("faithful");
    expect(clipFidelity(clip(action, { trigger: PROXIMITY })).fidelity).toBe("approximated");
  });

  it("downgrades a duration on a condition-started clip", () => {
    // OSC StopTrigger conditions are absolute simulation time, so "4 s after this
    // fires" has nothing to measure against — the writer drops the duration, and
    // the badge has to say so or it would contradict the exported file.
    const timed = clip({ kind: "cruise", speed_kph: 30 }, { end: { kind: "duration", seconds: 4 } });
    expect(clipFidelity(timed).fidelity).toBe("faithful");
    const conditional = clipFidelity(
      clip({ kind: "cruise", speed_kph: 30 }, { trigger: PROXIMITY, end: { kind: "duration", seconds: 4 } }),
    );
    expect(conditional.fidelity).toBe("approximated");
    expect(conditional.reason).toMatch(/duration is dropped/);
  });
});

describe("fidelityContextForActor", () => {
  function actor(overrides: Partial<ScenarioEditorActorDraft>): ScenarioEditorActorDraft {
    return {
      id: "a",
      label: "a",
      kind: "vehicle",
      role: "traffic",
      is_static: false,
      placement_mode: "road",
      blueprint: "vehicle.lincoln.mkz",
      spawn: { road_id: "1", s_fraction: 0.5 },
      route: [],
      route_direction: "forward",
      lane_facing: "with_lane",
      speed_kph: 40,
      autopilot: true,
      timeline: [],
      sensors: [],
      ...overrides,
    } as ScenarioEditorActorDraft;
  }

  it("needs at least two world-anchored route entries", () => {
    const anchor = (x: number) => ({
      road_id: "1",
      s_fraction: 0.5,
      world_anchor: { x, y: 0, z: 0, yaw: 0 },
    });
    expect(fidelityContextForActor(actor({ route: [] })).hasResolvedRouteGeometry).toBe(false);
    expect(
      fidelityContextForActor(actor({ route: [anchor(0)] })).hasResolvedRouteGeometry,
    ).toBe(false);
    expect(
      fidelityContextForActor(actor({ route: [anchor(0), anchor(10)] })).hasResolvedRouteGeometry,
    ).toBe(true);
    // A road id with no world position does not count, however many there are.
    expect(
      fidelityContextForActor(
        actor({ route: [{ road_id: "1", s_fraction: 0.1 }, { road_id: "2", s_fraction: 0.9 }] }),
      ).hasResolvedRouteGeometry,
    ).toBe(false);
  });
});

describe("signalPlanFidelity", () => {
  function movement(signalIds: string[]): JunctionMovementBinding {
    return {
      movement_id: "1.0.r:straight",
      approach_id: "1.0.r",
      turn: "straight",
      label: "NB through",
      approach_lane_rsls: [],
      exit_lane_rsls: [],
      signal_ids: signalIds,
      approach_heading_deg: 0,
      exit_heading_deg: 0,
      conflicts_with: [],
    };
  }

  it("calls map_default faithful — it commands nothing", () => {
    expect(signalPlanFidelity({ mode: "map_default", movements: [] }).fidelity).toBe("faithful");
  });

  it("is approximated without a verification set, faithful with one", () => {
    const plan = { mode: "static" as const, movements: [movement(["101"])] };
    expect(signalPlanFidelity(plan).fidelity).toBe("approximated");
    expect(signalPlanFidelity(plan, new Set(["101"])).fidelity).toBe("faithful");
    expect(signalPlanFidelity(plan, new Set(["999"])).fidelity).toBe("approximated");
  });

  it("reports how many heads were dropped on a partial match", () => {
    const verdict = signalPlanFidelity(
      { mode: "static", movements: [movement(["101", "102", "999"])] },
      new Set(["101", "102"]),
    );
    expect(verdict.fidelity).toBe("approximated");
    expect(verdict.reason).toMatch(/1 of this junction's 3 signal ids/);
  });
});

describe("summarizeFidelity", () => {
  it("counts verdicts and flags any loss", () => {
    const summary = summarizeFidelity(["faithful", "faithful", "approximated", "captured_only"]);
    expect(summary).toEqual({ faithful: 2, approximated: 1, captured_only: 1 });
    expect(hasFidelityLoss(summary)).toBe(true);
    expect(hasFidelityLoss(summarizeFidelity(["faithful"]))).toBe(false);
  });
});
