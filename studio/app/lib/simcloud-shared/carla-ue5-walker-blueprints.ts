/**
 * Which pedestrian blueprints the CARLA 0.10.x / UE5.5 image can actually spawn.
 *
 * This does NOT duplicate the catalogue — `carla-runtime-catalog.ts` already
 * carries every walker with its age, gender, generation and walk/run speeds,
 * and a live probe confirmed that metadata is correct. What was missing is
 * AVAILABILITY: the catalogue lists 52 walkers, the 0.10 image publishes 37.
 *
 * THE BUG THIS EXISTS TO PREVENT. Call sites built ids arithmetically —
 * `walker.pedestrian.${(seed + n) % 37 + 1}` — on the correct observation that
 * the image ships 37 models. The count was right; the RANGE was assumed to
 * start at 0001. It starts at 0015, because 0001..0014 are the GENERATION-1
 * (0.9-era) walkers that the UE5 re-cook dropped. So 14 of every 37 background
 * draws, and all eight companion ids, named blueprints that do not exist.
 *
 * They still appeared: the worker's `_substitute_ue5_walker_blueprint` maps an
 * unknown walker id onto a real one, and walkers are exempt from the
 * fail-closed approval check that guards vehicle swaps (a swapped vehicle
 * changes physics; a swapped walker is cosmetic). The cost was VARIETY, not
 * absence — 37 intended background models collapsed onto 23, and 8 companions
 * onto 7 — and, more importantly, the substitution never reached 0048/0049
 * either, so a CHILD pedestrian had never rendered at all.
 *
 * PROBE (0.10.0 server, Munich_Phase_1A, 2026-07-28,
 * `scripts/probe-walker-blueprints.py`). The image publishes exactly
 * generation 2 plus 0050/0051, i.e. 0015..0051 contiguous. Ages come from each
 * blueprint's own `age` attribute, cross-checked against the SPAWNED actor's
 * bounding box so a mislabelled mesh cannot slip through — and they agreed with
 * this repo's catalogue on every entry:
 *   adult    0015-0047  measured 1.84-1.85 m
 *   child    0048-0049  measured 1.110 m
 *   teenager 0050-0051  measured 1.905 m
 *
 * NOTE ON `teenager`: those two measure TALLER than every adult. The label is
 * not a stature class, so they must never stand in for a young pedestrian —
 * only 0048/0049 read as small on camera.
 *
 * Re-run the probe after an image bump and update UNAVAILABLE below; never port
 * index->age mappings from the 0.9.x stack.
 */
import { CARLA_PEDESTRIAN_BLUEPRINTS } from "./carla-runtime-catalog";

export type WalkerAge = "adult" | "child" | "teenager";

/**
 * Catalogued but absent from the 0.10 image: the generation-1 walkers the UE5
 * re-cook dropped, plus 0052 (generation 3, catalogued but not published).
 */
const UNAVAILABLE_IN_UE5: ReadonlySet<string> = new Set([
  ...Array.from({ length: 14 }, (_, i) => `walker.pedestrian.${String(i + 1).padStart(4, "0")}`),
  "walker.pedestrian.0052",
]);

/**
 * Spawnable but DENIED for generated scenes (dib 2026-08-02 Munich review,
 * merge-17-5 rated 1/5 — the "paraglider persona"). 0045/0046/0047 are three
 * near-identical variants of the same heavyset man in suspender/harness straps:
 * the straps read as a paraglider harness on camera, the triplet murders
 * variety (seeded windows routinely draw 2-3 of them into one scene), and this
 * body was the one observed twice with the UE5 cloth/mesh shred ("canopy")
 * artifact. Deterministic by construction: the pool simply shrinks, so
 * `walkerBlueprintAt` keeps being a pure function of (index, pool).
 * Mirrored in the worker's substitution pool
 * (spawn_actor_helpers._substitute_ue5_walker_blueprint) — the worker draws
 * from the LIVE library, which a web-side list cannot reach.
 */
export const CARLA_UE5_WALKER_DENYLIST: ReadonlySet<string> = new Set([
  "walker.pedestrian.0045",
  "walker.pedestrian.0046",
  "walker.pedestrian.0047",
]);

const AVAILABLE = CARLA_PEDESTRIAN_BLUEPRINTS.filter(
  (b) => !UNAVAILABLE_IN_UE5.has(b.id) && !CARLA_UE5_WALKER_DENYLIST.has(b.id),
);

const ageOf = (b: (typeof CARLA_PEDESTRIAN_BLUEPRINTS)[number]): WalkerAge =>
  b.attributes.age as WalkerAge;

/** Every walker generated scenes may use (34 = 37 spawnable minus the
 *  deny-list above), in catalogue order. */
export const CARLA_UE5_WALKER_BLUEPRINTS: readonly string[] = AVAILABLE.map((b) => b.id);

/** Adult-stature models (~1.84 m). */
export const CARLA_UE5_WALKER_ADULTS: readonly string[] =
  AVAILABLE.filter((b) => ageOf(b) === "adult").map((b) => b.id);

/**
 * The only genuinely small models in the image (~1.11 m). Load-bearing for Euro
 * NCAP's CPNCO cell, which is specifically a CHILD emerging from behind an
 * obstruction.
 */
export const CARLA_UE5_WALKER_CHILDREN: readonly string[] =
  AVAILABLE.filter((b) => ageOf(b) === "child").map((b) => b.id);

/** Labelled `teenager` but measured 1.905 m — see the note above; not a youth. */
export const CARLA_UE5_WALKER_TEENAGERS: readonly string[] =
  AVAILABLE.filter((b) => ageOf(b) === "teenager").map((b) => b.id);

export const CARLA_UE5_WALKER_AGE: Readonly<Record<string, WalkerAge>> = Object.freeze(
  Object.fromEntries(AVAILABLE.map((b) => [b.id, ageOf(b)])),
);

/** True when `id` is a blueprint this image can actually spawn. */
export function isValidWalkerBlueprint(id: string): boolean {
  return id in CARLA_UE5_WALKER_AGE;
}

/**
 * Deterministic pick from `pool` — the arithmetic the old call sites wanted,
 * but indexing a REAL catalogue instead of assuming a contiguous range from 1.
 *
 * The default pool is every available walker, children included: a mixed street
 * is the realistic one, and a child on the pavement beside an adult is ordinary
 * (operator, 2026-07-28). Pass `CARLA_UE5_WALKER_ADULTS` where a family's
 * validated geometry depends on adult stature.
 */
export function walkerBlueprintAt(
  index: number,
  pool: readonly string[] = CARLA_UE5_WALKER_BLUEPRINTS,
): string {
  if (pool.length === 0) throw new Error("walkerBlueprintAt: empty pool");
  const i = ((index % pool.length) + pool.length) % pool.length;
  return pool[i]!;
}
