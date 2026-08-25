import { describe, expect, it } from "vitest";
import {
  GeneratedScenarioMetadataSchema,
  ScenarioMetadataSchema,
} from "../index";

const generatedMetadata = {
  schema_version: "simforge.scenario-metadata.v1",
  odd: {
    road_type: "urban",
    junction_types: ["signalized_intersection", "pedestrian_crossing"],
    speed_range_kph: { min: 0, max: 35 },
    weather: { precipitation: 0.55, fog: 0.2, wetness: 0.75 },
    lighting: "daylight",
    traffic_density: "medium",
  },
  tags: {
    actor_types: ["vehicle", "pedestrian"],
    maneuver: ["lane_keep"],
    interaction_type: "vehicle_pedestrian",
    legality: "compliant",
    occlusion: "partial",
    relative_direction: "crossing",
    criticality: 4,
    environmental: ["wet_raining", "traffic_medium"],
    source: {
      type: "generator",
      reference: "family:pedestrian_crossing",
      confidence: 1,
    },
  },
  testCase: {
    objective: "Yield to the crossing pedestrian.",
    expected_ego_outcomes: [
      {
        no_collision: true,
        remain_in_lane: true,
        yield_to_pedestrian: true,
        max_decel_mps2: 8,
        min_clearance_m: 1,
      },
    ],
    metrics: [
      "collision",
      "lane_departure",
      "yield_compliance",
      "minimum_clearance",
    ],
    seed: 42,
    generator: { id: "simforge.batch_collision", version: "1" },
    softwareVersions: {
      workerImageDigest: "sha256:abc",
      mapBundleVersion: "maps-2026-07",
    },
  },
} as const;

describe("ScenarioMetadataSchema", () => {
  it("accepts the ISO-aligned subset and complete generated form", () => {
    expect(ScenarioMetadataSchema.parse(generatedMetadata)).toEqual(
      generatedMetadata,
    );
    expect(
      GeneratedScenarioMetadataSchema.safeParse(generatedMetadata).success,
    ).toBe(true);
  });

  it("is optional-tolerant for progressive authoring", () => {
    expect(
      ScenarioMetadataSchema.parse({
        schema_version: "simforge.scenario-metadata.v1",
        testCase: {
          expected_ego_outcomes: [{ no_collision: true }],
        },
      }),
    ).toEqual({
      schema_version: "simforge.scenario-metadata.v1",
      testCase: {
        expected_ego_outcomes: [{ no_collision: true }],
      },
    });
  });

  it("requires weather, tag core fields, seed, and generator at generated emission", () => {
    expect(
      GeneratedScenarioMetadataSchema.safeParse({
        ...generatedMetadata,
        odd: { road_type: "urban" },
      }).success,
    ).toBe(false);
    expect(
      GeneratedScenarioMetadataSchema.safeParse({
        ...generatedMetadata,
        tags: { criticality: 4 },
      }).success,
    ).toBe(false);
    expect(
      GeneratedScenarioMetadataSchema.safeParse({
        ...generatedMetadata,
        testCase: { objective: "Yield." },
      }).success,
    ).toBe(false);
  });

  it("reuses CARLA weather ranges and rejects invalid criticality", () => {
    expect(
      ScenarioMetadataSchema.safeParse({
        ...generatedMetadata,
        odd: {
          ...generatedMetadata.odd,
          weather: { precipitation: 1.1, fog: 0, wetness: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      ScenarioMetadataSchema.safeParse({
        ...generatedMetadata,
        tags: { ...generatedMetadata.tags, criticality: 6 },
      }).success,
    ).toBe(false);
  });
});
