/**
 * Hit-testing for 3D-mode actors: an invisible GeoJSON circle layer, not GL
 * picking.
 *
 * The payoff is that this revives code already written for it.
 * `useRuntimeActorMouseDown` (`hooks/useRuntimeLaneInteraction.ts`) has queried
 * `runtime-actors-circle` / `runtime-actors-label` and read
 * `feature.properties.id` since the day it was written, and has early-returned
 * every time because those layers never existed — actors are DOM markers. Create
 * the layers and the entire existing selection and hold-to-drag chain works in
 * 3D mode with no new interaction code and no change to the drag machine.
 *
 * The other reasons, in order of how much they matter under pitch:
 *
 * - A ground-plane disc is a stable, generous click target at any pitch. A
 *   raycast against a 20 px car at pitch 55 degrees is not.
 * - No GL picking pass, no readback stall, no second render.
 * - It composes with the map's existing `onMouseDown` chain untouched.
 *
 * The cost is that the hit shape is a footprint disc rather than the vehicle
 * silhouette. For a mostly-top-down editor that is arguably the better
 * affordance anyway.
 */

import { EQUATOR_METERS_PER_PIXEL_AT_Z0 } from "./coordinates";

/** The source and layer ids `useRuntimeActorMouseDown` already looks for. */
export const RUNTIME_ACTOR_HIT_SOURCE_ID = "runtime-actors-hit";
export const RUNTIME_ACTOR_HIT_LAYER_ID = "runtime-actors-circle";

/** No actor is ever a smaller click target than this, however far you zoom out. */
export const MIN_ACTOR_HIT_RADIUS_PX = 12;

export interface ActorHitInput {
  id: string;
  longitude: number;
  latitude: number;
  /** Half the actor's diagonal footprint, metres. */
  footprintRadiusM: number;
}

export interface ActorHitFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: { id: string; hitRadiusM: number };
  }>;
}

export function buildActorHitFeatures(
  actors: readonly ActorHitInput[],
): ActorHitFeatureCollection {
  return {
    type: "FeatureCollection",
    features: actors.flatMap((actor) => {
      if (!Number.isFinite(actor.longitude) || !Number.isFinite(actor.latitude)) {
        return [];
      }
      return [
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [actor.longitude, actor.latitude] as [number, number],
          },
          properties: {
            id: actor.id,
            hitRadiusM: Math.max(0.5, actor.footprintRadiusM),
          },
        },
      ];
    }),
  };
}

/** Pixels one metre occupies at `zoom`, at a fixed latitude. */
function pixelsPerMeter(zoom: number, latitudeDegrees: number): number {
  const cosLat = Math.cos((latitudeDegrees * Math.PI) / 180);
  const denominator = EQUATOR_METERS_PER_PIXEL_AT_Z0 * (cosLat || 1e-6);
  return Math.pow(2, zoom) / denominator;
}

/** Zoom range the radius expression declares stops across, one per level. */
const HIT_RADIUS_LOW_ZOOM = 8;
const HIT_RADIUS_HIGH_ZOOM = 22;

/**
 * A `circle-radius` expression that tracks the actor's real footprint and never
 * falls below {@link MIN_ACTOR_HIT_RADIUS_PX}.
 *
 * Pixels-per-metre is exactly `2^zoom / (C * cos(lat))`, so an exponential-base-2
 * interpolation between zoom stops is not an approximation of the metre radius —
 * it IS the metre radius, evaluated on the GPU.
 *
 * The floor has to live *inside* the stop outputs, not wrapped around the
 * interpolation. MapLibre only accepts `["zoom"]` as the direct input of a
 * top-level `step` or `interpolate`; `["max", floor, ["interpolate", …
 * ["zoom"] …]]` is rejected at style-validation time and kills the whole
 * canvas. Flooring per stop is still a hard floor — interpolation between two
 * outputs is a convex combination, so it can never dip below the smaller of
 * them — and one stop per zoom level keeps the metre tracking exact everywhere
 * except the single level where the real footprint overtakes the floor.
 *
 * `latitudeDegrees` is the bundle's latitude, which varies by well under a
 * pixel's worth of `cos` across any one map.
 */
export function actorHitRadiusExpression(latitudeDegrees: number): unknown {
  const stops: unknown[] = [];
  for (let zoom = HIT_RADIUS_LOW_ZOOM; zoom <= HIT_RADIUS_HIGH_ZOOM; zoom += 1) {
    stops.push(zoom, [
      "max",
      MIN_ACTOR_HIT_RADIUS_PX,
      ["*", ["get", "hitRadiusM"], pixelsPerMeter(zoom, latitudeDegrees)],
    ]);
  }
  return ["interpolate", ["exponential", 2], ["zoom"], ...stops];
}
