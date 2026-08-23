import { Vector3, type Box3, type DirectionalLight } from 'three';

/**
 * Real-time sun shadows.
 *
 * The generated city maps ship path-traced lightmaps and need no shadow pass,
 * but an uploaded map ships none at all — and a scene lit by one unshadowed
 * directional light reads flat no matter how the sun is tuned. A shadow map
 * fitted to the camera's neighbourhood gives back the contact shadow under a
 * vehicle, which is the cue that sells scale and ground contact.
 *
 * The sun does not move while the camera does, so the map is baked on demand
 * (`autoUpdate = false`) rather than every frame: it is re-baked when the focus
 * point leaves the region the current bake covers, or when the sun moves.
 */

/** Metres of camera drift tolerated before the shadow bake is stale. */
const REBAKE_DRIFT_FRACTION = 0.25;

export interface SunShadowFit {
  /** Half-extent of the orthographic shadow frustum, in metres. */
  readonly radius: number;
  readonly near: number;
  readonly far: number;
  /** Where the light is parked. */
  readonly position: Vector3;
  /** What the light looks at — the centre of the covered region. */
  readonly target: Vector3;
}

/**
 * Fits the shadow frustum around `focus`.
 *
 * `travel` is the direction sunlight travels, matching the manifest and
 * `DirectionalLight` conventions. The light is parked a full scene height above
 * the focus so tall geometry outside the radius still casts into it.
 */
export function fitSunShadow(
  focus: Vector3,
  travel: Vector3,
  radiusM: number,
  verticalSpanM: number,
): SunShadowFit {
  const radius = Math.max(1, radiusM);
  const span = Math.max(radius, verticalSpanM);
  const direction = travel.lengthSq() === 0
    ? new Vector3(0, -1, 0)
    : travel.clone().normalize();
  // Far enough back that the near plane clears anything above the focus, and
  // the depth range stays tight enough for the bias to behave.
  const distance = span * 2 + radius;
  return {
    radius,
    near: 1,
    far: distance + span * 2 + radius,
    position: focus.clone().addScaledVector(direction, -distance),
    target: focus.clone(),
  };
}

/** True when the covered region no longer contains the live focus point. */
export function shadowBakeIsStale(
  baked: { readonly focus: Vector3; readonly radius: number; readonly sun: Vector3 } | null,
  live: { readonly focus: Vector3; readonly radius: number; readonly sun: Vector3 },
): boolean {
  if (!baked) return true;
  if (baked.radius !== live.radius) return true;
  if (!baked.sun.equals(live.sun)) return true;
  const drift = Math.hypot(live.focus.x - baked.focus.x, live.focus.z - baked.focus.z)
    + Math.abs(live.focus.y - baked.focus.y);
  return drift > baked.radius * REBAKE_DRIFT_FRACTION;
}

/**
 * Radii (metres) inside which the real-time shadow supersedes the baked term.
 *
 * The bake already contains direct-light occlusion, so applying both crushes
 * shadowed ground to black. The baked term is faded back in across the edge of
 * the real-time region instead of being switched off globally, which keeps the
 * distant city shaded on maps that do ship lightmaps.
 */
export function bakedSuppressionRadii(radiusM: number): { start: number; end: number } {
  const radius = Math.max(1, radiusM);
  return { start: radius * 0.7, end: radius };
}

/** Radii that leave the baked term applied everywhere. */
export const BAKED_SUPPRESSION_OFF = { start: -2, end: -1 } as const;

/** Applies a fit to a light, leaving the bake to be triggered by the caller. */
export function applySunShadowFit(sun: DirectionalLight, fit: SunShadowFit): void {
  const camera = sun.shadow.camera;
  camera.left = -fit.radius;
  camera.right = fit.radius;
  camera.top = fit.radius;
  camera.bottom = -fit.radius;
  camera.near = fit.near;
  camera.far = fit.far;
  camera.updateProjectionMatrix();
  sun.position.copy(fit.position);
  sun.target.position.copy(fit.target);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}

/**
 * Shadow radius for a scene.
 *
 * A single map covering the whole footprint would spend its texels on ground
 * the camera cannot resolve; a small map is better served by covering all of
 * it, so the request is clamped to the scene rather than applied blindly.
 */
export function shadowRadiusForScene(box: Box3, requestedM: number): number {
  const size = box.getSize(new Vector3());
  const footprint = Math.max(size.x, size.z) * 0.5;
  if (!Number.isFinite(footprint) || footprint <= 0) return Math.max(1, requestedM);
  return Math.max(1, Math.min(requestedM, footprint));
}
