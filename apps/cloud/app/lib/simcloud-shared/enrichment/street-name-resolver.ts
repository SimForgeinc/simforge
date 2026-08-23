/**
 * Street name resolver for candidate locations.
 *
 * Matches Overture road segment LineString geometries to candidate location
 * centers by proximity, then formats human-readable labels per candidate kind.
 *
 * Pure functions — no server dependencies, no DB access.
 */

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal candidate shape needed for street name resolution. */
export interface CandidateForNaming {
  id: string;
  kind: string;
  center: { lat: number; lng: number };
  label: string;
  description?: string;
  /**
   * Optional polygon ring in [lng, lat] pairs. When provided, the resolver
   * matches road segments against both the centroid and each boundary vertex
   * and keeps the minimum distance. This is essential for large parking lots
   * where the center can be 50 m+ from the nearest access road.
   */
  boundary?: [number, number][];
}

/** Minimal road segment shape needed for matching. */
export interface RoadSegmentForMatching {
  name: string;
  road_class: string | null;
  /** Posted maximum speed limit in mph (Overture `speed_limits`). Optional —
   *  most segments carry none. Survives persistence (it is a scalar, unlike
   *  `geojson_geometry`, which is stripped) so the search-index rebuild can
   *  attach it to street objects as a `speed_limit_mph` fact. */
  speed_limit_mph?: number;
  /** Stringified GeoJSON geometry (LineString). Optional — when absent, matching
   *  falls back to nearest-point-on-bbox proximity (faster query, slightly less precise). */
  geojson_geometry?: string;
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
}

/** A road segment matched to a candidate, with its minimum distance. */
export interface MatchedRoadSegment {
  segment: RoadSegmentForMatching;
  distance_m: number;
}

/** Result of resolving street names for a single candidate. */
export interface StreetNameResolution {
  id: string;
  streetNames: string[];
  resolvedLabel: string;
  resolvedDescription: string;
  /**
   * Every segment within the match radius, nearest first. Lets consumers
   * attribute per-segment Overture properties (posted speed limit, road
   * class) onto the candidate without re-running the proximity match.
   */
  matchedSegments: MatchedRoadSegment[];
}

export interface ResolveOptions {
  /** Match radius for junctions (metres). Default 15 — about one street's
   *  half-width including sidewalk. Tight enough that the next parallel
   *  arterial ~60 m away doesn't bleed into complex-intersection labels. */
  junctionRadiusM?: number;
  /** Match radius for crosswalks (metres). Default 15 — same reasoning as
   *  junctions; the crosswalk zone sits inside the intersection footprint. */
  crosswalkRadiusM?: number;
  /** Match radius for sidewalks (metres). Default 30 — sidewalks are long
   *  linear features parallel to a road; the candidate center sits at the
   *  segment midpoint which can be tens of metres along the road from any
   *  single point, so the radius needs to absorb that along-track offset. */
  sidewalkRadiusM?: number;
  /** Match radius for street parking (metres). Default 30. */
  parkingRadiusM?: number;
  /** Match radius for parking clusters (metres). Default 50. */
  clusterRadiusM?: number;
  /**
   * Match radius for standalone parking lots (metres). Default 25. Tighter
   * than parking clusters because lots are matched against polygon vertices,
   * so any road within this distance of the lot's edge is a plausible access
   * road — we don't want to pull in roads from adjacent blocks.
   */
  parkingLotRadiusM?: number;
  /**
   * Match radius for road-segment candidates (metres). Default 15. Tight
   * because the boundary ring is the buffered XODR reference line — any
   * Overture road within this distance of it is almost certainly the same
   * street.
   */
  roadSegmentRadiusM?: number;
}

// ── Geometry helpers ───────────────────────────────────────────────────────

/**
 * Minimum distance from a point to a line segment (both in WGS-84).
 *
 * Projects the point onto the segment (clamped to endpoints) and returns
 * the approximate distance in metres using flat-earth approximation.
 */
