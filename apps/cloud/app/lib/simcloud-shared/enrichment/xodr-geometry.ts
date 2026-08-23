/**
 * XODR geometry sampling and coordinate transform utilities.
 *
 * Converts OpenDRIVE road reference-line geometry (line, arc, spiral)
 * from the local Cartesian frame into WGS-84 (lon, lat) coordinates
 * suitable for GeoJSON output.
 *
 * Moved from apps/web to packages/shared for use by scene graph builders.
 * All functions are pure math — no Node.js dependencies.
 */

import { attr } from "./xodr-utils";
import { MapProjection } from "./proj";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type XY = { x: number; y: number };

export type GeometrySegment = {
  s: number;
  x: number;
  y: number;
  hdg: number;
  length: number;
  type: "line" | "arc" | "spiral";
  curvature?: number; // arc
  curvStart?: number; // spiral
  curvEnd?: number; // spiral
};

export type CoordTransform = {
  originLat: number;
  originLon: number;
  /**
   * Optional PROJ string (verbatim from the XODR's `<geoReference>`). When
   * present this is what proj4 uses; when absent we synthesize a vanilla
   * `+proj=tmerc +lat_0=…+lon_0=…` from the origin. Always pass it through
   * when you have it — RoadRunner emits `+k=1 +x_0=0 +y_0=0` consistently
   * but a future map source might not.
   */
  projString?: string;
};

// ---------------------------------------------------------------------------
// Coordinate transform: local (x, y) → WGS-84 (lon, lat)
// ---------------------------------------------------------------------------

/**
 * Project a (y-up) CARLA local-meter coordinate back to WGS84 (lon, lat).
 * Builds a `MapProjection` from the asset's declared PROJ string when
 * available, falling back to a synthesized vanilla `+proj=tmerc` from the
 * origin lat/lon (matches RoadRunner's typical export form).
 */
export function localToLonLat(
  xy: XY,
  t: CoordTransform,
): [lon: number, lat: number] {
  const proj = MapProjection.fromCoordinateRef({
    proj_string: t.projString,
    origin_lat: t.originLat,
    origin_lon: t.originLon,
  })!;
  const { lon, lat } = proj.localToGeo(xy.x, xy.y);
  return [lon, lat];
}

// ---------------------------------------------------------------------------
// Geometry sampling
// ---------------------------------------------------------------------------

const SAMPLE_STEP = 2; // metres between sample points

/** Sample a line segment — just start and end. */
function sampleLine(seg: GeometrySegment): XY[] {
  const { x, y, hdg, length } = seg;
  const cosH = Math.cos(hdg);
  const sinH = Math.sin(hdg);
  return [
    { x, y },
    { x: x + cosH * length, y: y + sinH * length },
  ];
}

/** Sample a constant-curvature arc. */
function sampleArc(seg: GeometrySegment): XY[] {
  const { x, y, hdg, length, curvature = 0 } = seg;
  if (Math.abs(curvature) < 1e-12) return sampleLine(seg);

  const steps = Math.max(2, Math.ceil(length / SAMPLE_STEP));
  const ds = length / steps;
  const pts: XY[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i * ds;
    const theta = hdg + curvature * s;
    if (Math.abs(curvature) < 1e-12) {
      pts.push({ x: x + Math.cos(hdg) * s, y: y + Math.sin(hdg) * s });
    } else {
      const dx =
        (Math.sin(theta) - Math.sin(hdg)) / curvature;
      const dy =
        (-Math.cos(theta) + Math.cos(hdg)) / curvature;
      pts.push({ x: x + dx, y: y + dy });
    }
  }
  return pts;
}

