import { z } from "zod";
import { CarlaWeatherSchema } from "./carla-weather";

export const SCENARIO_METADATA_SCHEMA_VERSION =
  "simforge.scenario-metadata.v1" as const;

export const ScenarioMetadataRoadTypeSchema = z.enum([
  "urban",
  "rural",
  "highway",
  "residential",
  "parking_area",
  "unknown",
]);

export const ScenarioMetadataJunctionTypeSchema = z.enum([
  "signalized_intersection",
  "unsignalized_intersection",
  "roundabout",
  "merge",
  "diverge",
  "pedestrian_crossing",
]);

export const ScenarioMetadataLightingSchema = z.enum([
  "daylight",
  "dawn",
  "dusk",
  "night",
  "artificial",
  "unknown",
]);

/**
 * ISO 34503-aligned ODD subset. The three weather values intentionally reuse
 * the canonical CARLA numeric field contracts so stored metadata and runtime
 * render configuration cannot disagree on units or ranges.
 */
export const ScenarioOddSchema = z
  .object({
    road_type: ScenarioMetadataRoadTypeSchema.optional(),
    junction_types: z.array(ScenarioMetadataJunctionTypeSchema).optional(),
    speed_range_kph: z
      .object({
        min: z.number().nonnegative().optional(),
        max: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    weather: z
      .object({
        precipitation: CarlaWeatherSchema.shape.rain.optional(),
        fog: CarlaWeatherSchema.shape.fog_density.optional(),
        wetness: CarlaWeatherSchema.shape.wetness.optional(),
      })
      .strict()
      .optional(),
    lighting: ScenarioMetadataLightingSchema.optional(),
    traffic_density: z.enum(["none", "low", "medium", "high"]).optional(),
  })
  .strict();

export const ScenarioMetadataInteractionTypeSchema = z.enum([
  "none",
  "vehicle_vehicle",
  "vehicle_pedestrian",
  "vehicle_cyclist",
  "vehicle_motorcyclist",
  "multi_actor",
]);

export const ScenarioMetadataLegalitySchema = z.enum([
  "compliant",
  "illegal",
  "mixed",
  "diagnostic",
  "unknown",
]);

export const ScenarioMetadataOcclusionSchema = z.enum([
  "none",
  "partial",
  "full",
  "unknown",
]);

export const ScenarioMetadataRelativeDirectionSchema = z.enum([
  "same_direction",
  "opposing",
  "crossing",
  "merging",
  "diverging",
  "stationary",
  "unknown",
]);

export const ScenarioMetadataSourceSchema = z
  .object({
    type: z
      .enum(["generator", "human_authored", "imported", "backfill"])
      .optional(),
    reference: z.string().trim().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/** ISO 34504-style structured classification tags. */
export const ScenarioTagsSchema = z
  .object({
    actor_types: z.array(z.string().trim().min(1)).optional(),
    maneuver: z.array(z.string().trim().min(1)).optional(),
    interaction_type: ScenarioMetadataInteractionTypeSchema.optional(),
    legality: ScenarioMetadataLegalitySchema.optional(),
    occlusion: ScenarioMetadataOcclusionSchema.optional(),
    relative_direction: ScenarioMetadataRelativeDirectionSchema.optional(),
    criticality: z.number().int().min(1).max(5).optional(),
    environmental: z.array(z.string().trim().min(1)).optional(),
    source: ScenarioMetadataSourceSchema.optional(),
  })
  .strict();

export const ScenarioExpectedEgoOutcomeSchema = z
  .object({
    no_collision: z.boolean().optional(),
    remain_in_lane: z.boolean().optional(),
    yield_to_pedestrian: z.boolean().optional(),
    max_decel_mps2: z.number().nonnegative().optional(),
    min_clearance_m: z.number().nonnegative().optional(),
  })
  .strict();

export const ScenarioMetricSchema = z.enum([
  "collision",
  "lane_departure",
  "yield_compliance",
  "max_deceleration",
  "minimum_clearance",
  "route_completion",
  "intended_contact",
]);

export const ScenarioTestCaseSchema = z
  .object({
    objective: z.string().trim().min(1).optional(),
    expected_ego_outcomes: z
      .array(ScenarioExpectedEgoOutcomeSchema)
      .optional(),
    metrics: z.array(ScenarioMetricSchema).optional(),
    seed: z.union([z.string().trim().min(1), z.number().int()]).optional(),
    generator: z
      .object({
        id: z.string().trim().min(1).optional(),
        version: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    softwareVersions: z
      .object({
        workerImageDigest: z.string().trim().min(1).optional(),
        mapBundleVersion: z.string().trim().min(1).optional(),
        runtimeCatalogVersion: z.string().trim().min(1).optional(),
        compilerVersion: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Progressive authoring contract. Blocks and fields may be omitted while a
 * hand-authored draft is incomplete; generated output uses the stricter form
 * below at its emission boundary.
 */
export const ScenarioMetadataSchema = z
  .object({
    schema_version: z.literal(SCENARIO_METADATA_SCHEMA_VERSION),
    odd: ScenarioOddSchema.optional(),
    tags: ScenarioTagsSchema.optional(),
    testCase: ScenarioTestCaseSchema.optional(),
  })
  .strict();

const GeneratedScenarioTagsSchema = ScenarioTagsSchema.extend({
  actor_types: z.array(z.string().trim().min(1)),
  maneuver: z.array(z.string().trim().min(1)),
  interaction_type: ScenarioMetadataInteractionTypeSchema,
  legality: ScenarioMetadataLegalitySchema,
  occlusion: ScenarioMetadataOcclusionSchema,
  relative_direction: ScenarioMetadataRelativeDirectionSchema,
  criticality: z.number().int().min(1).max(5),
  environmental: z.array(z.string().trim().min(1)),
  source: ScenarioMetadataSourceSchema.extend({
    type: z.enum(["generator", "human_authored", "imported", "backfill"]),
    reference: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
  }),
});

const GeneratedScenarioTestCaseSchema = ScenarioTestCaseSchema.extend({
  seed: z.union([z.string().trim().min(1), z.number().int()]),
  generator: z
    .object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
    })
    .strict(),
});

/** Required generated-output subset enforced at the M2.1 emission choke point. */
export const GeneratedScenarioMetadataSchema = ScenarioMetadataSchema.extend({
  odd: ScenarioOddSchema.extend({
    weather: z
      .object({
        precipitation: CarlaWeatherSchema.shape.rain,
        fog: CarlaWeatherSchema.shape.fog_density,
        wetness: CarlaWeatherSchema.shape.wetness,
      })
      .strict(),
  }),
  tags: GeneratedScenarioTagsSchema,
  testCase: GeneratedScenarioTestCaseSchema,
});

export type ScenarioMetadata = z.infer<typeof ScenarioMetadataSchema>;
export type GeneratedScenarioMetadata = z.infer<
  typeof GeneratedScenarioMetadataSchema
>;
