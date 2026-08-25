import { describe, expect, it } from "vitest";

import { resolveActorMotion, resolveTurnIntents } from "../resolve-actor-motion";
import { ScenarioEditorActorDraftSchema, type ScenarioEditorActorDraft } from "../scenario-editor";

/**
 * A draft actor, defaulted through the real schema so the test cannot drift from
 * what the editor actually stores.
 */
function actor(overrides: Record<string, unknown> = {}): ScenarioEditorActorDraft {
  return ScenarioEditorActorDraftSchema.parse({
    id: "a1",
    label: "Car",
    kind: "vehicle",
    blueprint: "vehicle.tesla.model3",
    spawn: { road_id: "10", s_fraction: 0.5, world_anchor: { x: 10, y: 20, z: 0, yaw: 90 } },
    ...overrides,
  });
}

const ANCHOR = (x: number, y: number, yaw = 0) => ({
  road_id: "20",
  s_fraction: 0.5,
  world_anchor: { x, y, z: 0, yaw },
});

describe("resolved placement", () => {
  it("reads a lane anchor as a lane placement, carrying its world position", () => {
    const placement = resolveActorMotion(actor()).placement;
    expect(placement).toMatchObject({ kind: "lane", roadId: "10", sFraction: 0.5, yawDeg: 90 });
  });

  it("reads a freeform drop as a world placement", () => {
    const placement = resolveActorMotion(
      actor({
        spawn: { road_id: "", s_fraction: 0, world_anchor: { x: 5, y: 6, z: 0, yaw: 45 } },
        spawn_point: { x: 5, y: 6, z: 0 },
        spawn_yaw: 45,
      }),
    ).placement;
    expect(placement).toMatchObject({ kind: "world", yawDeg: 45 });
    expect(placement?.point).toMatchObject({ x: 5, y: 6 });
  });

  it("prefers spawn_point over the anchor's cached world position", () => {
    const placement = resolveActorMotion(
      actor({ spawn_point: { x: 99, y: 98, z: 0 }, spawn_yaw: 12 }),
    ).placement;
    // Still a LANE placement — the road id is what the runtime authenticates —
    // but the position is the explicit one.
    expect(placement).toMatchObject({ kind: "lane", yawDeg: 12 });
    expect(placement?.point).toMatchObject({ x: 99, y: 98 });
  });
});

