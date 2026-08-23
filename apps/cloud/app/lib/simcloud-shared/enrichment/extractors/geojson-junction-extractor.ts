import type { CandidateLocation } from "../../map-candidate-location";
import { simplifyPolygon } from "../simplify-polygon";

/**
 * Extract candidate locations for junctions from a RoadRunner GeoJSON export.
 *
 * RoadRunner GeoJSON contains `Type=Junction` features as MultiPolygon geometries
 * with exact junction boundary shapes, gate lists (for degree calculation), and
 * lane/phase references. This is far more accurate than reconstructing shapes
 * from XODR geometry points.
 *
 * Strategy:
 * 1. Walk GeoJSON features, collect all `Type=Junction` MultiPolygons
 * 2. Match with XODR junction data (if provided) by nearest centroid
 * 3. Use XODR road degree for complexity (> 4 roads = complex); fall back to
 *    gate count (>= 7) when XODR data is unavailable
 * 4. Include ALL signalized junctions as candidates regardless of complexity
 * 5. Use the GeoJSON polygon directly as the candidate region
 *
 * Browser-compatible — pure JSON parsing, no Node.js dependencies.
 */

/** Per-junction info from XODR, used for road-degree-based filtering. */
export type XodrJunctionMatchInfo = {
  xodrJunctionId: string;
  roadDegree: number;
  centroid: { lat: number; lng: number };
  hasTrafficLight: boolean;
  hasStopSign: boolean;
  allWayStop: boolean;
  /** XODR road ids feeding the junction (unique, in discovery order). Populated by extractors that track them; absent for legacy callers. */
  incomingRoadIds?: string[];
  /**
   * True when a signal controlling this junction is a protected left-turn
   * signal — identified by MUTCD code R10-6 (Left Turn Signal) or by a
   * signal name pattern indicating a left-arrow head. Undefined for legacy
   * extractors that don't compute this field.
   */
  hasProtectedLeftSignal?: boolean;
};

