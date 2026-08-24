/**
 * The detection model — a closed-form, deterministic answer to one question:
 * *does this sensor report this actor on this tick, and if not, why not?*
 *
 * ## Shape of the answer
 *
 * Four hard gates come first, because they are not matters of degree:
 * the sensor is off, the target is absent, the target is outside the aperture
 * (range or field of view), or the geometric line of sight is blocked. Each has
 * its own recorded reason, so "it was behind me" is never confused with
 * "I could not see through the fog".
 *
 * Past the gates, confidence is a product of independent physical terms, each
 * written in the same `1 − threshold/actual` form so they compose without a
 * tuning constant:
 *
 * | term | limit it encodes | range where it reaches 0 |
 * |---|---|---|
 * | contrast | Koschmieder extinction vs the detector's contrast floor ε | `V·ln(1/ε)/3.912` |
 * | resolution | the detector's minimum resolvable angular height θ | `h/θ` |
 * | precipitation | scatter and streaking on top of extinction | — |
 * | illumination | the detector's minimum scene illumination | — |
 * | glare | a bright source within `halfAngle` of the target's bearing | — |
 *
 * `V·ln(1/ε)/3.912` with ε = 0.05 *is* the meteorological definition of
 * visibility, so `fogVisibilityM: 120` means what a weather report means by it.
 *
 * Per-modality `sensitivity` exponents make a radar's indifference to fog and a
 * lidar's indifference to darkness fall out of the same evaluator rather than
 * out of a branch on sensor type.
 *
 * Nothing here reads a clock, a random number, or any state other than the
 * arguments: the same tick geometry always yields the same confidence.
 */

import { angleDelta, clamp, type Vec2 } from '../core/math.js';
import type { Atmosphere, DetectionModel, SimSensor } from './schema.js';

/**
 * Koschmieder's constant, `−ln(0.02)`.
 *
 * It pairs with a 2% contrast threshold — the classical *visual range* — so a
 * detector whose `contrastThreshold` is 0.02 has a fog detection range exactly
 * equal to the authored `fogVisibilityM`. A detector with a different floor
 * scales off that reference rather than off a second constant.
 */
export const KOSCHMIEDER_K = 3.912023005428146;
/** Precipitation rate, mm/h, that halves the usable contrast on its own. */
export const PRECIPITATION_HALF_MM_PER_H = 25;

/**
 * Detection status, ordered so that a larger number is strictly more
 * perception. The trace records the number; this is the legend.
 */
export const DETECTION_STATUS = {
  absent: 0,
  missed: 1,
  degraded: 2,
  detected: 3,
} as const;
export type DetectionStatusName = keyof typeof DETECTION_STATUS;
export type DetectionStatusCode = (typeof DETECTION_STATUS)[DetectionStatusName];

/** Legend for the recorded `reason` channel, in code order. */
export const DETECTION_REASONS = [
  'detected',
  'absent',
  'disabled',
  'out_of_range',
  'out_of_fov',
  'occluded',
  'atmospheric_attenuation',
  'below_angular_resolution',
  'low_light',
  'glare',
] as const;
export type DetectionReason = (typeof DETECTION_REASONS)[number];

export function detectionReasonCode(reason: DetectionReason): number {
  return DETECTION_REASONS.indexOf(reason);
}

/** A bright thing that can wash out a detector. */
export interface GlareSource {
  /** Unit direction towards the source in the sensor frame: azimuth, elevation. */
  readonly azimuthRad: number;
  readonly elevationRad: number;
  readonly halfAngleRad: number;
  /** Confidence lost when the target sits exactly on the source, 0..1. */
  readonly intensity: number;
}

export interface SensorPose {
  /** Sensor origin in the engine's local `(x, y)` plane. */
  readonly position: Vec2;
  /** Boresight direction in the same plane, radians CCW from `+x`. */
  readonly boresightRad: number;
  /** Height of the origin above the ground plane, metres. */
  readonly heightM: number;
}

export interface PerceivedTarget {
  readonly present: boolean;
  readonly position: Vec2;
  /** Full height of the target's box; the silhouette the detector must resolve. */
  readonly heightM: number;
}

