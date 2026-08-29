import { z } from "zod-v3";

/** Preset list of traffic engines for simulating traffic in a scenario simulation. */
export const TrafficEngine = z.enum(["CARLA_TRAFFIC"]);
export type TrafficEngine = z.infer<typeof TrafficEngine>;

export const TRAFFIC_ENGINE_VALUES: readonly TrafficEngine[] =
  TrafficEngine.options;

export const TrafficDensity = z.enum(["light", "moderate", "heavy"]);
export type TrafficDensity = z.infer<typeof TrafficDensity>;

export const TrafficAggressiveness = z.enum(["calm", "normal", "aggressive"]);
export type TrafficAggressiveness = z.infer<typeof TrafficAggressiveness>;

export const VehicleMixPreset = z.enum(["cars_only", "mixed", "custom"]);
export type VehicleMixPreset = z.infer<typeof VehicleMixPreset>;

/**
 * Optional user intent for traffic. Encodes what the user wants (e.g. density, behavior).
 * Engine-agnostic; may be used to pre-populate engine-specific config.
 */
export const TrafficManagerIntentSchema = z
  .object({
    description: z.string().optional(),
    density: z
      .union([z.enum(["low", "medium", "high"]), TrafficDensity])
      .optional(),
    aggressiveness: TrafficAggressiveness.optional(),
    spawnBehavior: z.string().optional(),
  })
  .optional();
export type TrafficManagerIntent = z.infer<typeof TrafficManagerIntentSchema>;

/** Traffic distribution hint. Weight values across all entries should sum to ~1.0. */
export const TrafficDistributionEntrySchema = z.object({
  entityCategory: z.enum([
    "car",
    "van",
    "truck",
    "bus",
    "motorbike",
    "bicycle",
    "pedestrian",
  ]),
  weight: z.number().min(0).max(1),
});
export type TrafficDistributionEntry = z.infer<
  typeof TrafficDistributionEntrySchema
>;

/**
 * Cross-engine population hint.
 * Every traffic engine can interpret vehicle/pedestrian counts and a seed.
 */
export const TrafficPopulationSchema = z.object({
  vehicles: z.number().int().min(0).optional(),
  pedestrians: z.number().int().min(0).optional(),
  seed: z.number().int().optional(),
});
export type TrafficPopulation = z.infer<typeof TrafficPopulationSchema>;

export const TrafficCardVehicleMixSchema = z.object({
  type: z.enum(["passenger", "truck", "bus"]),
  weight: z.number().min(0).max(1),
});
export type TrafficCardVehicleMix = z.infer<
  typeof TrafficCardVehicleMixSchema
>;

export const TrafficCardLaneSelectionSchema = z.object({
  roadId: z.string().min(1),
  sectionId: z.number().int().nullable().optional(),
  laneId: z.number().int().nullable().optional(),
  laneType: z.string().nullable().optional(),
  label: z.string().optional(),
  selectedFraction: z.number().min(0).max(1).optional(),
});
export type TrafficCardLaneSelection = z.infer<
  typeof TrafficCardLaneSelectionSchema
>;

export const CarlaTrafficCardSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  engine: z.literal("CARLA_TRAFFIC"),
  enabled: z.boolean().default(true),
});
export type CarlaTrafficCard = z.infer<typeof CarlaTrafficCardSchema>;

export const TrafficCardSchema = CarlaTrafficCardSchema;
export type TrafficCard = z.infer<typeof TrafficCardSchema>;

/**
 * Traffic manager: engine-agnostic intent + cross-engine population/distribution
 * + opaque engine-specific config.
 *
 * The `engineConfigJson` field stores engine-specific configuration as a JSON string.
 * Use the exported `parseCarlaTrafficConfig()` helper to deserialise and
 * validate it at runtime.
 */
export const TrafficManagerSchema = z.object({
  intent: TrafficManagerIntentSchema,
  engine: TrafficEngine,
  population: TrafficPopulationSchema.optional(),
  trafficDistribution: z
    .array(TrafficDistributionEntrySchema)
    .optional(),
  /** Engine-specific config serialised as a JSON string. */
  engineConfigJson: z.string().optional(),
});
export type TrafficManager = z.infer<typeof TrafficManagerSchema>;

// ---------------------------------------------------------------------------
// Engine-specific validation schemas (runtime helpers, not baked into the type)
// ---------------------------------------------------------------------------

/** Spawn strategy: use map spawn points, a bounding box in map coords, or a polygon. */
export const CarlaSpawnStrategySchema = z.union([
  z.object({ strategy: z.literal("MAP_SPAWN_POINTS") }),
  z.object({
    strategy: z.literal("REGION_BBOX"),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  z.object({
    strategy: z.literal("REGION_POLYGON"),
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
  }),
]);
export type CarlaSpawnStrategy = z.infer<typeof CarlaSpawnStrategySchema>;

/** CARLA-specific traffic config. Validated at runtime via `parseCarlaTrafficConfig()`. */
export const CarlaTrafficConfigSchema = z.object({
  population: z.object({
    vehicles: z.number().int().min(0),
    pedestrians: z.number().int().min(0),
    seed: z.number().int().optional(),
    spawn: CarlaSpawnStrategySchema,
    vehicleBlueprintFilters: z.array(z.string()).optional(),
    pedestrianBlueprintFilters: z.array(z.string()).optional(),
  }),
  trafficManager: z.object({
    port: z.number().int().optional(),
    synchronousMode: z.boolean(),
    globalDistanceToLeadingVehicle: z.number().min(0).optional(),
    globalPercentageSpeedDifference: z.number().optional(),
    hybridPhysicsMode: z.boolean().optional(),
    hybridPhysicsRadius: z.number().min(0).nullable().optional(),
  }),
});
export type CarlaTrafficConfig = z.infer<typeof CarlaTrafficConfigSchema>;

// ---------------------------------------------------------------------------
// Runtime parse helpers
// ---------------------------------------------------------------------------

/** Parse `engineConfigJson` for a CARLA traffic manager. Throws on invalid data. */
export function parseCarlaTrafficConfig(
  tm: TrafficManager,
): CarlaTrafficConfig {
  if (tm.engine !== "CARLA_TRAFFIC") {
    throw new Error(`Expected CARLA_TRAFFIC engine, got ${tm.engine}`);
  }
  return CarlaTrafficConfigSchema.parse(JSON.parse(tm.engineConfigJson ?? "{}"));
}

/**
 * Parse engine config as a plain object (any engine).
 * Returns undefined if no config is stored.
 */
export function parseEngineConfig(
  tm: TrafficManager,
): Record<string, unknown> | undefined {
  if (!tm.engineConfigJson) return undefined;
  return JSON.parse(tm.engineConfigJson) as Record<string, unknown>;
}
