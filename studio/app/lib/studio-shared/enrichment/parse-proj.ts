/**
 * PROJ4 string parsing utilities — pure functions for extracting projection parameters.
 * Moved from apps/web to packages/shared for use by scene graph builders.
 */

/** Extract +lat_0= +lon_0= from a PROJ4-style string (OpenDRIVE geoReference). */
export function parseProjOrigin(proj: string): { lat: number; lon: number } | null {
  const latM = proj.match(/\+lat_0=([-0-9.eE]+)/);
  const lonM = proj.match(/\+lon_0=([-0-9.eE]+)/);
  if (!latM?.[1] || !lonM?.[1]) return null;
  const lat = Number(latM[1]);
  const lon = Number(lonM[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function projProjectionType(proj: string): string | undefined {
  const m = proj.match(/\+proj=(\w+)/);
  return m?.[1];
}

/** UTM zone label e.g. "10N" from origin lon/lat. */
export function utmZoneFromLonLat(lon: number, lat: number): string {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const clamped = Math.min(60, Math.max(1, zone));
  const hemi = lat >= 0 ? "N" : "S";
  return `${clamped}${hemi}`;
}

export function parseDatum(proj: string): string | undefined {
  const m = proj.match(/\+datum=(\w+)/i);
  return m?.[1];
}

export function parseHorizontalUnits(proj: string): string | undefined {
  const m = proj.match(/\+units=(\w+)/i);
  return m?.[1];
}

export function parseVerticalUnits(proj: string): string | undefined {
  const m = proj.match(/\+vunits=(\w+)/i);
  return m?.[1];
}