export interface DetectionObservation {
  readonly status: DetectionStatusCode;
  readonly reason: DetectionReason;
  /** 0 when a hard gate rejected the target. */
  readonly confidence: number;
  readonly rangeM: number;
  /** Signed bearing off boresight, radians. */
  readonly bearingRad: number;
  /**
   * The target is present, the sensor is on, and the target is inside the
   * range and field-of-view bounds. It says nothing about whether anything is
   * in the way — that is `observable`.
   */
  readonly inAperture: boolean;
  /** `inAperture` and the geometric line of sight is clear. */
  readonly observable: boolean;
}

/** Resolve the sensor's origin and boresight from its mount and its carrier. */
export function sensorPose(
  sensor: SimSensor,
  carrier: { readonly position: Vec2; readonly headingRad: number },
): SensorPose {
  const cos = Math.cos(carrier.headingRad);
  const sin = Math.sin(carrier.headingRad);
  // Mount is `+x` forward, `+z` left in the actor frame; in the engine plane
  // "left" of heading θ is (−sin θ, cos θ).
  const forward = sensor.mount.position.x;
  const left = sensor.mount.position.z;
  return {
    position: {
      x: carrier.position.x + forward * cos - left * sin,
      y: carrier.position.y + forward * sin + left * cos,
    },
    boresightRad: carrier.headingRad + sensor.mount.rotation.yawRad,
    heightM: sensor.mount.position.y,
  };
}

/** `1 − threshold/actual`, clamped — the shared shape of every soft term. */
function headroom(actual: number, threshold: number): number {
  if (!(actual > 0)) return 0;
  return clamp(1 - threshold / actual, 0, 1);
}

/** Apparent contrast of a black target at range `r` through visibility `V`. */
export function koschmiederContrast(rangeM: number, fogVisibilityM: number): number {
  return Math.exp((-KOSCHMIEDER_K * rangeM) / fogVisibilityM);
}

/** The range at which apparent contrast falls to the detector's floor. */
export function contrastLimitedRangeM(fogVisibilityM: number, contrastThreshold: number): number {
  return (fogVisibilityM * Math.log(1 / contrastThreshold)) / KOSCHMIEDER_K;
}

/** The range at which the target's silhouette falls below angular resolution. */
export function resolutionLimitedRangeM(targetHeightM: number, minAngularSizeRad: number): number {
  return targetHeightM / minAngularSizeRad;
}

/** Worst-case confidence loss from any source near the target's bearing. */
function glareLoss(
  sources: readonly GlareSource[],
  targetAzimuthRad: number,
  targetElevationRad: number,
): number {
  let worst = 0;
  for (const source of sources) {
    const separation = angularSeparationRad(
      source.azimuthRad,
      source.elevationRad,
      targetAzimuthRad,
      targetElevationRad,
    );
    const loss = source.intensity * clamp(1 - separation / source.halfAngleRad, 0, 1);
    if (loss > worst) worst = loss;
  }
  return worst;
}

/** Great-circle angle between two (azimuth, elevation) directions, radians. */
export function angularSeparationRad(
  azA: number,
  elA: number,
  azB: number,
  elB: number,
): number {
  const dot =
    Math.cos(elA) * Math.cos(elB) * Math.cos(azA - azB) + Math.sin(elA) * Math.sin(elB);
  return Math.acos(clamp(dot, -1, 1));
}

export interface ObserveArgs {
  readonly sensor: SimSensor;
  readonly pose: SensorPose;
  readonly target: PerceivedTarget;
  /** Geometric line of sight, as computed by the occluder layer. */
  readonly lineOfSight: boolean;
  readonly atmosphere: Atmosphere;
  /** Already resolved into the sensor's own azimuth/elevation frame. */
  readonly glareSources: readonly GlareSource[];
}

function classify(model: DetectionModel, confidence: number): DetectionStatusCode {
  if (confidence >= model.detectConfidence) return DETECTION_STATUS.detected;
  if (confidence >= model.degradedConfidence) return DETECTION_STATUS.degraded;
  return DETECTION_STATUS.missed;
}

