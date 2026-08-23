/**
 * Turning a screen pixel into a ground coordinate, or refusing to.
 *
 * MapLibre's `unproject` always answers, even when the honest answer is "that
 * pixel is not looking at the ground". It solves for where the pixel's view ray
 * crosses `z = 0` by linear extrapolation between the near and far planes
 * (`Transform#pointCoordinate`):
 *
 *   const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);
 *   return new MercatorCoordinate(interpolate.number(x0, x1, t) / worldSize, ...);
 *
 * `interpolate.number` is a plain lerp, so `t` outside `[0, 1]` extrapolates
 * happily. For any pixel ABOVE the horizon the ray never descends to the ground
 * going forward, so it returns a coordinate BEHIND the camera — a real-looking
 * lng/lat, silently mirrored to the wrong side of the viewer. There is no guard
 * and no null.
 *
 * That region is not a corner case in the editor. Under MapLibre's default
 * 36.87 degree fov, the horizon enters the frame at ~71.6 degrees of pitch and
 * the sky band grows fast after that: ~10% of canvas height at 75 degrees, and
 * ~30% at the 82.5 degree ceiling `MAX_3D_PITCH` allows so the camera can reach
 * a driver's-eye view. A click up there placed an actor kilometres away, or
 * behind the camera.
 *
 * The test is a round trip. `project` is the forward transform, and for a point
 * behind the camera the perspective divide by a negative `w` mirrors it through
 * the vanishing point — so a bad unprojection lands nowhere near the pixel it
 * came from, while a good one returns to within float error. This needs no
 * private transform state and no fov/pitch trigonometry of our own, which is the
 * point: the check stays correct if MapLibre changes how it projects.
 */

/** Small enough to catch a mirrored point, loose enough for float round-trip. */
export const GROUND_UNPROJECT_TOLERANCE_PX = 2;

type GroundLngLat = { lng: number; lat: number };

/** Just the two transform calls, so tests and callers need no live map. */
export type ProjectingMap = {
  unproject(point: [number, number]): GroundLngLat;
  project(lngLat: GroundLngLat): { x: number; y: number };
};

/**
 * The ground coordinate under a screen pixel, or null when the pixel is not
 * looking at ground the map can place anything on.
 *
 * Callers that AUTHOR a coordinate from a pointer must use this. Callers that
 * pick a rendered feature must not: a tall model legitimately draws above the
 * horizon line, and its roof is a fair click target even though the pixel under
 * it has no ground.
 */
export function unprojectGroundPoint(
  map: ProjectingMap,
  point: [number, number],
): GroundLngLat | null {
  const lngLat = map.unproject(point);
  if (!Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return null;
  const roundTrip = map.project(lngLat);
  if (!Number.isFinite(roundTrip.x) || !Number.isFinite(roundTrip.y)) return null;
  const drift = Math.hypot(roundTrip.x - point[0], roundTrip.y - point[1]);
  return drift <= GROUND_UNPROJECT_TOLERANCE_PX ? lngLat : null;
}
