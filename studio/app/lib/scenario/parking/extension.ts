/**
 * Parked cars as an ambient-traffic extension.
 *
 * Generated parking rows remain ambient traffic rather than authored roles:
 * they are execution settings, not individually choreographed participants.
 * The extension is stored on the document with the other execution-bearing
 * ambient choices (`studio.ambientTraffic.provider.v1`,
 * `…acceleratedSignalCycles.v1`, `…allSignalsGreen.v1`).
 */

import {
  bakedParkedCarsFromExtensions,
  PARKED_CARS_EXTENSION_KEY,
  type ParkedCar,
} from "@/app/lib/studio-shared/parked-cars";

// The key, the baked-car type, and the reader live in `@simforge/studio-shared` because
// the compiler service needs the identical implementation — see that module.
export { PARKED_CARS_EXTENSION_KEY };
export type { ParkedCar };

export type ParkedCarsFacing = "nose_in" | "mixed";
export type ParkedCarsModelPolicy = "carla_ready" | "any";

export interface ParkedCarsSettings {
  readonly enabled: boolean;
  /** Fraction of eligible stalls to fill. Portable across maps in a way a raw count is not. */
  readonly occupancy: number;
  readonly seed: string;
  readonly facing: ParkedCarsFacing;
  readonly models: ParkedCarsModelPolicy;
  /**
   * Cars committed to the scenario.
   *
   * While this is empty the generator is a preview: cars are drawn, but nothing
   * else in the world knows about them. Baking writes the resolved cars here,
   * which is what makes them real — `withParkedCarActors` turns them into
   * simulated actors on both the browser and compiler sides, so they collide,
   * and they reach the `.xosc` as stationary `ScenarioObject`s.
   *
   * They live on the document rather than being regenerated at compile time
   * because the compiler has the lane graph but not the road-network GeoJSON
   * the stalls come from, and the compiled input must be byte-identical to the
   * one the browser simulated.
   */
  readonly baked: readonly ParkedCar[];
}

export const DEFAULT_PARKED_CARS_SETTINGS: ParkedCarsSettings = {
  enabled: false,
  occupancy: 0.6,
  seed: "parked-1",
  facing: "nose_in",
  // Every parkable model, not just the CARLA-native ones. Filtering to native
  // blueprints leaves stalls visibly empty (78 of 859 on Belmont) to protect a
  // render the cars only reach once they are baked, so it is opt-in instead.
  models: "any",
  baked: [],
};

/**
 * Read the stored settings, tolerating anything. A malformed extension must
 * degrade to defaults rather than break the editor: the bag is untyped by
 * design and a hand-edited document is a supported input.
 */
export function parkedCarsFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): ParkedCarsSettings {
  const raw = extensions?.[PARKED_CARS_EXTENSION_KEY];
  if (raw == null || typeof raw !== "object") return DEFAULT_PARKED_CARS_SETTINGS;
  const value = raw as Record<string, unknown>;
  const seed = typeof value["seed"] === "string" && value["seed"].trim().length > 0
    ? (value["seed"] as string)
    : DEFAULT_PARKED_CARS_SETTINGS.seed;
  const storedOccupancy = value["occupancy"];
  return {
    enabled: value["enabled"] === true,
    occupancy:
      typeof storedOccupancy === "number" && Number.isFinite(storedOccupancy)
        ? Math.min(1, Math.max(0, storedOccupancy))
        : DEFAULT_PARKED_CARS_SETTINGS.occupancy,
    seed,
    facing: value["facing"] === "mixed" ? "mixed" : "nose_in",
    // "carla_ready" only when stored explicitly: the default is now "any".
    models: value["models"] === "carla_ready" ? "carla_ready" : "any",
    // Parsed by the shared reader so the editor and the compiler agree on
    // exactly which baked entries are usable.
    baked: bakedParkedCarsFromExtensions(extensions),
  };
}

/** Next seed for the reroll control. Stable, short, and human-readable. */
export function nextParkedCarsSeed(current: string): string {
  const match = /^parked-(\d+)$/.exec(current);
  const next = match ? Number(match[1]) + 1 : 1;
  return `parked-${next}`;
}
