import type {
  TrafficAggressiveness,
  TrafficCard,
  TrafficCardVehicleMix,
  TrafficDensity,
  TrafficManager,
  VehicleMixPreset,
} from "@simforge-oss/studio-shared";

export const DENSITY_VEHICLE_COUNTS: Record<TrafficDensity, number> = {
  light: 10,
  moderate: 30,
  heavy: 60,
};

/**
 * Cars per actor for a scenario the editor seeded itself.
 *
 * A blank scenario opens with exactly one actor — the default subject — so this is
 * also, literally, the number of cars in it. An empty map is a worse starting
 * point than a populated one: the whole reason to open the editor is to watch
 * the subject meet something, and "enable traffic" is a checkbox nobody finds until
 * they have already judged an empty run.
 *
 * It applies ONLY at seed time, next to the default subject, so a scenario that has
 * ever been authored keeps whatever its author chose — including off.
 */
export const DEFAULT_SEEDED_CARS_PER_ACTOR = 12;

export const AGGRESSIVENESS_PARAMS: Record<
  TrafficAggressiveness,
  { sigma: string; speedFactor: string; minGap: string }
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

export type TrafficVehicleMixWeights = {
  passenger: number;
  truck: number;
  bus: number;
};

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
  if (total <= 0) {
    return [{ type: "passenger", weight: 1 }];
  }
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
  if (preset === "cars_only") {
    return [{ type: "passenger", weight: 1 }];
  }
  if (preset === "custom") {
    return normalizeVehicleMixWeights(customWeights);
  }
  return [
    { type: "passenger", weight: 0.8 },
    { type: "truck", weight: 0.15 },
    { type: "bus", weight: 0.05 },
  ];
}

export function buildCarlaTrafficCard(
  id: string,
  label = "CARLA traffic",
): TrafficCard {
  return {
    id,
    label,
    engine: "CARLA_TRAFFIC",
    enabled: true,
  };
}

export function resolveTrafficPayloadForCards(cards: TrafficCard[]): {
  trafficManager: TrafficManager | null;
  trafficCards: TrafficCard[];
} {
  const enabledCards = cards.filter((card) => card.enabled !== false);
  if (enabledCards.length === 0) {
    return {
      trafficManager: null,
      trafficCards: [],
    };
  }
  return {
    trafficManager: {
      engine: "CARLA_TRAFFIC",
      intent: {
        spawnBehavior: "actor_neighborhoods",
      },
    },
    trafficCards: enabledCards,
  };
}
