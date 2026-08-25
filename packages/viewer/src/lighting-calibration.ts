/**
 * SimForge lighting calibration — Three-viewer implementation.
 *
 * This module and `renderer/render-core/src/calibration.rs` are duplicated
 * implementations of ONE spec: docs/lighting-calibration.md. Change the doc
 * first, then land both modules in the same commit.
 */

/** Solar illuminance above the atmosphere, lux. */
export const EXTRATERRESTRIAL_ILLUMINANCE_LX = 128_000;

/** Meinel/Laue clear-atmosphere transmittance per unit air mass. */
export const ATMOSPHERIC_TRANSMITTANCE = 0.7;

/** Sun angular diameter seen from Earth, degrees (penumbra width driver). */
export const SUN_ANGULAR_DIAMETER_DEG = 0.53;

/** Sun elevation (degrees) below which the sun contributes no direct light. */
export const CIVIL_TWILIGHT_DEG = -6;

/**
 * Fixed sensor-profile EV100 per condition (incident convention:
 * EV100 = log2(lux / 2.5), ISO 100).
 */
export const SENSOR_EV100 = {
  clear: 15,
  fog: 14,
  rain: 13.5,
  night: 9,
} as const;

/** Human-facing outputs tonemap with AgX; sensor output is linear. */
export const DEFAULT_TONEMAP = 'AgX';

/**
 * Target shadowed/sunlit luminance ratio band on horizontal surfaces
 * (linear). Calibration acceptance: outside this band, sky and sun are
 * unbalanced.
 */
export const SHADOW_FILL_RATIO_MIN = 0.15;
export const SHADOW_FILL_RATIO_MAX = 0.25;

/**
 * Viewer working units (editor units, AgX exposure 1). Calibrated against the
 * spec's ratios: 5 / 0.6 is where path-traced baked shadows read at street
 * level while the shadowed/sunlit ratio stays inside the band above.
 */
export const VIEWER_SUN_INTENSITY = 5;
export const VIEWER_ENVIRONMENT_INTENSITY = 0.6;
export const VIEWER_EXPOSURE = 1;

/** Kasten–Young (1989) relative optical air mass; finite at the horizon. */
export function airMass(elevationDeg: number): number {
  const h = Math.max(elevationDeg, -1);
  const sinH = Math.sin((h * Math.PI) / 180);
  return 1 / (sinH + 0.50572 * (h + 6.07995) ** -1.6364);
}

/** Linear 1→0 direct-sun ramp from the horizon down to civil twilight. */
export function twilightRamp(elevationDeg: number): number {
  if (!Number.isFinite(elevationDeg)) return 1;
  if (elevationDeg >= 0) return 1;
  if (elevationDeg <= CIVIL_TWILIGHT_DEG) return 0;
  return 1 - elevationDeg / CIVIL_TWILIGHT_DEG;
}

/**
 * Direct-normal sun illuminance (lux) for a sun elevation, Meinel model:
 * `E_ext * T^(m^0.678)`, ramped to zero through civil twilight.
 */
export function sunDirectNormalIlluminanceLx(elevationDeg: number): number {
  const ramp = twilightRamp(elevationDeg);
  if (ramp === 0) return 0;
  const m = airMass(Math.max(elevationDeg, 0));
  return EXTRATERRESTRIAL_ILLUMINANCE_LX * ATMOSPHERIC_TRANSMITTANCE ** (m ** 0.678) * ramp;
}

/** Direct horizontal sun illuminance (lux): `E_dn(h) * sin h`. */
export function sunDirectHorizontalIlluminanceLx(elevationDeg: number): number {
  const sinH = Math.sin((Math.max(elevationDeg, 0) * Math.PI) / 180);
  return sunDirectNormalIlluminanceLx(elevationDeg) * sinH;
}

/**
 * Sun colour temperature (Kelvin) vs elevation: 5 500 K high sun cooling to
 * 2 500 K at the horizon, held below it.
 */
export function sunColorTemperatureK(elevationDeg: number): number {
  const t = Math.min(1, Math.max(0, elevationDeg / 30));
  return 2500 + 3000 * t;
}

/**
 * Fixed clear-weather EV100 tracking the sun model: 15 at the 60° reference,
 * darkening with direct horizontal illuminance, clamped to the lit-street
 * floor of 9.
 */
export function ev100ForSunElevation(elevationDeg: number): number {
  const reference = sunDirectHorizontalIlluminanceLx(60);
  const e = Math.max(sunDirectHorizontalIlluminanceLx(elevationDeg), 1);
  const ev = SENSOR_EV100.clear + Math.log2(e / reference);
  return Math.min(SENSOR_EV100.clear, Math.max(SENSOR_EV100.night, ev));
}
