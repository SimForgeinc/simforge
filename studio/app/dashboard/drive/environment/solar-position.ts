import type { TimeOfDay } from "@simforge/scenario";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MINUTES_PER_DAY = 24 * 60;

export interface SolarPosition {
  /** Geometric elevation above the horizon. Atmospheric refraction is not applied. */
  readonly elevationDeg: number;
  /** Compass azimuth clockwise from geographic north. */
  readonly azimuthDeg: number;
  readonly hourAngleDeg: number;
  readonly equationOfTimeMinutes: number;
}

/**
 * Solar position using NOAA's fractional-year equations.
 *
 * `at` is read exclusively through UTC accessors. Longitude is conventional
 * WGS84 (east positive), so no browser or site timezone enters the result.
 */
export function solarPosition(at: Date, lat: number, lon: number): SolarPosition {
  if (!Number.isFinite(at.getTime())) throw new Error("solar position requires a valid instant");
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("latitude must be within [-90, 90]");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("longitude must be within [-180, 180]");

  const startOfYear = Date.UTC(at.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
  ) - startOfYear) / 86_400_000) + 1;
  const utcHours = at.getUTCHours()
    + at.getUTCMinutes() / 60
    + at.getUTCSeconds() / 3_600
    + at.getUTCMilliseconds() / 3_600_000;
  const fractionalYear = 2 * Math.PI / 365 * (dayOfYear - 1 + (utcHours - 12) / 24);

  const equationOfTimeMinutes = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(fractionalYear)
    - 0.032077 * Math.sin(fractionalYear)
    - 0.014615 * Math.cos(2 * fractionalYear)
    - 0.040849 * Math.sin(2 * fractionalYear)
  );
  const declination = 0.006918
    - 0.399912 * Math.cos(fractionalYear)
    + 0.070257 * Math.sin(fractionalYear)
    - 0.006758 * Math.cos(2 * fractionalYear)
    + 0.000907 * Math.sin(2 * fractionalYear)
    - 0.002697 * Math.cos(3 * fractionalYear)
    + 0.00148 * Math.sin(3 * fractionalYear);

  const trueSolarMinutes = ((utcHours * 60 + equationOfTimeMinutes + 4 * lon) % MINUTES_PER_DAY
    + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  let hourAngleDeg = trueSolarMinutes / 4 - 180;
  if (hourAngleDeg < -180) hourAngleDeg += 360;

  const latitude = lat * DEG_TO_RAD;
  const hourAngle = hourAngleDeg * DEG_TO_RAD;
  const cosineZenith = Math.max(-1, Math.min(1,
    Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  ));
  const elevationDeg = 90 - Math.acos(cosineZenith) * RAD_TO_DEG;
  const azimuthDeg = (
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
    ) * RAD_TO_DEG + 180 + 360
  ) % 360;

  return { elevationDeg, azimuthDeg, hourAngleDeg, equationOfTimeMinutes };
}

export interface SolarLighting {
  readonly timeOfDay: TimeOfDay;
  /** Canonical scene-clock minute used only for the shipped appearance interpolation. */
  readonly appearanceMinutes: number;
  /** Scene azimuth consumed by applyEditorSceneEnvironment (0 = +Z). */
  readonly sceneAzimuthDeg: number;
}

/**
 * Keeps ambient intensity on the shipped scene-clock curve while preserving the
 * exact solar elevation and azimuth on the directional light and sky dome.
 */
export function lightingForSolarPosition(position: SolarPosition): SolarLighting {
  const { elevationDeg, hourAngleDeg } = position;
  const rising = hourAngleDeg < 0;
  let timeOfDay: TimeOfDay;
  let appearanceMinutes: number;

  if (elevationDeg <= -6) {
    timeOfDay = "night_lit";
    appearanceMinutes = 0;
  } else if (elevationDeg < 0) {
    const twilight = (elevationDeg + 6) / 6;
    timeOfDay = rising ? "dawn" : "dusk";
    appearanceMinutes = rising
      ? 5 * 60 + twilight * 60
      : 20 * 60 - twilight * 2 * 60;
  } else {
    const solarMinutes = 12 * 60 + hourAngleDeg * 4;
    appearanceMinutes = Math.max(6 * 60, Math.min(18 * 60, solarMinutes));
    if (elevationDeg < 6) timeOfDay = rising ? "dawn" : "dusk";
    else if (hourAngleDeg < -45) timeOfDay = "morning";
    else if (hourAngleDeg > 45) timeOfDay = "afternoon";
    else timeOfDay = "noon";
  }

  return {
    timeOfDay,
    appearanceMinutes,
    // Scene +Z points south because OpenDRIVE north maps to scene -Z.
    sceneAzimuthDeg: (180 - position.azimuthDeg + 360) % 360,
  };
}

export function solarPositionMoved(
  previous: SolarPosition | null,
  next: SolarPosition,
  thresholdDeg = 0.25,
): boolean {
  if (previous === null) return true;
  const azimuthDelta = Math.abs(previous.azimuthDeg - next.azimuthDeg);
  const wrappedAzimuthDelta = Math.min(azimuthDelta, 360 - azimuthDelta);
  return Math.abs(previous.elevationDeg - next.elevationDeg) >= thresholdDeg
    || wrappedAzimuthDelta >= thresholdDeg;
}