export function extractJunctionCandidates(
  geojsonText: string,
  xodrJunctionInfo?: XodrJunctionMatchInfo[],
): { locations: CandidateLocation[]; warnings: string[] } {
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(geojsonText) as unknown;
  } catch {
    warnings.push("geojson-junction: invalid GeoJSON, skipping junction extraction");
    return { locations: [], warnings };
  }

  type JunctionFeature = {
    id: string;
    gateCount: number;
    laneCount: number;
    hasPhases: boolean;
    coordinates: [number, number][][]; // outer ring(s), [lng, lat] pairs
    center: { lat: number; lng: number };
  };

  const junctions: JunctionFeature[] = [];

  function visitFeature(feature: Record<string, unknown>) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geom = feature.geometry as Record<string, unknown> | null | undefined;
    if (!geom) return;

    const type = String(props.Type ?? props.type ?? "");
    if (type !== "Junction") return;

    const geomType = String(geom.type ?? "");
    const rawCoords = geom.coordinates as unknown;

    if (geomType !== "MultiPolygon" && geomType !== "Polygon") return;

    // Extract gate count (approach degree)
    const gates = Array.isArray(props.Gates) ? props.Gates : [];
    const lanes = Array.isArray(props.Lanes) ? props.Lanes : [];
    const phases = Array.isArray(props.Phases) ? props.Phases : [];
    const junctionId = String(props.Id ?? "");

    // Flatten MultiPolygon → Polygon rings (take all outer rings)
    let rings: [number, number][][] = [];
    if (geomType === "MultiPolygon" && Array.isArray(rawCoords)) {
      // MultiPolygon: [ [ [ring], [hole], ... ], ... ]
      for (const polygon of rawCoords as unknown[][]) {
        if (Array.isArray(polygon) && polygon.length > 0) {
          const outerRing = polygon[0] as number[][];
          // Strip Z coordinate if present (RoadRunner exports [lng, lat, elev])
          const ring2d = outerRing.map((c: number[]) => [c[0]!, c[1]!] as [number, number]);
          rings.push(ring2d);
        }
      }
    } else if (geomType === "Polygon" && Array.isArray(rawCoords)) {
      const outerRing = (rawCoords as number[][][])[0];
      if (outerRing) {
        const ring2d = outerRing.map((c: number[]) => [c[0]!, c[1]!] as [number, number]);
        rings = [ring2d];
      }
    }

    if (rings.length === 0) return;

    // Compute centroid from all ring points
    let sumLng = 0, sumLat = 0, count = 0;
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        sumLng += lng;
        sumLat += lat;
        count += 1;
      }
    }
    const center = count > 0
      ? { lat: sumLat / count, lng: sumLng / count }
      : { lat: 0, lng: 0 };

    junctions.push({
      id: junctionId,
      gateCount: gates.length,
      laneCount: lanes.length,
      hasPhases: phases.length > 0,
      coordinates: rings,
      center,
    });
  }

  function walk(obj: unknown) {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type === "Feature") { visitFeature(o); return; }
    if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
      for (const f of o.features) walk(f);
    }
  }

  walk(root);

  // Build spatial index for XODR junction matching (if available)
  const xodrIndex = xodrJunctionInfo ?? [];

  // Match a GeoJSON junction centroid to the nearest XODR junction within tolerance.
  // Returns undefined if no match within 50m (~0.00045 degrees).
  const MATCH_TOLERANCE_DEG = 0.00045;
  function matchXodrJunction(center: { lat: number; lng: number }): XodrJunctionMatchInfo | undefined {
    if (xodrIndex.length === 0) return undefined;
    let best: XodrJunctionMatchInfo | undefined;
    let bestDist = Infinity;
    for (const xj of xodrIndex) {
      const dlat = xj.centroid.lat - center.lat;
      const dlng = xj.centroid.lng - center.lng;
      const dist = dlat * dlat + dlng * dlng;
      if (dist < bestDist) { bestDist = dist; best = xj; }
    }
    if (!best || bestDist > MATCH_TOLERANCE_DEG * MATCH_TOLERANCE_DEG) return undefined;
    return best;
  }

  // Determine which junctions qualify as candidates
  const rawLocations: CandidateLocation[] = [];
  let idx = 0;
  for (const junc of junctions) {
    const xodrMatch = matchXodrJunction(junc.center);

    // Determine control type from GeoJSON phases and XODR match
    const isSignalized = junc.hasPhases || (xodrMatch?.hasTrafficLight ?? false);
    const isAllWayStop = xodrMatch?.allWayStop ?? false;
    const isStopSignControlled = !isAllWayStop && (xodrMatch?.hasStopSign ?? false);

    // Determine if complex: use XODR road degree if matched, else fall back to gate count
    const isComplex = xodrMatch
      ? xodrMatch.roadDegree > 4
      : junc.gateCount >= 7; // legacy fallback

    // Include if signalized, stop-sign controlled, all-way stop, or complex
    if (!isSignalized && !isStopSignControlled && !isAllWayStop && !isComplex) continue;

    const tags: string[] = [];
    if (isSignalized) tags.push("INTERSECTION_SIGNALIZED");
    if (isAllWayStop) tags.push("INTERSECTION_ALLWAY_STOP");
    if (isStopSignControlled) tags.push("INTERSECTION_STOP_SIGN");
    const roadDegree = xodrMatch?.roadDegree ?? 0;
    if (isComplex || roadDegree >= 5) tags.push("INTERSECTION_COMPLEX_MULTI_LEG");

    // Use the actual junction polygon(s) from GeoJSON
    // For MultiPolygon with multiple polygons, take the largest ring
    const largestRing = junc.coordinates.reduce((best, ring) =>
      ring.length > best.length ? ring : best, junc.coordinates[0]!);

    // Simplify high-vertex polygons to keep storage/display lightweight
    const simplifiedRing = simplifyPolygon(largestRing, 32);

    const degreeLabel = xodrMatch
      ? `${xodrMatch.roadDegree}-road`
      : `${junc.gateCount}-gate`;

    // Build label: prefer most specific control type
    const controlLabel = isSignalized
      ? "signalized"
      : isAllWayStop
        ? "all-way stop"
        : isStopSignControlled
          ? "stop-sign controlled"
          : "complex";

    rawLocations.push({
      id: `_raw_junction_${idx}`,
      map_asset_id: "",
      kind: "junction",
      source: "geojson_junction",
      label: `Junction (${degreeLabel}, ${controlLabel})`,
      description: `${degreeLabel} ${controlLabel} junction with ${junc.laneCount} internal lanes`,
      reason: isSignalized
        ? `Signalized junction from ${xodrMatch ? "XODR signal analysis" : "RoadRunner GeoJSON phases"}`
        : isAllWayStop
          ? "All-way stop junction from XODR signal analysis"
          : isStopSignControlled
            ? "Stop-sign controlled junction from XODR signal analysis"
            : `Complex junction with ${degreeLabel} from ${xodrMatch ? "XODR road degree" : "RoadRunner GeoJSON"}`,
      confidence: 0.95, // High confidence — exact geometry from source
      tags,
      evidence: [{
        detectorId: "geojson_junction_extractor",
        detectorVersion: "1.0.0",
        primitives: {
          junction_id: junc.id,
          gate_count: junc.gateCount,
          lane_count: junc.laneCount,
          has_phases: junc.hasPhases,
          polygon_points: largestRing.length,
          ...(xodrMatch && {
            xodr_junction_id: xodrMatch.xodrJunctionId,
            xodr_road_degree: xodrMatch.roadDegree,
          }),
        },
        confidence: 0.95,
        matchedTags: tags,
        explanation: isSignalized
          ? `Signalized ${degreeLabel} junction`
          : isAllWayStop
            ? `All-way stop ${degreeLabel} junction`
            : isStopSignControlled
              ? `Stop-sign controlled ${degreeLabel} junction`
              : `Complex ${degreeLabel} junction`,
      }],
      region: { type: "Polygon", coordinates: [simplifiedRing] },
      center: junc.center,
    });
    idx += 1;
  }

  if (junctions.length > 0 && rawLocations.length === 0) {
    const threshold = xodrIndex.length > 0
      ? "no signalized, stop-sign controlled, or complex (> 4 roads) junctions found"
      : `${junctions.length} junctions found but none have >= 7 gates`;
    warnings.push(`geojson-junction: ${threshold}`);
  }

  return { locations: rawLocations, warnings };
}
