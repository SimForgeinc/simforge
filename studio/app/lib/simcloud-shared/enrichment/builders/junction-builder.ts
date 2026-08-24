/**
 * Junction scene-graph builder.
 *
 * Extracts ALL junction entities from a RoadRunner GeoJSON export, optionally
 * enriched with XODR junction data for signalization and road-degree info.
 *
 * Unlike the original extractJunctionCandidates(), this builder returns ALL
 * junctions (not just signalized/complex). Filtering is the detector's job.
 */

import type { JunctionEntity } from "../../map-intelligence";
import type { XodrJunctionMatchInfo } from "../extractors/geojson-junction-extractor";
import { simplifyPolygon } from "../simplify-polygon";

export type BuildJunctionsResult = {
  entities: JunctionEntity[];
  warnings: string[];
};

export function buildJunctions(
  geojsonText: string,
  xodrJunctionInfo?: XodrJunctionMatchInfo[],
): BuildJunctionsResult {
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(geojsonText) as unknown;
  } catch {
    warnings.push("junction-builder: invalid GeoJSON, skipping");
    return { entities: [], warnings };
  }

  type RawJunction = {
    id: string;
    gateCount: number;
    laneCount: number;
    hasPhases: boolean;
    coordinates: [number, number][][];
    center: { lat: number; lng: number };
    bbox: { minLng: number; maxLng: number; minLat: number; maxLat: number };
  };

  const junctions: RawJunction[] = [];
  /** Midpoints of Type=Gate LineString features whose TurnRelation denotes a left turn. */
  const leftTurnGatePoints: { lng: number; lat: number }[] = [];

  function visitFeature(feature: Record<string, unknown>) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geom = feature.geometry as Record<string, unknown> | null | undefined;
    if (!geom) return;

    const type = String(props.Type ?? props.type ?? "");
    const geomType = String(geom.type ?? "");
    const rawCoords = geom.coordinates as unknown;

    if (type === "Gate") {
      const turn = String(props.TurnRelation ?? "");
      // Treat U-turn-left the same as a left turn for detection purposes:
      // it crosses the same oncoming-traffic conflict as a regular left.
      if (turn !== "Left" && turn !== "UTurnLeft") return;
      if (geomType === "LineString" && Array.isArray(rawCoords) && rawCoords.length > 0) {
        const line = rawCoords as number[][];
        // Midpoint of the line — approximates the in-junction anchor for
        // this turn movement. The line shape itself isn't needed downstream.
        const mid = line[Math.floor(line.length / 2)];
        if (mid && typeof mid[0] === "number" && typeof mid[1] === "number") {
          leftTurnGatePoints.push({ lng: mid[0], lat: mid[1] });
        }
      } else if (geomType === "Point" && Array.isArray(rawCoords)) {
        const pt = rawCoords as number[];
        if (typeof pt[0] === "number" && typeof pt[1] === "number") {
          leftTurnGatePoints.push({ lng: pt[0], lat: pt[1] });
        }
      }
      return;
    }

    if (type !== "Junction") return;
    if (geomType !== "MultiPolygon" && geomType !== "Polygon") return;

    const gates = Array.isArray(props.Gates) ? props.Gates : [];
    const lanes = Array.isArray(props.Lanes) ? props.Lanes : [];
    const phases = Array.isArray(props.Phases) ? props.Phases : [];
    const junctionId = String(props.Id ?? "");

    let rings: [number, number][][] = [];
    if (geomType === "MultiPolygon" && Array.isArray(rawCoords)) {
      for (const polygon of rawCoords as unknown[][]) {
        if (Array.isArray(polygon) && polygon.length > 0) {
          const outerRing = polygon[0] as number[][];
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

    let sumLng = 0, sumLat = 0, count = 0;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        sumLng += lng;
        sumLat += lat;
        count += 1;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
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
      bbox: { minLng, maxLng, minLat, maxLat },
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

  // Assign each left-turn gate midpoint to the junction polygon that
  // contains it. O(n·m) but n and m are both bounded by the number of
  // junctions/gates in a single map — typically < 1000 combined.
  const leftTurnCounts = new Map<number, number>();
  for (const p of leftTurnGatePoints) {
    for (let ji = 0; ji < junctions.length; ji++) {
      const j = junctions[ji]!;
      if (p.lng < j.bbox.minLng || p.lng > j.bbox.maxLng) continue;
      if (p.lat < j.bbox.minLat || p.lat > j.bbox.maxLat) continue;
      if (pointInAnyRing(p.lng, p.lat, j.coordinates)) {
        leftTurnCounts.set(ji, (leftTurnCounts.get(ji) ?? 0) + 1);
        break;
      }
    }
  }

  const xodrIndex = xodrJunctionInfo ?? [];
  const MATCH_TOLERANCE_DEG = 0.00045;

  function matchXodr(center: { lat: number; lng: number }): XodrJunctionMatchInfo | undefined {
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

  const entities: JunctionEntity[] = [];
  for (let idx = 0; idx < junctions.length; idx++) {
    const junc = junctions[idx]!;
    const xodrMatch = matchXodr(junc.center);

    const isSignalized = junc.hasPhases || (xodrMatch?.hasTrafficLight ?? false);
    const isAllWayStop = xodrMatch?.allWayStop ?? false;
    const hasStopSign = !isAllWayStop && (xodrMatch?.hasStopSign ?? false);

    const approachCount = xodrMatch?.roadDegree ?? Math.max(2, Math.ceil(junc.gateCount / 2));

    const largestRing = junc.coordinates.reduce((best, ring) =>
      ring.length > best.length ? ring : best, junc.coordinates[0]!);
    const simplifiedRing = simplifyPolygon(largestRing, 32);

    entities.push({
      entityId: `junction_${idx}`,
      kind: "junction",
      center: junc.center,
      region: { type: "Polygon", coordinates: [simplifiedRing] },
      provenance: {
        sourceFile: "geojson",
        sourceIds: junc.id ? [junc.id] : [],
        extractorVersion: "1.0.0",
      },
      approachCount,
      gateCount: junc.gateCount,
      laneCount: junc.laneCount,
      hasPhases: junc.hasPhases,
      xodrJunctionId: xodrMatch?.xodrJunctionId,
      xodrRoadDegree: xodrMatch?.roadDegree,
      isSignalized,
      hasStopSign,
      isAllWayStop,
      leftTurnGateCount: leftTurnCounts.get(idx) ?? 0,
      hasProtectedLeftSignal: xodrMatch?.hasProtectedLeftSignal ?? false,
      polygon: simplifiedRing,
    });
  }

  return { entities, warnings };
}

/**
 * Point-in-polygon test against any ring of a MultiPolygon. Uses the standard
 * ray-casting algorithm in [lng, lat] space — adequate for the small extents
 * of junction polygons (tens of metres), where the Earth's curvature is
 * negligible.
 */
function pointInAnyRing(
  x: number,
  y: number,
  rings: [number, number][][],
): boolean {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      const intersect =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