/** The whole model, for one sensor and one target, on one tick. */
export function observeTarget(args: ObserveArgs): DetectionObservation {
  const { sensor, pose, target, atmosphere } = args;
  const dx = target.position.x - pose.position.x;
  const dy = target.position.y - pose.position.y;
  const rangeM = Math.hypot(dx, dy);
  const bearingRad = angleDelta(pose.boresightRad, Math.atan2(dy, dx));

  if (!target.present) {
    return miss(DETECTION_STATUS.absent, 'absent', rangeM, bearingRad, false);
  }
  if (!sensor.enabled) {
    return miss(DETECTION_STATUS.missed, 'disabled', rangeM, bearingRad, false);
  }
  if (rangeM < sensor.aperture.nearM || rangeM > sensor.aperture.farM) {
    return miss(DETECTION_STATUS.missed, 'out_of_range', rangeM, bearingRad, false);
  }
  const halfFovRad = (sensor.aperture.horizontalFovDeg * Math.PI) / 360;
  if (Math.abs(bearingRad) > halfFovRad) {
    return miss(DETECTION_STATUS.missed, 'out_of_fov', rangeM, bearingRad, false);
  }
  // Targets are boxes on the ground; the elevation that matters is the one to
  // the middle of the silhouette, which is what a detector centres on.
  const targetElevationRad = Math.atan2(target.heightM / 2 - pose.heightM, Math.max(rangeM, 1e-6));
  const halfVFovRad = (sensor.aperture.verticalFovDeg * Math.PI) / 360;
  if (Math.abs(targetElevationRad) > halfVFovRad) {
    return miss(DETECTION_STATUS.missed, 'out_of_fov', rangeM, bearingRad, false);
  }
  if (!args.lineOfSight) {
    return miss(DETECTION_STATUS.missed, 'occluded', rangeM, bearingRad, true);
  }

  const model = sensor.detection;
  const s = model.sensitivity;

  const contrastRangeM = contrastLimitedRangeM(atmosphere.fogVisibilityM, model.contrastThreshold);
  const contrastTerm = clamp(1 - rangeM / contrastRangeM, 0, 1);
  const precipitationTerm = 1 / (1 + atmosphere.precipitationMmPerH / PRECIPITATION_HALF_MM_PER_H);
  const atmosphericTerm = Math.pow(contrastTerm * precipitationTerm, s.atmosphere);

  const resolutionRangeM = resolutionLimitedRangeM(target.heightM, model.minAngularSizeRad);
  const resolutionTerm = clamp(1 - rangeM / resolutionRangeM, 0, 1);

  const illuminationTerm = Math.pow(
    headroom(atmosphere.illuminationFrac, model.minIlluminationFrac),
    s.illumination,
  );

  const azimuthOffBoresight = bearingRad;
  const loss = glareLoss(args.glareSources, azimuthOffBoresight, targetElevationRad);
  const glareTerm = Math.pow(1 - loss, s.glare);

  const confidence = clamp(
    atmosphericTerm * resolutionTerm * illuminationTerm * glareTerm,
    0,
    1,
  );
  const status = classify(model, confidence);
  const reason: DetectionReason =
    status === DETECTION_STATUS.detected
      ? 'detected'
      : dominantReason({ atmosphericTerm, resolutionTerm, illuminationTerm, glareTerm });

  return { status, reason, confidence, rangeM, bearingRad, inAperture: true, observable: true };
}

/** The term that cost the most confidence — the honest single-word "why". */
function dominantReason(terms: {
  atmosphericTerm: number;
  resolutionTerm: number;
  illuminationTerm: number;
  glareTerm: number;
}): DetectionReason {
  const ranked: Array<[number, DetectionReason]> = [
    [terms.atmosphericTerm, 'atmospheric_attenuation'],
    [terms.resolutionTerm, 'below_angular_resolution'],
    [terms.illuminationTerm, 'low_light'],
    [terms.glareTerm, 'glare'],
  ];
  let best = ranked[0]!;
  for (const entry of ranked) if (entry[0] < best[0]) best = entry;
  return best[1];
}

function miss(
  status: DetectionStatusCode,
  reason: DetectionReason,
  rangeM: number,
  bearingRad: number,
  inAperture: boolean,
): DetectionObservation {
  return { status, reason, confidence: 0, rangeM, bearingRad, inAperture, observable: false };
}
