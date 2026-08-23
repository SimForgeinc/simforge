import { describe, expect, it } from "vitest";
import { ScenarioInteractionRelocationRequestSchema } from "../scenario-interaction-relocation";

const actor = (id: string) => ({
  id,
  label: id,
  kind: "vehicle" as const,
  role: id === "ego" ? ("ego" as const) : ("traffic" as const),
  is_static: false,
  placement_mode: "road" as const,
  blueprint: "vehicle.test",
  spawn: { road_id: "1", section_id: 0, lane_id: -1, s_fraction: 0.2 },
  route: [],
  route_direction: "forward" as const,
  lane_facing: "with_lane" as const,
  speed_kph: 20,
  autopilot: true,
  timeline: [],
  sensors: [],
});

const baseRequest = {
  sourceActors: [actor("ego"), actor("conflict")],
  targetPoint: { x: 1, y: 2 },
};

describe("ScenarioInteractionRelocationRequestSchema", () => {
  it("accepts a server-issued semantic movement target without changing legacy callers", () => {
    expect(ScenarioInteractionRelocationRequestSchema.safeParse(baseRequest).success).toBe(true);
    expect(
      ScenarioInteractionRelocationRequestSchema.parse({
        ...baseRequest,
        targetSemantic: {
          kind: "movement",
          graphRevision: "semantic-graph-v2",
          movementId: "movement-12",
          variantId: "variant-3",
        },
      }).targetSemantic,
    ).toEqual({
      kind: "movement",
      graphRevision: "semantic-graph-v2",
      movementId: "movement-12",
      variantId: "variant-3",
    });
  });

  it("rejects partial, blank, and extensible semantic target identities", () => {
    for (const targetSemantic of [
      { kind: "movement", graphRevision: "", movementId: "movement-12" },
      { kind: "movement", graphRevision: "v2", movementId: "" },
      { kind: "junction", graphRevision: "v2", movementId: "movement-12" },
      {
        kind: "movement",
        graphRevision: "v2",
        movementId: "movement-12",
        arbitrary: true,
      },
    ]) {
      expect(
        ScenarioInteractionRelocationRequestSchema.safeParse({
          ...baseRequest,
          targetSemantic,
        }).success,
      ).toBe(false);
    }
  });
});