function pointToSegmentDistanceM(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  // Work in a local flat-earth frame (metres) centred on `a`.
  const cosLat = Math.cos(((aLat + bLat + pLat) / 3) * DEG2RAD);
  const ax = 0, ay = 0;
  const bx = (bLng - aLng) * M_PER_DEG_LAT * cosLat;
  const by = (bLat - aLat) * M_PER_DEG_LAT;
  const px = (pLng - aLng) * M_PER_DEG_LAT * cosLat;
  const py = (pLat - aLat) * M_PER_DEG_LAT;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // Degenerate segment (a == b): just return point-to-point distance.
    return Math.sqrt(px * px + py * py);
  }

  // Parameter t of the projection of p onto the line through a→b, clamped to [0,1].
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));

  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const ex = px - projX, ey = py - projY;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Parse a GeoJSON LineString geometry string into coordinate pairs. */
function parseLineStringCoords(geojsonGeometry: string): [number, number][] | null {
  try {
    const geom = JSON.parse(geojsonGeometry) as {
      type?: string;
      coordinates?: number[][];
    };
    if (geom.type !== "LineString" || !Array.isArray(geom.coordinates)) return null;
    return geom.coordinates as [number, number][];
  } catch {
    return null;
  }
}

// ── Matching ───────────────────────────────────────────────────────────────

function radiusForKind(kind: string, opts: ResolveOptions): number {
  switch (kind) {
    case "junction": return opts.junctionRadiusM ?? 15;
    case "crosswalk_zone": return opts.crosswalkRadiusM ?? 15;
    // Sidewalks are long linear features parallel to a road; the candidate
    // center sits at the segment midpoint, which can be tens of metres along
    // the road from any single point. 30 m matches street_parking, which has
    // the same "linear, road-adjacent" topology.
    case "sidewalk_segment": return opts.sidewalkRadiusM ?? 30;
    case "street_parking": return opts.parkingRadiusM ?? 30;
    case "parking_cluster": return opts.clusterRadiusM ?? 50;
    case "parking_lot": return opts.parkingLotRadiusM ?? 25;
    case "road_segment": return opts.roadSegmentRadiusM ?? 15;
    default: return opts.junctionRadiusM ?? 15;
  }
}

/** Matched street names with minimum distance per name. */
interface StreetNameMatch {
  /** Deduplicated names sorted alphabetically (for junctions, crosswalks). */
  alphabetical: string[];
  /** Deduplicated names sorted by nearest distance (for street parking). */
  byDistance: string[];
  /** Every matched segment, nearest first. */
  segments: MatchedRoadSegment[];
}

/**
 * Find named road segments within `radiusM` of any of the supplied query
 * points. A single-point call (just the centroid) matches the old behavior;
 * passing polygon boundary vertices in addition lets a large parking lot
 * pick up its access roads even when its centroid is far inside the lot.
 */
