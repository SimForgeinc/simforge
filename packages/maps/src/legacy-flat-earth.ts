/**
 * The legacy V2XCarla "flat-earth" frame (`digital_twin_bridge/geo_utils.py`,
 * CARLA 0.10 path) as a first-class SimForge frame.
 *
 * ## Definition (pinned, not rederived)
 *
 * Given the map's tmerc natural origin `(lat0, lon0)` from the XODR
 * `<geoReference>`:
 *
 * ```
 *   x =  (lon − lon0) · 111320 · cos(lat0)      // metres east
 *   y = −(lat − lat0) · 111320                  // metres, Y NEGATED (UE4 left-handed)
 * ```
 *
 * This is what the deployed twin used for every calibrated artifact: the four
 * Richmond site-camera poses (`gps_to_carla` on the shared pole lat/lon),
 * detection mirroring, trajectory GPS playback and user zones. It is an
 * equirectangular approximation around the origin, **not** the strict tmerc
 * projection — see {@link LegacyFlatEarthFrame.toXodrLocal}, which quantifies
 * the divergence (≈0.23 m at the camera pole, ≈0.95 m at the site's NE
 * corner). Calibrations live in this frame; map assets live in xodr-local;
 * consumers must convert explicitly and refuse mismatched map digests.
 */

/** A WGS-84 geographic point in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Metres per degree latitude constant from `geo_utils.py`. */
export const METERS_PER_DEG_LAT = 111_320.0;

export class LegacyFlatEarthFrame {
  /** Origin latitude, degrees. */
  readonly lat0: number;
  /** Origin longitude, degrees. */
  readonly lon0: number;
  /** Metres per degree longitude at the origin latitude. */
  readonly metersPerDegLon: number;

  constructor(lat0: number, lon0: number) {
    if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) {
      throw new Error('LegacyFlatEarthFrame: lat0/lon0 must be finite degrees');
    }
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  }

  /**
   * Build from an OpenDRIVE `<geoReference>` PROJ string by extracting its
   * `+lat_0` / `+lon_0` natural-origin parameters.
   *
   * @throws If the string does not carry finite `+lat_0` and `+lon_0`.
   */
  static fromProjString(projString: string): LegacyFlatEarthFrame {
    const lat0 = numberParam(projString, 'lat_0');
    const lon0 = numberParam(projString, 'lon_0');
    if (lat0 === null || lon0 === null) {
      throw new Error(
        `LegacyFlatEarthFrame: projString lacks +lat_0/+lon_0: ${projString}`,
      );
    }
    return new LegacyFlatEarthFrame(lat0, lon0);
  }

  /** WGS-84 degrees -> CARLA-world metres (x east, y negated northing). */
  wgs84ToLocal(lat: number, lon: number): { x: number; y: number } {
    return {
      x: (lon - this.lon0) * this.metersPerDegLon,
      y: -((lat - this.lat0) * METERS_PER_DEG_LAT),
    };
  }

  /** CARLA-world metres -> WGS-84 degrees. Exact inverse of {@link wgs84ToLocal}. */
  localToWgs84(x: number, y: number): LatLon {
    return {
      lat: this.lat0 - y / METERS_PER_DEG_LAT,
      lon: this.lon0 + x / this.metersPerDegLon,
    };
  }
}

function numberParam(projString: string, key: string): number | null {
  const m = new RegExp(`\\+${key}=([^\\s+]*)`).exec(projString);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}
