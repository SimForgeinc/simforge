import { z } from "zod-v3";

import {
  TrafficAggressiveness,
  TrafficDensity,
  VehicleMixPreset,
  type TrafficCardVehicleMix,
} from "./traffic-manager";

export const DENSITY_VEHICLE_COUNTS: Readonly<Record<TrafficDensity, number>> = {
  light: 10,
  moderate: 30,
  heavy: 60,
};

/** Cars per actor used only when the editor seeds a new scenario. */
export const DEFAULT_SEEDED_CARS_PER_ACTOR = 12;

/** SUMO behavior parameters associated with each authoring preset. */
export const AGGRESSIVENESS_PARAMS: Readonly<
  Record<
    TrafficAggressiveness,
    Readonly<{ sigma: string; speedFactor: string; minGap: string }>
  >
> = {
  calm: { sigma: "0.2", speedFactor: "0.85", minGap: "3.0" },
  normal: { sigma: "0.5", speedFactor: "1.0", minGap: "2.5" },
  aggressive: { sigma: "0.8", speedFactor: "1.15", minGap: "1.5" },
};

export const DEFAULT_CUSTOM_VEHICLE_MIX = {
  passenger: 70,
  truck: 20,
  bus: 10,
} as const;

export const MIXED_VEHICLE_MIX: readonly TrafficCardVehicleMix[] = [
  { type: "passenger", weight: 0.8 },
  { type: "truck", weight: 0.15 },
  { type: "bus", weight: 0.05 },
];

export const TRAFFIC_AUTHORING_LIMITS = {
  carLed: {
    carsPerActor: { min: 1, max: 20 },
    radiusMeters: { min: 5, max: 100 },
    minimumSpacingMeters: { min: 2, max: 40 },
    baseSpeedKph: { min: 5, max: 130 },
    variantSeed: { min: 0 },
  },
  global: {
    vehicleCount: { min: 1 },
    vehicleMixWeight: { min: 0, max: 100 },
  },
} as const;

export const TRAFFIC_AUTHORING_DEFAULTS = {
  carLed: {
    enabled: false,
    carsPerActor: 4,
    radiusMeters: 30,
    minimumSpacingMeters: 8,
    aggressiveness: "normal",
    baseSpeedKph: 50,
    variantSeed: 0,
  },
  global: {
    enabled: false,
    density: "moderate",
    aggressiveness: "normal",
    vehicleMix: "mixed",
    vehicleMixWeights: DEFAULT_CUSTOM_VEHICLE_MIX,
  },
} as const satisfies {
  carLed: {
    enabled: boolean;
    carsPerActor: number;
    radiusMeters: number;
    minimumSpacingMeters: number;
    aggressiveness: TrafficAggressiveness;
    baseSpeedKph: number;
    variantSeed: number;
  };
  global: {
    enabled: boolean;
    density: TrafficDensity;
    aggressiveness: TrafficAggressiveness;
    vehicleMix: VehicleMixPreset;
    vehicleMixWeights: TrafficVehicleMixWeights;
  };
};

export type TrafficVehicleMixWeights = {
  passenger: number;
  truck: number;
  bus: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function roundedInRange(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max?: number },
): number {
  const rounded = Math.round(finiteNumber(value, fallback));
  return Math.max(limits.min, limits.max === undefined ? rounded : Math.min(limits.max, rounded));
}

/** Parse a density value, falling back to the canonical moderate preset. */
export function parseTrafficDensity(value: unknown): TrafficDensity {
  const parsed = TrafficDensity.safeParse(value);
  return parsed.success ? parsed.data : TRAFFIC_AUTHORING_DEFAULTS.global.density;
}

/** Parse an aggressiveness value, falling back to the canonical normal preset. */
export function parseTrafficAggressiveness(value: unknown): TrafficAggressiveness {
  const parsed = TrafficAggressiveness.safeParse(value);
  return parsed.success
    ? parsed.data
    : TRAFFIC_AUTHORING_DEFAULTS.global.aggressiveness;
}

/** Parse a vehicle-mix preset, falling back to the canonical mixed preset. */
export function parseVehicleMixPreset(value: unknown): VehicleMixPreset {
  const parsed = VehicleMixPreset.safeParse(value);
  return parsed.success ? parsed.data : TRAFFIC_AUTHORING_DEFAULTS.global.vehicleMix;
}

const TrafficVehicleMixWeightsOutputSchema = z.object({
  passenger: z.number().min(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.min).max(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.max),
  truck: z.number().min(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.min).max(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.max),
  bus: z.number().min(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.min).max(TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight.max),
});

/** Parser that applies finite-number fallbacks and the 0..100 authoring bounds. */
export const TrafficVehicleMixWeightsSchema = z.preprocess((value) => {
  const weights = asRecord(value);
  const limits = TRAFFIC_AUTHORING_LIMITS.global.vehicleMixWeight;
  return {
    passenger: Math.max(limits.min, Math.min(limits.max, finiteNumber(weights.passenger, DEFAULT_CUSTOM_VEHICLE_MIX.passenger))),
    truck: Math.max(limits.min, Math.min(limits.max, finiteNumber(weights.truck, DEFAULT_CUSTOM_VEHICLE_MIX.truck))),
    bus: Math.max(limits.min, Math.min(limits.max, finiteNumber(weights.bus, DEFAULT_CUSTOM_VEHICLE_MIX.bus))),
  };
}, TrafficVehicleMixWeightsOutputSchema);

