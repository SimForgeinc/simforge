/**
 * Hit-testing for signal heads, so a light is a thing you can click.
 *
 * The same idiom as `hit-features.ts` and for the same reasons: an invisible
 * GeoJSON circle layer queried through `queryRenderedFeatures`, not a GL picking
 * pass. A ground-plane disc is a stable target at any pitch, it costs no readback
 * stall, and it composes with the map's existing pointer chain untouched.
 *
 * ## The target follows the geometry path
 *
 * Old-cook fallback heads have two real editor parts: a synthesized pole at the
 * actor/authored point and a housing about six metres away on the measured arm,
 * so both points get a disc. A new-cook head with no assigned mast is rooted at
 * `housing.x/y`; the supplied points are identical and collapse to one housing
 * disc. Heads sharing a measured mast supply the same pole coordinate, which is
 * emitted once rather than as N overlapping targets. Each housing keeps its own
 * disc and every disc still selects a head.
 *
 * Both old-cook discs carry the same `signalId`, so which part is hit does not
 * matter to the caller.
 */

import { EQUATOR_METERS_PER_PIXEL_AT_Z0 } from "./coordinates";

export const SIGNAL_HIT_SOURCE_ID = "runtime-signals-hit";
export const SIGNAL_HIT_LAYER_ID = "runtime-signals-circle";

/**
 * A light is never a smaller target than this. Larger than the actor floor (12
 * px): a head is a thin vertical object seen from above, so it has far less
 * apparent area than a car and needs the help.
 */
export const MIN_SIGNAL_HIT_RADIUS_PX = 14;

/** The disc radius in metres. Generous — the fixture is the target, not a lamp. */
export const SIGNAL_HIT_RADIUS_M = 2.5;

export interface SignalHitInput {
  /** The OpenDRIVE `<signal>` id, or the actor-derived key when it has none. */
  signalId: string;
  /** Rendered group origin: old-cook pole base or new-cook housing position. */
  longitude: number;
  latitude: number;
  /** Rendered housing position. */
  housingLongitude?: number | null;
  housingLatitude?: number | null;
}

export interface SignalHitFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: { signalId: string; part: "pole" | "housing" };
  }>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildSignalHitFeatures(
  heads: readonly SignalHitInput[],
): SignalHitFeatureCollection {
  const features: SignalHitFeatureCollection["features"] = [];
  const emittedPoles = new Set<string>();
  for (const head of heads) {
    const signalId = String(head.signalId ?? "").trim();
    if (!signalId) continue;
    const hasPole = finite(head.longitude) && finite(head.latitude);
    const hasHousing =
      finite(head.housingLongitude) && finite(head.housingLatitude);
    const housingIsOrigin =
      hasPole &&
      hasHousing &&
      head.longitude === head.housingLongitude &&
      head.latitude === head.housingLatitude;

    if (hasHousing && (!hasPole || housingIsOrigin)) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [
            head.housingLongitude as number,
            head.housingLatitude as number,
          ],
        },
        properties: { signalId, part: "housing" },
      });
      continue;
    }
    if (hasPole) {
      const poleKey = `${head.longitude},${head.latitude}`;
      if (!emittedPoles.has(poleKey)) {
        emittedPoles.add(poleKey);
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [head.longitude, head.latitude],
          },
          properties: { signalId, part: "pole" },
        });
      }
    }
    if (hasHousing) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [
            head.housingLongitude as number,
            head.housingLatitude as number,
          ],
        },
        properties: { signalId, part: "housing" },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Pixels one metre occupies at `zoom`, at a fixed latitude. */
function pixelsPerMeter(zoom: number, latitudeDegrees: number): number {
  const cosLat = Math.cos((latitudeDegrees * Math.PI) / 180);
  const denominator = EQUATOR_METERS_PER_PIXEL_AT_Z0 * (cosLat || 1e-6);
  return Math.pow(2, zoom) / denominator;
}

const HIT_RADIUS_LOW_ZOOM = 8;
const HIT_RADIUS_HIGH_ZOOM = 22;

/**
 * A `circle-radius` expression tracking {@link SIGNAL_HIT_RADIUS_M} with a
 * pixel floor.
 *
 * The floor lives inside each stop output rather than wrapped around the
 * interpolation: MapLibre only accepts `["zoom"]` as the direct input of a
 * top-level `interpolate`, and `["max", floor, ["interpolate", ...]]` is
 * rejected at style-validation time and takes the whole canvas down with it.
 * Flooring per stop is still a hard floor, because interpolating between two
 * outputs is a convex combination.
 */
export function signalHitRadiusExpression(latitudeDegrees: number): unknown {
  const stops: unknown[] = [];
  for (let zoom = HIT_RADIUS_LOW_ZOOM; zoom <= HIT_RADIUS_HIGH_ZOOM; zoom += 1) {
    stops.push(zoom, [
      "max",
      MIN_SIGNAL_HIT_RADIUS_PX,
      SIGNAL_HIT_RADIUS_M * pixelsPerMeter(zoom, latitudeDegrees),
    ]);
  }
  return ["interpolate", ["exponential", 2], ["zoom"], ...stops];
}
