import type { AABB, Vec3 } from './types';

export interface FitCameraOptions {
  /** Vertical field-of-view in degrees (matches THREE.PerspectiveCamera.fov). */
  fovDegrees: number;
  /** Viewport aspect ratio (width / height). */
  aspectRatio: number;
  /** Camera pitch above horizontal, in degrees. Default 35°. */
  pitchDegrees?: number;
  /** Extra margin around the bounds expressed as a fraction. Default 0.10 (10 %). */
  marginFraction?: number;
  /**
   * Distance used when the bounds collapse to a point (or have zero XZ
   * extent). Default 50.
   */
  fallbackDistance?: number;
}

export interface FitCameraResult {
  position: Vec3;
  target: Vec3;
}

/**
 * Compute an oblique fly-cam pose that frames the given AABB's XZ footprint
 * within the camera's frustum, with the camera south of and above the XZ
 * centre.
 *
 * The view ray points from camera toward target; the camera is offset along
 * (0, sin pitch, cos pitch) at a distance chosen so the bounds + margin fit
 * inside both the vertical and horizontal FOV.
 */
export function computeAutoFitCamera(
  bounds: AABB,
  groundY: number,
  options: FitCameraOptions,
): FitCameraResult {
  const pitchDeg = options.pitchDegrees ?? 35;
  const margin = options.marginFraction ?? 0.1;
  const fallbackDist = options.fallbackDistance ?? 50;

  const { min, max } = bounds;
  // Tolerate inverted bounds (min > max on any axis).
  const xMin = Math.min(min[0], max[0]);
  const xMax = Math.max(min[0], max[0]);
  const zMin = Math.min(min[2], max[2]);
  const zMax = Math.max(min[2], max[2]);

  const cx = (xMin + xMax) / 2;
  const cz = (zMin + zMax) / 2;
  const target: Vec3 = [cx, groundY, cz];

  const halfX = ((xMax - xMin) / 2) * (1 + margin);
  const halfZ = ((zMax - zMin) / 2) * (1 + margin);

  const pitchRad = (pitchDeg * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);
  const sinPitch = Math.sin(pitchRad);

  const fovRad = (options.fovDegrees * Math.PI) / 180;
  const tanHalfFovV = Math.tan(fovRad / 2);
  // Aspect ratio guards: a zero/negative aspect would otherwise NaN the
  // horizontal distance.
  const aspect = options.aspectRatio > 0 ? options.aspectRatio : 1;
  const tanHalfFovH = aspect * tanHalfFovV;

  // Project the bounds onto the view plane (perpendicular to the camera ray):
  // - X axis is perpendicular to the camera's tilt rotation, so it is
  //   unaffected by pitch.
  // - The Z extent is foreshortened by cos(pitch) when projected onto the
  //   view plane.
  const viewHalfH = halfZ * cosPitch;
  const viewHalfW = halfX;

  // Distance required so each half-extent fits within its respective FOV.
  // tanHalfFov can never be 0 for positive FOVs, but guard regardless.
  const distV = tanHalfFovV > 0 ? viewHalfH / tanHalfFovV : 0;
  const distH = tanHalfFovH > 0 ? viewHalfW / tanHalfFovH : 0;
  let distance = Math.max(distV, distH);

  if (!Number.isFinite(distance) || distance <= 0) {
    distance = fallbackDist;
  }

  const position: Vec3 = [
    cx,
    groundY + distance * sinPitch,
    cz + distance * cosPitch,
  ];

  return { position, target };
}