function matchStreetNames(
  queryPoints: { lat: number; lng: number }[],
  segments: RoadSegmentForMatching[],
  radiusM: number,
): StreetNameMatch {
  if (queryPoints.length === 0) {
    return { alphabetical: [], byDistance: [], segments: [] };
  }

  // Aggregate bbox of all query points so we can pre-reject road segments far
  // from the whole cluster in one cheap check.
  let qMinLat = Infinity, qMaxLat = -Infinity, qMinLng = Infinity, qMaxLng = -Infinity;
  for (const q of queryPoints) {
    if (q.lat < qMinLat) qMinLat = q.lat;
    if (q.lat > qMaxLat) qMaxLat = q.lat;
    if (q.lng < qMinLng) qMinLng = q.lng;
    if (q.lng > qMaxLng) qMaxLng = q.lng;
  }
  const centroidLat = (qMinLat + qMaxLat) / 2;
  const degThresholdLat = (radiusM / M_PER_DEG_LAT) * 1.5;
  const cosLat = Math.cos(centroidLat * DEG2RAD);
  const degThresholdLng = cosLat > 0.01
    ? (radiusM / (M_PER_DEG_LAT * cosLat)) * 1.5
    : 180;

  // Track minimum distance per unique name, plus every matched segment.
  const nameMinDist = new Map<string, number>();
  const matchedSegments: MatchedRoadSegment[] = [];

  for (const seg of segments) {
    // Fast bbox pre-filter against the query-point envelope.
    if (seg.max_lat + degThresholdLat < qMinLat) continue;
    if (seg.min_lat - degThresholdLat > qMaxLat) continue;
    if (seg.max_lng + degThresholdLng < qMinLng) continue;
    if (seg.min_lng - degThresholdLng > qMaxLng) continue;

    const coords = seg.geojson_geometry
      ? parseLineStringCoords(seg.geojson_geometry)
      : null;

    let minDistForSegment = Infinity;

    for (const q of queryPoints) {
      let minDist: number;
      if (coords && coords.length >= 2) {
        minDist = Infinity;
        for (let i = 0; i < coords.length - 1; i++) {
          const [aLng, aLat] = coords[i]!;
          const [bLng, bLat] = coords[i + 1]!;
          const dist = pointToSegmentDistanceM(
            q.lat, q.lng,
            aLat, aLng,
            bLat, bLng,
          );
          if (dist < minDist) minDist = dist;
        }
      } else {
        const clampedLat = Math.max(seg.min_lat, Math.min(seg.max_lat, q.lat));
        const clampedLng = Math.max(seg.min_lng, Math.min(seg.max_lng, q.lng));
        const cosAvg = Math.cos(((q.lat + clampedLat) / 2) * DEG2RAD);
        const dLat = (q.lat - clampedLat) * M_PER_DEG_LAT;
        const dLng = (q.lng - clampedLng) * M_PER_DEG_LAT * cosAvg;
        minDist = Math.sqrt(dLat * dLat + dLng * dLng);
      }
      if (minDist < minDistForSegment) minDistForSegment = minDist;
      if (minDistForSegment === 0) break;
    }

    if (minDistForSegment <= radiusM) {
      matchedSegments.push({ segment: seg, distance_m: minDistForSegment });
      const prev = nameMinDist.get(seg.name);
      if (prev === undefined || minDistForSegment < prev) {
        nameMinDist.set(seg.name, minDistForSegment);
      }
    }
  }

  const alphabetical = [...nameMinDist.keys()].sort();
  const byDistance = [...nameMinDist.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  matchedSegments.sort((a, b) => a.distance_m - b.distance_m);

  return { alphabetical, byDistance, segments: matchedSegments };
}

// ── Label formatting ───────────────────────────────────────────────────────

/** Extract parenthesised control info from an existing junction label. */
function extractControlInfo(label: string): string | null {
  const m = label.match(/\(([^)]+)\)/);
  return m ? m[1]! : null;
}

/** Extract length info like "(157m)" from a parking label. */
function extractLengthInfo(label: string): string | null {
  const m = label.match(/\((\d+m)\)/);
  return m ? m[1]! : null;
}

function formatJunctionLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  if (streetNames.length === 1) {
    const control = extractControlInfo(originalLabel);
    return control
      ? `${streetNames[0]} junction (${control})`
      : `${streetNames[0]} junction`;
  }
  return streetNames.join(" @ ");
}

function formatJunctionDescription(streetNames: string[], originalDesc?: string): string {
  if (streetNames.length === 0) return originalDesc ?? "";
  const control = originalDesc ? extractControlInfo(originalDesc) : null;
  const junction = streetNames.join(" @ ");
  return control
    ? `${control} junction at ${junction}`
    : `Junction at ${junction}`;
}

function formatSidewalkLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  if (streetNames.length === 1) return `Sidewalk on ${streetNames[0]}`;
  // A sidewalk near a corner can touch two roads; show up to two, primary
  // first (distance-ranked), mirroring the crosswalk multi-street pattern.
  return `Sidewalk at ${streetNames.slice(0, 2).join(" @ ")}`;
}

function formatCrosswalkLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  const isMidblock = originalLabel.toLowerCase().includes("midblock");
  const isSignalized = originalLabel.toLowerCase().includes("signalized");
  const suffix = isSignalized ? " (signalized)" : "";

  if (streetNames.length === 1) {
    return isMidblock
      ? `Midblock crosswalk on ${streetNames[0]}${suffix}`
      : `Crosswalk on ${streetNames[0]}${suffix}`;
  }
  const intersection = streetNames.join(" @ ");
  return `Crosswalk at ${intersection}${suffix}`;
}

function formatStreetParkingLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  const length = extractLengthInfo(originalLabel);
  const lengthSuffix = length ? ` (${length})` : "";
  return `Street parking on ${streetNames[0]}${lengthSuffix}`;
}

function formatParkingClusterLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  if (streetNames.length === 1) return `Parking near ${streetNames[0]}`;
  return `Parking near ${streetNames.join(" @ ")}`;
}

function formatParkingLotLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  if (streetNames.length === 1) return `Parking lot on ${streetNames[0]}`;
  // For multi-street access, surface up to two roads to keep the label short.
  const top = streetNames.slice(0, 2);
  return `Parking lot at ${top.join(" @ ")}`;
}