describe("resolveActorMotion", () => {
  it("a lane-placed car with nothing else derives its runway", () => {
    const motion = resolveActorMotion(actor());
    expect(motion.baseline).toEqual({ kind: "drive", speedKph: 48.28032, timing: "ordering" });
    expect(motion.corridor).toBeNull();
    expect(motion.runwayIsDerived).toBe(true);
  });

  it("a car carrying route anchors ALSO derives its runway, and reports the anchors as hints", () => {
    // The behavioural claim of the whole model: anchors are a coarse hint the
    // lane graph fills in, not the driven polyline.
    const motion = resolveActorMotion(actor({ route: [ANCHOR(30, 40), ANCHOR(50, 60)] }));
    expect(motion.runwayIsDerived).toBe(true);
    expect(motion.corridor).toBeNull();
    expect(motion.anchorHints).toEqual([
      { x: 30, y: 40, z: 0, yawDeg: 0 },
      { x: 50, y: 60, z: 0, yawDeg: 0 },
    ]);
  });

  it("resolves autopilot-plus-route the way CARLA does, not the way the draft says", () => {
    // 257 stored actors are this shape. The worker disables autopilot whenever a
    // route is present (actor_control.py:378 + :3235), so the resolution must
    // agree with the executor rather than with the declaration.
    const motion = resolveActorMotion(actor({ autopilot: true, route: [ANCHOR(30, 40)] }));
    expect(motion.baseline.kind).toBe("drive");
    expect(motion.runwayIsDerived).toBe(true);
  });

  it("a prop and a static car are parked, with no corridor", () => {
    expect(resolveActorMotion(actor({ kind: "prop" })).baseline).toEqual({ kind: "parked" });
    expect(resolveActorMotion(actor({ is_static: true })).baseline).toEqual({ kind: "parked" });
    expect(resolveActorMotion(actor({ is_static: true })).corridor).toBeNull();
  });

  it("a walker's timed waypoints are a schedule, whatever path_timing says", () => {
    const motion = resolveActorMotion(
      actor({
        kind: "walker",
        blueprint: "walker.pedestrian.0001",
        placement_mode: "timed_path",
        path_timing: "ordering",
        timed_waypoints: [
          { x: 1, y: 1, time: 0 },
          { x: 2, y: 5, time: 3 },
        ],
      }),
    );
    expect(motion.baseline).toMatchObject({ kind: "walk", timing: "schedule" });
    // Every crossing point is freeform-by-kind and says why.
    expect(motion.corridor?.points.map((point) => point.lock)).toEqual([
      { kind: "free", reason: "pedestrian" },
      { kind: "free", reason: "pedestrian" },
    ]);
    // A schedule carries times and no per-segment speed.
    expect(motion.corridor?.points.map((point) => point.time)).toEqual([0, 3]);
  });

  it("a vehicle's timed waypoints are ORDERING unless it opted into a schedule", () => {
    const ordering = resolveActorMotion(
      actor({
        placement_mode: "timed_path",
        timed_waypoints: [
          { x: 1, y: 1, time: 0 },
          { x: 2, y: 5, time: 3 },
        ],
      }),
    );
    expect(ordering.baseline).toMatchObject({ kind: "drive", timing: "ordering" });
    // T2: under ordering the times are NOT carried, so nothing downstream can
    // read them as a schedule. This is the invariant that stopped the .xosc
    // writer emitting an absolute-time trajectory for an arc-length drive.
    expect(ordering.corridor?.points.every((point) => point.time === undefined)).toBe(true);

    const scheduled = resolveActorMotion(
      actor({
        placement_mode: "timed_path",
        path_timing: "schedule",
        timed_waypoints: [
          { x: 1, y: 1, time: 0 },
          { x: 2, y: 5, time: 3 },
        ],
      }),
    );
    expect(scheduled.baseline).toMatchObject({ timing: "schedule" });
    expect(scheduled.corridor?.points.map((point) => point.time)).toEqual([0, 3]);
  });

  it("keeps a lane-locked waypoint's lock, which is how a path becomes a route", () => {
    const motion = resolveActorMotion(
      actor({
        placement_mode: "timed_path",
        timed_waypoints: [
          { x: 1, y: 1, time: 0, snap: "lane" },
          { x: 2, y: 5, time: 3 },
        ],
      }),
    );
    expect(motion.corridor?.points.map((point) => point.lock.kind)).toEqual(["lane", "free"]);
  });

  it("builds an untimed path the way the worker builds its driven polyline", () => {
    // [spawn, ...path_placement, destination_point] — route_geometry
    // ._path_points_for_actor. Getting this wrong makes the preview and CARLA
    // disagree about where the car starts.
    const motion = resolveActorMotion(
      actor({
        placement_mode: "path",
        spawn_point: { x: 0, y: 0, z: 0 },
        path_placement: [{ x: 10, y: 0, z: 0 }],
        destination_point: { x: 20, y: 0, z: 0 },
      }),
    );
    expect(motion.corridor?.points.map((point) => [point.x, point.y])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });
});

describe("resolveTurnIntents", () => {
  it("reads turn clips in order and ignores disabled ones", () => {
    const draft = actor({
      behavior: {
        clips: [
          { id: "b", enabled: true, role: "base", trigger: { kind: "at_time", t: 0 }, end: { kind: "completion" }, action: { kind: "cruise", speed_kph: 30 } },
          { id: "t1", enabled: true, role: "interaction", trigger: { kind: "at_time", t: 5 }, end: { kind: "completion" }, action: { kind: "turn_at_next_intersection", direction: "left" } },
          { id: "t2", enabled: false, role: "interaction", trigger: { kind: "at_time", t: 9 }, end: { kind: "completion" }, action: { kind: "turn_at_next_intersection", direction: "right" } },
          { id: "t3", enabled: true, role: "interaction", trigger: { kind: "at_time", t: 12 }, end: { kind: "completion" }, action: { kind: "turn_at_next_intersection", direction: "right" } },
        ],
      },
    });
    expect(resolveTurnIntents(draft)).toEqual(["left", "right"]);
  });

  it("returns nothing for a program with no turn clips", () => {
    expect(resolveTurnIntents(actor())).toEqual([]);
  });
});

/**
 * An authored route has two homes, and only one of them was being read.
 *
 * The actor's `route` field is the obvious one. A `follow_route` base clip carries
 * its OWN `anchors`, and seven corpus scenarios keep the route only there with
 * `route` empty. Reading just the field reported those cars as carrying no
 * authored geometry at all, which is a silent data loss rather than a visible
 * failure: the corpus migration concluded it had nothing to preserve and dropped
 * them, and the equivalence gate concluded there was nothing to compare and
 * called it a pass. E6's u-turn went through a "successful" migration with its
 * out-and-back anchors still sitting untouched in the base clip.
 */
describe("resolveActorMotion — anchors on a follow_route base clip", () => {
  const anchor = (x: number, y: number) => ({
    road_id: "1",
    lane_id: -2,
    section_id: 0,
    s_fraction: 0.5,
    world_anchor: { x, y, z: 0, yaw: 90 },
  });

  it("reads anchors the base clip carries when the route field is empty", () => {
    const draft = actor({
      route: [],
      behavior: {
        clips: [
          {
            id: "c1",
            enabled: true,
            role: "base",
            trigger: { kind: "at_time", t: 0 },
            end: { kind: "completion" },
            action: { kind: "follow_route", anchors: [anchor(10, 0), anchor(20, 0)], speed_kph: 20 },
          },
        ],
      },
    });
    const motion = resolveActorMotion(draft);
    expect(motion.anchorHints.map((hint) => [hint.x, hint.y])).toEqual([
      [10, 0],
      [20, 0],
    ]);
  });

  it("keeps the route field as the leading statement when an actor carries both", () => {
    // The worker reads the field first, so the two have to be concatenated in that
    // order or a car with both drives its clip anchors before its route anchors.
    const draft = actor({
      route: [anchor(1, 0)],
      behavior: {
        clips: [
          {
            id: "c1",
            enabled: true,
            role: "base",
            trigger: { kind: "at_time", t: 0 },
            end: { kind: "completion" },
            action: { kind: "follow_route", anchors: [anchor(2, 0)], speed_kph: 20 },
          },
        ],
      },
    });
    expect(resolveActorMotion(draft).anchorHints.map((hint) => hint.x)).toEqual([1, 2]);
  });

  it("ignores a non-route base clip's payload", () => {
    const draft = actor({
      route: [],
      behavior: {
        clips: [
          {
            id: "c1",
            enabled: true,
            role: "base",
            trigger: { kind: "at_time", t: 0 },
            end: { kind: "completion" },
            action: { kind: "cruise", speed_kph: 30 },
          },
        ],
      },
    });
    expect(resolveActorMotion(draft).anchorHints).toEqual([]);
  });
});
