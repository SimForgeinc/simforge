/**
 * Choosing which stalls get a car, and which car.
 *
 * Pure and seeded: the same seed and inputs must produce the same scene, or a
 * render would not reproduce what the author previewed. No React, no network,
 * no catalog side effects beyond reading `CATALOG`.
 */

import { CATALOG } from "@simforge/asset-catalog";
import type { CatalogId } from "@simforge/asset-catalog";

import type { ParkedCar } from "@/app/lib/studio-shared/parked-cars";
import type { ParkingStall } from "./stalls";

/** Catalog entries the catalog itself marks as parkable. */
export interface ParkableModel {
  readonly catalogId: CatalogId;
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

/**
 * The `parkable` tag is the catalog's own answer to "what belongs in a stall",
 * so this feature does not keep a second hand-maintained list. Vehicles only:
 * `occluder.covered_car` also carries the tag, but a car cover is scenery an
 * author places deliberately, not something a random scatter should invent.
 */
export const PARKABLE_MODELS: readonly ParkableModel[] = CATALOG.filter(
  (entry) =>
    entry.class === "vehicle" && (entry.tags as readonly string[]).includes("parkable"),
).map((entry) => ({
  catalogId: entry.id as CatalogId,
  lengthM: entry.dims.l,
  widthM: entry.dims.w,
  heightM: entry.dims.h,
}));

// One definition, shared with the compiler: `catalogId` is a plain string there
// because `@simforge/studio-shared` must stay free of `@simforge/*`. Callers that
// need the branded `CatalogId` narrow it at the renderer boundary.
export type { ParkedCar };

/** A place a car must not be generated: an authored actor, or the ego's path. */
export interface ParkingExclusion {
  readonly x: number;
  readonly z: number;
  /** Stalls whose centre falls within this radius are left empty. */
  readonly radiusM: number;
}

export interface ParkedCarPlan {
  readonly cars: readonly ParkedCar[];
  /** Stalls that could hold a car — the honest denominator for occupancy. */
  readonly eligibleStallCount: number;
  /** Stalls skipped because an exclusion covered them. */
  readonly excludedStallCount: number;
  /** Stalls skipped because no parkable model fits inside them. */
  readonly unfittableStallCount: number;
  /** What occupancy asked for, before {@link MAX_PARKED_CARS} cut it back. */
  readonly requestedCarCount: number;
}

export interface ParkedCarPlanInput {
  readonly stalls: readonly ParkingStall[];
  /** Fraction of eligible stalls to fill, 0..1. */
  readonly occupancy: number;
  readonly seed: string;
  readonly facing: "nose_in" | "mixed";
  readonly exclusions?: readonly ParkingExclusion[];
  /** Narrow the model pool — the CARLA-ready filter is supplied by the caller. */
  readonly allowModel?: (catalogId: CatalogId) => boolean;
  /** Clearance required on each axis so a car never overhangs its box. */
  readonly clearanceM?: number;
  /** Override the export budget. Tests use it; the editor does not. */
  readonly maxCars?: number;
}

/**
 * Ceiling on parked cars.
 *
 * The `.xosc` budget used to set this. It no longer does: marking a parked car
 * `static` makes the exporter emit it as a `ScenarioObject` with an Init
 * teleport and **no trajectory at all**, which took it from 234 KiB per car to
 * 1,940 B — measured, 121x. All 859 of Belmont's stalls would now be 1.81 MiB
 * against a 64 MiB plan ceiling, so roughly 34,000 cars would fit.
 *
 * What remains is simulation and CARLA spawn cost. A static actor skips motion
 * integration, routing, signals, and static/static collision pairs, but it still
 * occupies a slot in the actor array, the collision broadphase, and one trace
 * sample per fixed step — and a CARLA render has to spawn every one of them.
 * Neither cost is measured here, so this is a deliberate guard rather than a
 * measured ceiling: 250 covers a large lot several times over while keeping the
 * blast radius of "fill every stall on the map" bounded.
 *
 * Applied to the plan, not to baking, so the preview never shows cars an export
 * would drop.
 */
export const MAX_PARKED_CARS = 250;

const DEFAULT_CLEARANCE_M = 0.1;

/**
 * FNV-1a over the seed. Any stable string-to-uint32 works; what matters is that
 * it does not depend on host locale, iteration order, or `Math.random`.
 */
function seedToUint32(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, and deterministic across engines. */
function createRandom(seed: string): () => number {
  let state = seedToUint32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isExcluded(
  stall: ParkingStall,
  exclusions: readonly ParkingExclusion[],
): boolean {
  for (const exclusion of exclusions) {
    const dx = stall.x - exclusion.x;
    const dz = stall.z - exclusion.z;
    if (Math.hypot(dx, dz) <= exclusion.radiusM) return true;
  }
  return false;
}

function modelsFor(
  stall: ParkingStall,
  pool: readonly ParkableModel[],
  clearanceM: number,
): readonly ParkableModel[] {
  return pool.filter(
    (model) =>
      model.lengthM + clearanceM <= stall.lengthM &&
      model.widthM + clearanceM <= stall.widthM,
  );
}

/**
 * Fill stalls deterministically.
 *
 * Stalls are sorted by id first: GeoJSON feature order is not a contract, and
 * an unsorted input would make the seed meaningless across re-fetches.
 */
export function planParkedCars(input: ParkedCarPlanInput): ParkedCarPlan {
  const clearanceM = input.clearanceM ?? DEFAULT_CLEARANCE_M;
  const exclusions = input.exclusions ?? [];
  const pool = input.allowModel
    ? PARKABLE_MODELS.filter((model) => input.allowModel!(model.catalogId))
    : PARKABLE_MODELS;

  const ordered = [...input.stalls].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  let excludedStallCount = 0;
  let unfittableStallCount = 0;
  const candidates: { stall: ParkingStall; models: readonly ParkableModel[] }[] = [];
  for (const stall of ordered) {
    if (isExcluded(stall, exclusions)) {
      excludedStallCount += 1;
      continue;
    }
    const models = modelsFor(stall, pool, clearanceM);
    if (models.length === 0) {
      unfittableStallCount += 1;
      continue;
    }
    candidates.push({ stall, models });
  }

  const occupancy = Math.min(1, Math.max(0, input.occupancy));
  const requestedCarCount = Math.round(candidates.length * occupancy);
  // Capped before selection, so the preview shows exactly what an export holds.
  const target = Math.min(requestedCarCount, Math.max(0, input.maxCars ?? MAX_PARKED_CARS));

  // One PRNG drives selection and model choice in a fixed order, so a change in
  // occupancy grows or shrinks the same scatter instead of reshuffling it.
  const random = createRandom(input.seed);
  const shuffled = candidates.map((candidate) => ({
    candidate,
    rank: random(),
  }));
  shuffled.sort((left, right) => left.rank - right.rank);

  const cars: ParkedCar[] = [];
  for (const { candidate } of shuffled.slice(0, target)) {
    const { stall, models } = candidate;
    const model = models[Math.min(models.length - 1, Math.floor(random() * models.length))]!;
    const reversed = input.facing === "mixed" ? random() < 0.5 : false;
    cars.push({
      id: `parked:${stall.id}`,
      stallId: stall.id,
      catalogId: model.catalogId,
      x: stall.x,
      y: stall.y,
      z: stall.z,
      headingRad: reversed ? stall.headingRad + Math.PI : stall.headingRad,
      lengthM: model.lengthM,
      widthM: model.widthM,
      heightM: model.heightM,
    });
  }

  // Stable output order keeps renderer instance slots and diffs stable.
  cars.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return {
    cars,
    eligibleStallCount: candidates.length,
    excludedStallCount,
    unfittableStallCount,
    requestedCarCount,
  };
}
