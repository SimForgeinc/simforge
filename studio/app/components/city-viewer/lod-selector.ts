import type { AABB } from "./types";

// ---------------------------------------------------------------------------
// Pure-function LOD selector.
//
// `selectLod` projects each LOD's geometric error to a screen-space pixel
// error and returns the coarsest LOD whose projected error is under the
// supplied threshold. A configurable hysteresis band biases against switching
// when the camera sits near a LOD boundary, given the previously-selected LOD.
//
// Vegetation tiles must call this with the same threshold as architecture
// tiles. ADR-0001 (`docs/adr/0001-vegetation-uses-building-sse-threshold.md`)
// rejects the pipeline's `VEGETATION_GEOMETRIC_ERROR_MULTIPLIER` in favor of a
// single threshold-driven path. This module deliberately exposes one
// threshold and never branches on tile type.
//
// The function holds no internal state: callers persist `prevLod` per tile.
// ---------------------------------------------------------------------------

export interface SelectorCamera {
  position: { x: number; y: number; z: number };
  /** Vertical field-of-view, degrees. */
  fov: number;
  /** Viewport height in pixels. */
  screenHeightPx: number;
}

export interface SelectLodOptions {
  /** Floor on the finest selectable LOD. Default 0. */
  minLodLevel?: number;
  /** Fractional band around `ssePxThreshold` that biases toward `prevLod`. Default 0.15. */
  hysteresisFraction?: number;
}

const MIN_DIST = 1;
const DEFAULT_HYSTERESIS_FRACTION = 0.15;

function pickRaw(
  lodErrors: readonly number[],
  sseFactor: number,
  dist: number,
  threshold: number,
  minLodLevel: number,
): number {
  for (let i = lodErrors.length - 1; i >= 0; i--) {
    const pixelError = (lodErrors[i]! * sseFactor) / dist;
    if (pixelError <= threshold) return Math.max(i, minLodLevel);
  }
  return minLodLevel;
}

export function selectLod(
  camera: SelectorCamera,
  tileBounds: AABB,
  lodErrors: readonly number[],
  prevLod: number,
  ssePxThreshold: number,
  options: SelectLodOptions = {},
): number {
  const minLodLevel = options.minLodLevel ?? 0;
  const hysteresisFraction = options.hysteresisFraction ?? DEFAULT_HYSTERESIS_FRACTION;

  if (lodErrors.length === 0) return minLodLevel;

  const cx = (tileBounds.min[0] + tileBounds.max[0]) / 2;
  const cy = (tileBounds.min[1] + tileBounds.max[1]) / 2;
  const cz = (tileBounds.min[2] + tileBounds.max[2]) / 2;
  const dx = camera.position.x - cx;
  const dy = camera.position.y - cy;
  const dz = camera.position.z - cz;
  const dist = Math.max(MIN_DIST, Math.sqrt(dx * dx + dy * dy + dz * dz));

  const fovRad = (camera.fov * Math.PI) / 180;
  const sseFactor = camera.screenHeightPx / (2 * Math.tan(fovRad / 2));

  const natural = pickRaw(lodErrors, sseFactor, dist, ssePxThreshold, minLodLevel);

  const prevValid =
    prevLod >= minLodLevel && prevLod < lodErrors.length && prevLod !== natural;
  if (!prevValid || hysteresisFraction <= 0) return natural;

  // Bias the threshold against switching: harder to coarsen if the camera is
  // moving toward the tile (natural > prev), harder to refine if it's moving
  // away. If the prev LOD still wins under the biased threshold, stick.
  const adjusted =
    natural > prevLod
      ? ssePxThreshold * (1 - hysteresisFraction)
      : ssePxThreshold * (1 + hysteresisFraction);
  const confirmed = pickRaw(lodErrors, sseFactor, dist, adjusted, minLodLevel);
  return confirmed === prevLod ? prevLod : natural;
}
