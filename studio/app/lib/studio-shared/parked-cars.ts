/**
 * Baked parked cars: the one implementation both the browser and the compiler use.
 *
 * The compiler refuses a revision whose concrete input digest differs from the
 * one the browser simulated (`materialized_traffic_source_input_digest_mismatch`).
 * Two copies of this logic would eventually drift and break every render, so it
 * lives here — deliberately dependency-free (no zod, no `@simforge-oss/*`) so a
 * Next.js app and a Node service on a different zod major can both import it.
 */

export const PARKED_CARS_EXTENSION_KEY = "studio.ambientTraffic.parkedCars.v1";

/** Id prefix every baked parked car carries. */
export const PARKED_CAR_ID_PREFIX = "parked:";

/** One committed parked car, in scene metres. */
export interface ParkedCar {
  readonly id: string;
  readonly stallId: string;
  readonly catalogId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

const CAR_NUMBER_KEYS = [
  "x",
  "y",
  "z",
  "headingRad",
  "lengthM",
  "widthM",
  "heightM",
] as const;

/**
 * Baked cars off a document's extension bag, dropping anything incomplete.
 *
 * The bag is an untyped `Record<string, unknown>` by design and a hand-edited
 * document is a supported input, so a malformed entry is skipped rather than
 * allowed to fail deep inside the compiler as `runtime_asset_identity_missing`.
 */
export function bakedParkedCarsFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): readonly ParkedCar[] {
  const raw = extensions?.[PARKED_CARS_EXTENSION_KEY];
  if (raw == null || typeof raw !== "object") return [];
  const baked = (raw as Record<string, unknown>)["baked"];
  if (!Array.isArray(baked)) return [];

  const cars: ParkedCar[] = [];
  for (const entry of baked) {
    if (entry == null || typeof entry !== "object") continue;
    const car = entry as Record<string, unknown>;
    if (typeof car["id"] !== "string" || car["id"].length === 0) continue;
    if (typeof car["stallId"] !== "string") continue;
    if (typeof car["catalogId"] !== "string" || car["catalogId"].length === 0) continue;
    let usable = true;
    for (const key of CAR_NUMBER_KEYS) {
      const value = car[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        usable = false;
        break;
      }
    }
    if (usable) cars.push(car as unknown as ParkedCar);
  }
  return cars;
}

/**
 * Length of the degenerate route a parked car carries, metres.
 *
 * ASAM export rejects a single-point route outright — `route_too_short`, "ASAM
 * routes require at least two distinct world positions" — so a stationary car
 * still needs two. One millimetre along the car's own heading is collinear with
 * its pose, so nothing can derive a direction that contradicts the stall, and it
 * is three orders of magnitude finer than the map pipeline's own accuracy.
 */
export const PARKED_CAR_ROUTE_M = 0.001;


/**
 * Behaviour rules a parked car carries.
 *
 * These are the upstream `actorSchema` defaults. A parked car never acts on any
 * of them — it has no route to speak of and zero speed — but the exporter reads
 * `rules.obeySignals` unconditionally, so the field has to be present.
 */
export const PARKED_CAR_RULES = {
  obeySignals: true,
  yield: true,
  yieldToVehicles: true,
  yieldToPedestrians: true,
  collisionAvoidance: true,
  aggression: 0.5,
  speedFactor: 1,
} as const;

/** The minimum an input must look like for parked cars to be appended. */
interface ActorsCarrier {
  readonly actors: readonly { readonly id: string }[];
}

/**
 * Append baked parked cars to a concrete simulation input.
 *
 * Each becomes an ordinary actor at zero speed with a degenerate route, which is
 * what makes it physical (it collides and occludes) and exportable: the vendored
 * exporter emits it as a `ScenarioObject` with an Init teleport and a trajectory
 * whose every speed is zero — a car standing in a bay.
 *
 * With no baked cars the input is returned by identity, so every existing
 * scenario compiles to exactly the bytes it did before.
 */
export function withParkedCarActors<T extends ActorsCarrier>(
  input: T,
  baked: readonly ParkedCar[],
): T {
  if (baked.length === 0) return input;

  // An authored role or ambient vehicle already holding the id wins: the
  // document is the authority on its own actors, and a duplicate id would fail
  // inside the exporter rather than here.
  const taken = new Set(input.actors.map((actor) => actor.id));
  const additions = baked
    .filter((car) => !taken.has(car.id))
    // Sorted so the appended block is byte-stable however the extension was
    // written, merged, or re-serialised. The digest depends on this.
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((car) => ({
      id: car.id,
      kind: "car",
      /**
       * The whole reason a parked car is cheap.
       *
       * The engine keys a fast path off this: it skips the motion backend, route
       * following, cruise-speed resolution, signal obedience, and static/static
       * collision pairs, and forces speed to zero. Without it every parked car
       * is integrated at every fixed step like a driving vehicle — which is
       * exactly the lag a car park full of them produces.
       */
      static: true,
      // The compiler asserts exactly one `catalog:` tag per actor
      // (`runtime_asset_identity_missing` / `_ambiguous`), and it is what binds
      // the actor to a CARLA blueprint.
      tags: [`catalog:${car.catalogId}`],
      initial: {
        pose: { x: car.x, z: car.z, headingRad: car.headingRad },
        speedMps: 0,
      },
      behavior: {
        // Spelled out rather than left to the schema's defaults: this module is
        // deliberately free of `@simforge-oss/*`, so nothing here can parse an
        // actor. The exporter reads `rules.obeySignals` directly and crashes on
        // an actor that lacks it. `parked-cars-export.test.ts` asserts these
        // match what `actorSchema` fills in, so upstream drift fails loudly.
        rules: PARKED_CAR_RULES,
        route: {
          kind: "polyline",
          points: [
            { x: car.x, z: car.z },
            // Scene heading h points along (cos h, -sin h) in (x, z).
            {
              x: car.x + PARKED_CAR_ROUTE_M * Math.cos(car.headingRad),
              z: car.z - PARKED_CAR_ROUTE_M * Math.sin(car.headingRad),
            },
          ],
        },
      },
      presentAtStart: true,
      dims: { l: car.lengthM, w: car.widthM, h: car.heightM },
    }));

  if (additions.length === 0) return input;
  return { ...input, actors: [...input.actors, ...additions] } as unknown as T;
}