function formatParkingLotDescription(streetNames: string[], originalDesc?: string): string {
  if (streetNames.length === 0) return originalDesc ?? "";
  if (streetNames.length === 1) {
    return `Off-street parking lot with access from ${streetNames[0]}.`;
  }
  const top = streetNames.slice(0, 3);
  return `Off-street parking lot with access from ${top.join(", ")}.`;
}

/**
 * Road-segment label: just the street name(s). The Search UI renders subtype
 * separately ("Steep road", "Bike corridor", etc.) and lifts the grade / bike
 * tags into facts, so the label itself doesn't need to repeat any of that.
 */
function formatRoadSegmentLabel(streetNames: string[], originalLabel: string): string {
  if (streetNames.length === 0) return originalLabel;
  if (streetNames.length === 1) return streetNames[0]!;
  // A long segment can span an intersection and touch two roads — show up to
  // two, primary first (distance-ranked).
  const top = streetNames.slice(0, 2);
  return top.join(" @ ");
}

function formatLabel(kind: string, streetNames: string[], originalLabel: string): string {
  switch (kind) {
    case "junction": return formatJunctionLabel(streetNames, originalLabel);
    case "crosswalk_zone": return formatCrosswalkLabel(streetNames, originalLabel);
    case "sidewalk_segment": return formatSidewalkLabel(streetNames, originalLabel);
    case "street_parking": return formatStreetParkingLabel(streetNames, originalLabel);
    case "parking_cluster": return formatParkingClusterLabel(streetNames, originalLabel);
    case "parking_lot": return formatParkingLotLabel(streetNames, originalLabel);
    case "road_segment": return formatRoadSegmentLabel(streetNames, originalLabel);
    default: return formatJunctionLabel(streetNames, originalLabel);
  }
}

function formatDescription(kind: string, streetNames: string[], originalDesc?: string): string {
  if (streetNames.length === 0) return originalDesc ?? "";
  switch (kind) {
    case "junction": return formatJunctionDescription(streetNames, originalDesc);
    case "parking_lot": return formatParkingLotDescription(streetNames, originalDesc);
    // road_segment keeps the detector's original description unchanged —
    // it already includes the useful facts ("Shared bike lane — 140m.",
    // "12% grade — 180m.", etc.).
    default: return originalDesc ?? "";
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Candidate kinds that benefit from street name resolution. */
export const NAMEABLE_KINDS = [
  "junction",
  "crosswalk_zone",
  // Sidewalks are inherently street-attached — naming them after the road
  // they flank (e.g. "Main Street sidewalk") gives users a single intuitive
  // anchor in the search corpus instead of "Overture sidewalk segment".
  "sidewalk_segment",
  "street_parking",
  "parking_cluster",
  "parking_lot",
  "road_segment",
] as const;

/**
 * Resolve street names for a batch of candidate locations.
 *
 * For each candidate, finds nearby Overture road segments by point-to-polyline
 * proximity and formats a human-readable label per candidate kind.
 *
 * Returns only candidates where at least one street name was matched.
 */
export function resolveStreetNamesForCandidates(
  candidates: CandidateForNaming[],
  roadSegments: RoadSegmentForMatching[],
  options: ResolveOptions = {},
): StreetNameResolution[] {
  if (roadSegments.length === 0) return [];

  const results: StreetNameResolution[] = [];

  for (const c of candidates) {
    const radiusM = radiusForKind(c.kind, options);
    const queryPoints: { lat: number; lng: number }[] = [c.center];
    // Large lots anchor their match on boundary vertices too so we don't miss
    // the access road that only touches the lot's edge.
    if (c.boundary && c.boundary.length > 0) {
      for (const [lng, lat] of c.boundary) queryPoints.push({ lat, lng });
    }
    const match = matchStreetNames(queryPoints, roadSegments, radiusM);

    if (match.byDistance.length === 0) continue;

    // All kinds order names by distance ascending — complex intersections
    // keep every matched road (no cap) but the closest street leads the
    // label. Within-run ties are broken stably by the Map iteration order.
    const streetNames = match.byDistance;

    results.push({
      id: c.id,
      streetNames,
      resolvedLabel: formatLabel(c.kind, streetNames, c.label),
      resolvedDescription: formatDescription(c.kind, streetNames, c.description),
      matchedSegments: match.segments,
    });
  }

  return results;
}