/** Sample an Euler spiral (clothoid). */
function sampleSpiral(seg: GeometrySegment): XY[] {
  const { x, y, hdg, length, curvStart = 0, curvEnd = 0 } = seg;
  if (length < 1e-9) return [{ x, y }];

  const steps = Math.max(2, Math.ceil(length / SAMPLE_STEP));
  const ds = length / steps;
  const pts: XY[] = [];

  const dk = (curvEnd - curvStart) / length;

  for (let i = 0; i <= steps; i++) {
    const s = i * ds;
    if (i === 0) {
      pts.push({ x, y });
      continue;
    }
    const n = Math.max(2, Math.ceil(s / 0.5));
    const h = s / n;
    let sumX = 0;
    let sumY = 0;
    for (let j = 0; j <= n; j++) {
      const sj = j * h;
      const theta = hdg + curvStart * sj + 0.5 * dk * sj * sj;
      const w = j === 0 || j === n ? 1 : j % 2 === 1 ? 4 : 2;
      sumX += w * Math.cos(theta);
      sumY += w * Math.sin(theta);
    }
    sumX *= h / 3;
    sumY *= h / 3;
    pts.push({ x: x + sumX, y: y + sumY });
  }
  return pts;
}

/** Sample any geometry segment into local XY points. */
export function sampleGeometry(seg: GeometrySegment): XY[] {
  switch (seg.type) {
    case "line":
      return sampleLine(seg);
    case "arc":
      return sampleArc(seg);
    case "spiral":
      return sampleSpiral(seg);
    default:
      return sampleLine(seg);
  }
}

// ---------------------------------------------------------------------------
// Road reference line: resolve (s, t) to local (x, y)
// ---------------------------------------------------------------------------

/**
 * Given a road's geometry segments and an (s, t) coordinate,
 * return the local (x, y) position.
 *
 * `s` = distance along the reference line from road start.
 * `t` = lateral offset (positive = left of travel direction).
 */
export function resolveSTtoXY(
  segments: GeometrySegment[],
  s: number,
  t: number,
): XY | undefined {
  if (segments.length === 0) return undefined;

  let seg: GeometrySegment | undefined;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (s >= segments[i]!.s) {
      seg = segments[i];
      break;
    }
  }
  if (!seg) seg = segments[0]!;

  const ds = s - seg.s;
  const dk = seg.type === "spiral" && seg.length > 0
    ? ((seg.curvEnd ?? 0) - (seg.curvStart ?? 0)) / seg.length
    : 0;

  let heading: number;
  if (seg.type === "arc") {
    heading = seg.hdg + (seg.curvature ?? 0) * ds;
  } else if (seg.type === "spiral") {
    heading = seg.hdg + (seg.curvStart ?? 0) * ds + 0.5 * dk * ds * ds;
  } else {
    heading = seg.hdg;
  }

  const pts = sampleGeometry({ ...seg, length: ds });
  const refPt = pts[pts.length - 1] ?? { x: seg.x, y: seg.y };

  const perpAngle = heading + Math.PI / 2;
  return {
    x: refPt.x + t * Math.cos(perpAngle),
    y: refPt.y + t * Math.sin(perpAngle),
  };
}

/**
 * Like `resolveSTtoXY` but also returns the road heading (radians) at position s.
 * Useful for building oriented polygons (e.g. crosswalks rotated to the road).
 */
export function resolveSTtoXYWithHeading(
  segments: GeometrySegment[],
  s: number,
  t: number,
): { xy: XY; heading: number } | undefined {
  if (segments.length === 0) return undefined;

  let seg: GeometrySegment | undefined;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (s >= segments[i]!.s) {
      seg = segments[i];
      break;
    }
  }
  if (!seg) seg = segments[0]!;

  const ds = s - seg.s;
  const dk = seg.type === "spiral" && seg.length > 0
    ? ((seg.curvEnd ?? 0) - (seg.curvStart ?? 0)) / seg.length
    : 0;

  let heading: number;
  if (seg.type === "arc") {
    heading = seg.hdg + (seg.curvature ?? 0) * ds;
  } else if (seg.type === "spiral") {
    heading = seg.hdg + (seg.curvStart ?? 0) * ds + 0.5 * dk * ds * ds;
  } else {
    heading = seg.hdg;
  }

  const pts = sampleGeometry({ ...seg, length: ds });
  const refPt = pts[pts.length - 1] ?? { x: seg.x, y: seg.y };

  const perpAngle = heading + Math.PI / 2;
  return {
    xy: {
      x: refPt.x + t * Math.cos(perpAngle),
      y: refPt.y + t * Math.sin(perpAngle),
    },
    heading,
  };
}

// ---------------------------------------------------------------------------
// XODR XML parsing helpers (geometry-specific)
// ---------------------------------------------------------------------------

