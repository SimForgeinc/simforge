import { describe, expect, it } from "vitest";
import type { ActorView } from "@uniscenarios/city-renderer";
import type { SumoAuthoredOccupancySource } from "@uniscenarios/sim-engine";
import { SumoCollisionPhysics } from "./sumoCollisionPhysics";

type SumoExternalActorView = SumoAuthoredOccupancySource;

function authored(
  overrides: Partial<SumoExternalActorView> = {},
): SumoExternalActorView {
  return {
    id: "authored:ego",
    kind: "car",
    x: 2,
    z: 0,
    headingRad: 0,
    speedMps: 12,
    lengthM: 4.8,
    widthM: 1.9,
    static: false,
    present: true,
    ...overrides,
  };
}

function sumo(overrides: Partial<ActorView> = {}): ActorView {
  return {
    id: "sumo:00000001",
    catalogId: "vehicle.sedan",
    kind: "car",
    x: 6,
    y: 0,
    z: 0,
    headingRad: 0,
    speedMps: 2,
    dims: { l: 4.55, w: 1.82, h: 1.48 },
    ...overrides,
  };
}

describe("SUMO collision physics handoff", () => {
  it("transfers an authored rear impact into a moving external body", () => {
    const physics = new SumoCollisionPhysics();
    physics.step(0.05, [authored()], [sumo()]);

    expect(physics.actorCount).toBe(1);
    const [view] = physics.composeViews([sumo()], () => 1.25);
    expect(view).toMatchObject({
      id: "sumo:00000001",
      y: 1.25,
      indicator: "hazard",
    });
    expect(view!.speedMps).toBeGreaterThan(2);
    const [occupancy] = physics.externalActors();
    expect(occupancy).toMatchObject({
      id: "physics:sumo:00000001",
      kind: "vehicle",
      routeId: "proxy-route",
    });
    expect(occupancy!.speedMetersPerSecond).toBeCloseTo(view!.speedMps!, 8);
    const [authoredView] = physics.authoredViews(() => 1.25);
    expect(authoredView).toMatchObject({
      id: "authored:ego",
      y: 1.25,
      indicator: "hazard",
    });
    expect(authoredView!.speedMps).toBeLessThan(12);
  });

  it("ignores future authored trajectory commands after contact", () => {
    const physics = new SumoCollisionPhysics();
    physics.step(0.05, [authored()], [sumo()]);
    const before = physics.authoredViews(() => 0)[0]!;

    physics.step(
      0.25,
      [authored({ x: 100, z: 40, speedMps: 30 })],
      [sumo({ x: 7 })],
    );
    const after = physics.authoredViews(() => 0)[0]!;
    const [occupancy] = physics.composeAuthoredSources([
      authored({ x: 100, z: 40, speedMps: 30 }),
    ]);

    expect(after.x).toBeLessThan(10);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.speedMps).toBeLessThan(before.speedMps!);
    expect(occupancy!.x).toBe(after.x);
    expect(occupancy!.speedMps).toBe(after.speedMps);
  });

  it("does not hand traffic control off for a stationary authored overlap", () => {
    const physics = new SumoCollisionPhysics();
    physics.step(0.05, [authored({ speedMps: 0 })], [sumo()]);
    expect(physics.actorCount).toBe(0);
    expect(physics.composeViews([sumo()], () => 0)).toEqual([sumo()]);
  });

  it("integrates and slows the displaced body deterministically", () => {
    const run = () => {
      const physics = new SumoCollisionPhysics();
      physics.step(0.05, [authored()], [sumo()]);
      const before = physics.composeViews([sumo()], () => 0)[0]!;
      physics.step(0.5, [], [sumo({ x: 7 })]);
      const after = physics.composeViews([sumo({ x: 7 })], () => 0)[0]!;
      return { before, after, external: physics.externalActors() };
    };
    const first = run();
    const second = run();

    expect(first.after.x).toBeGreaterThan(first.before.x);
    expect(first.after.speedMps!).toBeLessThan(first.before.speedMps!);
    expect(first).toEqual(second);
  });

  it("turns a vehicle after an off-center side impact", () => {
    const physics = new SumoCollisionPhysics();
    const target = sumo({ x: 0, z: 0, headingRad: 0 });
    physics.step(
      0.05,
      [authored({ x: 0.7, z: -3, headingRad: Math.PI / 2 })],
      [target],
    );
    const before = physics.composeViews([target], () => 0)[0]!;
    physics.step(0.2, [], [target]);
    const after = physics.composeViews([target], () => 0)[0]!;

    expect(physics.actorCount).toBe(1);
    expect(Math.abs(after.headingRad - before.headingRad)).toBeGreaterThan(0.01);
  });

  it("promotes nearby SUMO traffic when a released body causes a pile-up", () => {
    const physics = new SumoCollisionPhysics();
    const first = sumo();
    const second = sumo({ id: "sumo:00000002", x: 11, speedMps: 0 });
    physics.step(0.05, [authored()], [first, second]);
    for (let index = 0; index < 20 && physics.actorCount < 2; index += 1) {
      physics.step(0.1, [], [first, second]);
    }

    expect(physics.actorCount).toBe(2);
    expect(physics.externalActors().map((actor) => actor.id).sort()).toEqual([
      "physics:sumo:00000001",
      "physics:sumo:00000002",
    ]);
  });

  it("stops released vehicles at static map collision geometry", () => {
    const physics = new SumoCollisionPhysics();
    physics.setStaticColliders([{
      id: "barrier",
      class: "barrier",
      obb: {
        center: { x: 10, z: 0 },
        lengthM: 0.4,
        widthM: 8,
        headingRad: 0,
      },
    }]);
    physics.step(0.05, [authored()], [sumo()]);
    for (let index = 0; index < 30; index += 1) {
      physics.step(0.1, [], [sumo()]);
    }
    const displaced = physics.composeViews([sumo()], () => 0)[0]!;

    expect(displaced.x).toBeLessThan(10);
    expect(displaced.speedMps).toBeLessThan(1);
  });

  it("restores native SUMO ownership when the run resets", () => {
    const physics = new SumoCollisionPhysics();
    physics.step(0.05, [authored()], [sumo()]);
    physics.clear();
    expect(physics.actorCount).toBe(0);
    expect(physics.externalActors()).toEqual([]);
    expect(physics.composeViews([sumo()], () => 0)).toEqual([sumo()]);
  });
});
