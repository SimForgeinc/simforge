import { buildLaneGraph, parseSimScenarioInput } from "@simforge/engine";
import { describe, expect, it } from "vitest";

import {
  applyEgoControl,
  createAuthoredWorldSession,
  prepareAuthoredEgoInput,
  selectAuthoredEgoActor,
} from "../../lib/live-world/authored-world-session";

const graph = buildLaneGraph({
  source: { xodrSha256: "fixture" },
  lanes: {},
  gates: [],
  junctions: {},
});

function vehicle(id: string, routeLengthM: number, x = 0, roleId: string | null = null) {
  return {
    id,
    kind: "car" as const,
    initial: { pose: { x, z: 0, headingRad: 0 }, speedMps: 0 },
    behavior: {
      route: {
        kind: "polyline" as const,
        points: [{ x, z: 0 }, { x: x + routeLengthM, z: 0 }],
      },
      cruiseSpeedMps: 8,
    },
    tags: roleId ? [`role:${roleId}`] : [],
  };
}

function worldInput() {
  return parseSimScenarioInput({
    mapId: "drive-control-routing",
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: 0.02,
    physics: { mode: "dynamic-v1" },
    actors: [vehicle("compiled-short", 40, 0, "selected-role"), vehicle("long", 400, 20)],
  });
}

describe("Drive control routing and ego selection", () => {
  it("honors a selected controllable actor and otherwise chooses the longest authored route", () => {
    const input = worldInput();
    expect(selectAuthoredEgoActor(input, "selected-role")).toBe("compiled-short");
    expect(selectAuthoredEgoActor(input)).toBe("long");
  });

  it("gives only the ego a stopped, extended driver-owned route while preserving every other actor", () => {
    const input = parseSimScenarioInput({
      mapId: "drive-takeover",
      clipSeconds: 20,
      warmupSeconds: 0,
      dt: 0.02,
      physics: { mode: "dynamic-v1" },
      actors: [
        {
          id: "ego",
          kind: "car",
          initial: {
            laneRef: { rsl: "10:0:-1", s: 25, tFrac: 0 },
            pose: { x: 25, z: 0, headingRad: 0 },
            speedMps: 13.4112,
          },
          behavior: {
            route: { kind: "lanePath", lanes: ["10:0:-1"] },
            cruiseSpeedMps: 13.4112,
            rules: {
              obeySignals: true,
              yield: true,
              yieldToVehicles: true,
              yieldToPedestrians: true,
              collisionAvoidance: true,
              aggression: 0.5,
              speedFactor: 1,
            },
          },
        },
        vehicle("other", 300, 50),
      ],
    });

    const takeover = prepareAuthoredEgoInput(input, "ego");
    const ego = takeover.actors.find((actor) => actor.id === "ego")!;
    expect(ego.initial.speedMps).toBe(0);
    expect(ego.behavior.cruiseSpeedMps).toBe(0);
    expect(ego.behavior.route).toEqual({
      kind: "follow",
      startRsl: "10:0:-1",
      turns: [],
      maxLengthM: 2000,
    });
    expect(ego.behavior.rules.obeySignals).toBe(true);
    expect(takeover.actors.find((actor) => actor.id === "other"))
      .toEqual(input.actors.find((actor) => actor.id === "other"));
  });

  it("rejects a mismatched control target and moves the designated ego under held throttle", () => {
    const input = worldInput();
    const world = createAuthoredWorldSession(input, graph);
    expect(() => applyEgoControl(world, "compiled-short", {
      actorId: "long",
      steer: 0,
      throttle: 1,
      brake: 0,
    }, 0)).toThrow(/not the designated ego/);

    const outcome = applyEgoControl(world, "compiled-short", {
      actorId: "compiled-short",
      steer: 0,
      throttle: 1,
      brake: 0,
    }, 1);
    expect(outcome).toEqual({ ok: true });
    world.advance(50);
    const ego = world.snapshot().actors.find((actor) => actor.id === "compiled-short")!;
    expect(ego.speedMps).toBeGreaterThan(0);
    expect(ego.x).toBeGreaterThan(0);
  });
});