/**
 * Parse all `<geometry>` segments from a `<road>` block body.
 */
export function parseGeometrySegments(roadBody: string): GeometrySegment[] {
  const segments: GeometrySegment[] = [];
  const geomRe = /<geometry\b([^>]*)>([\s\S]*?)<\/geometry>|<geometry\b([^>]*)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = geomRe.exec(roadBody)) !== null) {
    const attrs = m[1] ?? m[3] ?? "";
    const body = m[2] ?? "";

    const s = Number(attr(attrs, "s") ?? "0");
    const x = Number(attr(attrs, "x") ?? "0");
    const y = Number(attr(attrs, "y") ?? "0");
    const hdg = Number(attr(attrs, "hdg") ?? "0");
    const length = Number(attr(attrs, "length") ?? "0");

    if (!Number.isFinite(s) || !Number.isFinite(length)) continue;

    if (body.includes("<arc")) {
      const arcM = body.match(/<arc\b([^>]*)\/?>/i);
      const curvature = Number(attr(arcM?.[1] ?? "", "curvature") ?? "0");
      segments.push({ s, x, y, hdg, length, type: "arc", curvature });
    } else if (body.includes("<spiral")) {
      const spiralM = body.match(/<spiral\b([^>]*)\/?>/i);
      const spiralAttrs = spiralM?.[1] ?? "";
      const curvStart = Number(attr(spiralAttrs, "curvStart") ?? "0");
      const curvEnd = Number(attr(spiralAttrs, "curvEnd") ?? "0");
      segments.push({ s, x, y, hdg, length, type: "spiral", curvStart, curvEnd });
    } else {
      segments.push({ s, x, y, hdg, length, type: "line" });
    }
  }
  segments.sort((a, b) => a.s - b.s);
  return segments;
}

// ---------------------------------------------------------------------------
// Elevation profile (XODR <elevation> cubic polynomials)
// ---------------------------------------------------------------------------
//
// Each <elevation s a b c d/> encodes z(s') = a + b·ds + c·ds² + d·ds³
// where ds = s − s_entry. We sort entries by `s` and binary-search at sample
// time so a 100-segment road is still cheap to sample at 5 m strides.

export type ElevationEntry = {
  /** Station along the road reference line where this polynomial starts. */
  s: number;
  a: number;
  b: number;
  c: number;
  d: number;
};

/** Parse all `<elevation>` records from a single `<road>` block body. */
export function parseElevationProfile(roadBody: string): ElevationEntry[] {
  const entries: ElevationEntry[] = [];
  const elevRe = /<elevation\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = elevRe.exec(roadBody)) !== null) {
    const tag = m[1] ?? "";
    const s = Number(attr(tag, "s") ?? "0");
    const a = Number(attr(tag, "a") ?? "0");
    const b = Number(attr(tag, "b") ?? "0");
    const c = Number(attr(tag, "c") ?? "0");
    const d = Number(attr(tag, "d") ?? "0");
    if (!Number.isFinite(s) || !Number.isFinite(a)) continue;
    entries.push({ s, a, b, c, d });
  }
  entries.sort((x, y) => x.s - y.s);
  return entries;
}

/**
 * Evaluate the elevation polynomial active at station `s`. Returns the road
 * reference-line height in meters. Returns 0 when the profile is empty.
 */
export function sampleElevation(entries: ElevationEntry[], s: number): number {
  if (entries.length === 0) return 0;
  let entry = entries[0]!;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (s >= entries[i]!.s) {
      entry = entries[i]!;
      break;
    }
  }
  const ds = s - entry.s;
  return entry.a + entry.b * ds + entry.c * ds * ds + entry.d * ds * ds * ds;
}

/**
 * Sample a full road reference line from its geometry segments,
 * returning an array of [lon, lat] coordinates.
 */
export function sampleRoadReferenceLineToLonLat(
  segments: GeometrySegment[],
  transform: CoordTransform,
): [number, number][] {
  const coords: [number, number][] = [];
  for (const seg of segments) {
    const pts = sampleGeometry(seg);
    const start = coords.length > 0 ? 1 : 0;
    for (let i = start; i < pts.length; i++) {
      coords.push(localToLonLat(pts[i]!, transform));
    }
  }
  return coords;
}
