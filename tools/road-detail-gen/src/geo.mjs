/**
 * Georeference helpers: WGS84 lon/lat -> SimForge world XZ.
 *
 * Map bundles carry lane polygons in WGS84 (lane-polygons.geojson.gz) while
 * the GLB tiles live in the RoadRunner local frame (transverse mercator
 * centered on the xodr <geoReference> lat_0/lon_0, k=1). Over a <1 km map a
 * local ellipsoidal ENU approximation matches tmerc to ~centimeters, far
 * below splat texel size (~0.15 m/px).
 *
 * Frame mapping (verified against the easterbrook scene manifest bounds and
 * refs/carla-baseline/poses.json):
 *   simforge.x = local_x   (east)
 *   simforge.z = -local_y  (CARLA/UE up-down flip: sf.z = carla.y = -xodr.y)
 */

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

/** Parse `+lat_0=.. +lon_0=..` out of an OpenDRIVE geoReference proj string. */
export function parseGeoReference(xodrText) {
  const m = /<geoReference>\s*<!\[CDATA\[([^\]]+)\]\]>/.exec(xodrText);
  if (!m) throw new Error('xodr has no <geoReference> CDATA');
  const proj = m[1];
  const lat = /\+lat_0=([-\d.eE+]+)/.exec(proj);
  const lon = /\+lon_0=([-\d.eE+]+)/.exec(proj);
  if (!lat || !lon) throw new Error(`geoReference lacks lat_0/lon_0: ${proj}`);
  return { lat0: Number(lat[1]), lon0: Number(lon[1]) };
}

/** Build a lon/lat -> {x, z} converter for one map origin. */
export function makeProjector({ lat0, lon0 }) {
  const phi = (lat0 * Math.PI) / 180;
  const s = Math.sin(phi);
  const den = Math.sqrt(1 - WGS84_E2 * s * s);
  // Prime-vertical and meridional radii of curvature at the origin.
  const nRad = WGS84_A / den;
  const mRad = (WGS84_A * (1 - WGS84_E2)) / (den * den * den);
  const kx = ((Math.PI / 180) * nRad * Math.cos(phi));
  const ky = (Math.PI / 180) * mRad;
  return (lon, lat) => {
    const x = (lon - lon0) * kx;
    const y = (lat - lat0) * ky;
    return { x, z: -y };
  };
}
