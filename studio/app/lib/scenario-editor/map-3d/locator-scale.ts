/**
 * How big the ground shadow disc under an actor is, in metres, at a given zoom.
 *
 * This is the whole of the LOD story for 3D mode, and it exists because of a
 * decision worth restating: **models stay true to scale at every zoom.** A
 * 4.7 m car is 2.5 px wide at zoom 16 and sub-pixel below that, and the 2D
 * markers hide that by clamping their glyph to a pixel range — knowingly drawing
 * a car several times its real size so it stays visible. A model cannot do that
 * without making the map lie about vehicle size, and silently swapping models
 * for glyphs when the user zooms out would be the interface overruling a user
 * who explicitly pressed "3D".
 *
 * So instead: the model is honest, and legibility comes from the disc it stands
 * on. The disc is the actor's real footprint until that footprint falls below a
 * pixel floor, at which point it stops shrinking and becomes a locator dot. Zoom
 * out and you see tiny true-scale cars on visible markers; zoom in and the disc
 * shrinks back under the vehicle and disappears. Nothing on screen ever
 * misrepresents a vehicle's size, because the disc is manifestly a marker.
 *
 * If glyph-scale legibility is what someone wants while zoomed out, the answer
 * is one keystroke: switch to 2D. That is what the mode is for.
 */

import { metersPerPixel } from "./coordinates";

/**
 * Below this the disc stops tracking the footprint. Chosen to match the 2D
 * vehicle marker's own `minPixelSize: 8` floor (`RuntimeActorLayers.tsx`), so an
 * actor is never harder to find in 3D than it is in 2D.
 */
export const LOCATOR_MIN_RADIUS_PX = 8;

/** Never let the disc dwarf the map at extreme zoom-out. */
export const LOCATOR_MAX_RADIUS_PX = 26;

export interface LocatorScaleInput {
  /** Half the actor's diagonal footprint, metres. */
  footprintRadiusM: number;
  zoom: number;
  latitudeDegrees: number;
  minRadiusPx?: number;
  maxRadiusPx?: number;
}

/**
 * The disc radius to draw, in METRES (the scene works in metres, so the pixel
 * floor is converted back rather than applied at draw time).
 */
export function locatorDiscRadiusMeters({
  footprintRadiusM,
  zoom,
  latitudeDegrees,
  minRadiusPx = LOCATOR_MIN_RADIUS_PX,
  maxRadiusPx = LOCATOR_MAX_RADIUS_PX,
}: LocatorScaleInput): number {
  const footprint = Number.isFinite(footprintRadiusM) ? Math.max(0, footprintRadiusM) : 0;
  const scale = metersPerPixel(zoom, latitudeDegrees);
  if (!Number.isFinite(scale) || scale <= 0) return footprint;

  const floorM = minRadiusPx * scale;
  const ceilingM = maxRadiusPx * scale;
  return Math.min(ceilingM, Math.max(footprint, floorM));
}

/**
 * Whether the disc is currently acting as a locator rather than as the actor's
 * own shadow. The renderer fades it up when true — a shadow should be subtle, a
 * locator should be findable.
 */
export function locatorIsStandingIn(input: LocatorScaleInput): boolean {
  return locatorDiscRadiusMeters(input) > input.footprintRadiusM + 1e-6;
}
