/**
 * Deterministic SUMO vType → image-native CARLA blueprint mapping.
 *
 * Pools use IMAGE-NATIVE 0.10/UE5.5 ids only (docs/automated-scenario-creation.md
 * §2b — the 0.9-era ids all alias to lincoln.mkz and render a uniform fleet).
 * The draw is a pure hash of (seed, vehicle id), so the same SUMO run always
 * dresses the same scene with the same bodies — replay-stable.
 */

// Pools are LENGTH-BANDED so a SUMO vType's car-following spacing matches the
// body CARLA renders (#75): SUMO plans gaps for its vType length, so dressing a
// 4.0 m vType with a 5.0 m body eats ~1 m of every planned gap. car_a (the
// ~4.9-5.3 m sedan band) draws the full-size pool; car_b (~4.0 m) draws the
// compact pool. Lengths in DEFAULT_VTYPE_LENGTHS_M are MEASURED from the live
// 0.10 image (bbox_extent in 2D-run timelines, 2026-08-07): mkz 4.89,
// charger 5.01, taxi 5.35, mini.cooper 4.55, patrol 5.59, sprinter 5.92,
// carlacola 8.00. The catalogue guesses this replaced were off by up to 1.5 m
// (carlacola) — measure, never assume.
const CAR_POOL_FULLSIZE = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.taxi.ford",
] as const;
const CAR_POOL_COMPACT = ["vehicle.mini.cooper"] as const;

const SUV_POOL = ["vehicle.nissan.patrol"] as const;
const VAN_POOL = ["vehicle.sprinter.mercedes"] as const;
const TRUCK_POOL = ["vehicle.carlacola.actors"] as const;

/** FNV-1a 32-bit — tiny, stable, good enough for a pool draw. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function drawFrom(pool: readonly string[], key: string): string {
  return pool[hashString(key) % pool.length]!;
}

/** Map a SUMO vType id (our ambientMix distribution, or anything else) onto an
 * image-native blueprint, deterministically per (seed, vehicle id). */
export function blueprintForVtype(vtype: string, vehicleId: string, seed: number): string {
  const key = `${seed}:${vehicleId}`;
  const normalized = vtype.toLowerCase();
  if (normalized.includes("truck")) return drawFrom(TRUCK_POOL, key);
  if (normalized.includes("van") || normalized.includes("delivery")) return drawFrom(VAN_POOL, key);
  if (normalized.includes("suv")) return drawFrom(SUV_POOL, key);
  if (normalized.includes("car_b") || normalized.includes("compact")) {
    return drawFrom(CAR_POOL_COMPACT, key);
  }
  return drawFrom(CAR_POOL_FULLSIZE, key);
}

/** Default lengths (m) for our ambientMix vTypes; used for the front-bumper →
 * center shift when the trajectory file carries no vtype_lengths_m table. */
export const DEFAULT_VTYPE_LENGTHS_M: Record<string, number> = {
  // In-image measured lengths (#75): car_a = pool-weighted full-size mean
  // (mkz 4.89 x2, charger 5.01 x2, taxi 5.35), car_b = mini cooper, suv =
  // nissan patrol, van = sprinter, truck = carlacola box truck.
  car_a: 5.03,
  car_b: 4.55,
  suv: 5.59,
  van: 5.92,
  truck: 8.0,
};