export function normalizeVehicleMixWeights(
  weights: TrafficVehicleMixWeights,
): TrafficCardVehicleMix[] {
  const entries = [
    { type: "passenger" as const, value: weights.passenger },
    { type: "truck" as const, value: weights.truck },
    { type: "bus" as const, value: weights.bus },
  ].map((entry) => ({
    type: entry.type,
    value: Math.max(0, Number.isFinite(entry.value) ? entry.value : 0),
  }));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return [{ type: "passenger", weight: 1 }];
  return entries
    .filter((entry) => entry.value > 0)
    .map((entry) => ({
      type: entry.type,
      weight: Number((entry.value / total).toFixed(4)),
    }));
}

export function vehicleMixForPreset(
  preset: VehicleMixPreset,
  customWeights: TrafficVehicleMixWeights = DEFAULT_CUSTOM_VEHICLE_MIX,
): TrafficCardVehicleMix[] {
  if (preset === "cars_only") return [{ type: "passenger", weight: 1 }];
  if (preset === "custom") return normalizeVehicleMixWeights(customWeights);
  return MIXED_VEHICLE_MIX.map((entry) => ({ ...entry }));
}

const CarLedTrafficAuthoringOutputSchema = z.object({
  enabled: z.boolean(),
  carsPerActor: z.number().int(),
  radiusMeters: z.number().int(),
  minimumSpacingMeters: z.number().int(),
  aggressiveness: TrafficAggressiveness,
  baseSpeedKph: z.number().int(),
  variantSeed: z.number().int(),
});

/** Car-led traffic parser shared by setup and legacy draft load paths. */
export const CarLedTrafficAuthoringSchema = z.preprocess((value) => {
  const input = asRecord(value);
  const defaults = TRAFFIC_AUTHORING_DEFAULTS.carLed;
  const limits = TRAFFIC_AUTHORING_LIMITS.carLed;
  return {
    enabled: input.enabled === true,
    carsPerActor: roundedInRange(input.carsPerActor, defaults.carsPerActor, limits.carsPerActor),
    radiusMeters: roundedInRange(input.radiusMeters, defaults.radiusMeters, limits.radiusMeters),
    minimumSpacingMeters: roundedInRange(input.minimumSpacingMeters, defaults.minimumSpacingMeters, limits.minimumSpacingMeters),
    aggressiveness: parseTrafficAggressiveness(input.aggressiveness),
    baseSpeedKph: roundedInRange(input.baseSpeedKph, defaults.baseSpeedKph, limits.baseSpeedKph),
    variantSeed: roundedInRange(input.variantSeed, defaults.variantSeed, limits.variantSeed),
  };
}, CarLedTrafficAuthoringOutputSchema);
export type CarLedTrafficAuthoring = z.infer<typeof CarLedTrafficAuthoringOutputSchema>;

const GlobalTrafficAuthoringOutputSchema = z.object({
  enabled: z.boolean(),
  density: TrafficDensity,
  aggressiveness: TrafficAggressiveness,
  vehicleCount: z.number().int(),
  vehicleMix: VehicleMixPreset,
  vehicleMixWeights: TrafficVehicleMixWeightsOutputSchema,
});

/** Global traffic parser shared by setup and legacy draft load paths. */
export const GlobalTrafficAuthoringSchema = z.preprocess((value) => {
  const input = asRecord(value);
  const density = parseTrafficDensity(input.density);
  return {
    enabled: input.enabled === true,
    density,
    aggressiveness: parseTrafficAggressiveness(input.aggressiveness),
    vehicleCount: roundedInRange(
      input.vehicleCount,
      DENSITY_VEHICLE_COUNTS[density],
      TRAFFIC_AUTHORING_LIMITS.global.vehicleCount,
    ),
    vehicleMix: parseVehicleMixPreset(input.vehicleMix),
    vehicleMixWeights: TrafficVehicleMixWeightsSchema.parse(input.vehicleMixWeights),
  };
}, GlobalTrafficAuthoringOutputSchema);
export type GlobalTrafficAuthoring = z.infer<typeof GlobalTrafficAuthoringOutputSchema>;

const TrafficAuthoringOutputSchema = z.object({
  carLed: CarLedTrafficAuthoringOutputSchema,
  global: GlobalTrafficAuthoringOutputSchema,
});

/** Canonical parser/normalizer for the complete traffic-authoring state. */
export const TrafficAuthoringSchema = z.preprocess((value) => {
  const input = asRecord(value);
  return {
    carLed: CarLedTrafficAuthoringSchema.parse(input.carLed),
    global: GlobalTrafficAuthoringSchema.parse(input.global),
  };
}, TrafficAuthoringOutputSchema);
export type TrafficAuthoring = z.infer<typeof TrafficAuthoringOutputSchema>;
