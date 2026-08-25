/**
 * Crosswalk scene-graph builder.
 *
 * Extracts crosswalk entities from XODR <object type="crosswalk"> elements
 * and determines proximity to junction entities.
 *
 * Also matches the RoadRunner duplicate-export form where the duplicate
 * crosswalk loses `type="crosswalk"` and gets `type="-1"` while keeping a
 * "*Crosswalk*" name. This mirrors the regex used by xodr-signals.ts /
 * extractXodrRoadStats — what counts must be what extracts must be what
 * the scene-graph sees, otherwise the search index loses crosswalks the
 * map clearly has.
 */

import type { CrosswalkEntity, JunctionEntity } from "../../map-intelligence";
import type { CoordTransform } from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { parseGeometrySegments, resolveSTtoXYWithHeading, localToLonLat, type GeometrySegment } from "../xodr-geometry";

/** Crosswalks within this distance (degrees, ~30m) of a junction are "near junction". */
const NEAR_JUNCTION_DEG = 0.00027;

const CROSSWALK_TYPE_RE = /\btype="crosswalk"/;
const CROSSWALK_NAME_RE = /\bname="(?:[A-Z][a-z]*)?Crosswalk(?:\s*(?:\(\d+\)|\d+))?"/;
function isCrosswalkObjectTag(openTag: string): boolean {
  return CROSSWALK_TYPE_RE.test(openTag) || CROSSWALK_NAME_RE.test(openTag);
}

/** Parsed crosswalk object extracted from an XODR road block. */
type ParsedCrosswalk = {
  objectId: string;
  s: number;
  t: number;
  /** Object heading relative to road reference line (radians). */
  hdg: number;
  length: number;
  width: number;
  roadId: string;
};

export type BuildCrosswalksResult = {
  entities: CrosswalkEntity[];
  warnings: string[];
};

export function buildCrosswalks(
  xodrText: string,
  coordTransform: CoordTransform,
  junctions: JunctionEntity[],
): BuildCrosswalksResult {
  const warnings: string[] = [];
  if (!xodrText.trim()) {
    warnings.push("crosswalk-builder: empty XODR text");
    return { entities: [], warnings };
  }

  const cleaned = stripXmlComments(xodrText);

  // Single pass: scan each road block, parse geometry AND extract crosswalk objects.
  const roadGeometries = new Map<string, GeometrySegment[]>();
  const crosswalks: ParsedCrosswalk[] = [];
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;

    const segments = parseGeometrySegments(roadBody);
    if (segments.length > 0) roadGeometries.set(roadId, segments);

    // Find crosswalk objects within this road body. We accept both the
    // OpenDRIVE-spec form (type="crosswalk") and the RoadRunner duplicate-
    // export form (type="-1" + Crosswalk-named). The whole opening tag is
    // matched against the regex pair so we don't hand-parse attribute order.
    const objectRe = /<object\b([^>]*)(?:\/>|>([\s\S]*?)<\/object>)/gi;
    let om: RegExpExecArray | null;
    while ((om = objectRe.exec(roadBody)) !== null) {
      const openTag = om[0]!;
      if (!isCrosswalkObjectTag(openTag)) continue;
      const objAttrs = om[1] ?? "";
      // Skip zero-extent crosswalks (length=0 or width=0) so the candidate
      // engine doesn't anchor on degenerate geometry.
      const length = Number(attr(objAttrs, "length") ?? "3");
      const width = Number(attr(objAttrs, "width") ?? "3");
      if (!(length > 0) || !(width > 0)) continue;
      crosswalks.push({
        objectId: attr(objAttrs, "id") ?? `crosswalk_${crosswalks.length}`,
        s: Number(attr(objAttrs, "s") ?? "0"),
        t: Number(attr(objAttrs, "t") ?? "0"),
        hdg: Number(attr(objAttrs, "hdg") ?? "0"),
        length,
        width,
        roadId,
      });
    }
  }

  // Build entities from parsed crosswalks
  const entities: CrosswalkEntity[] = [];

  for (let idx = 0; idx < crosswalks.length; idx++) {
    const cw = crosswalks[idx]!;

    let center = { lat: coordTransform.originLat, lng: coordTransform.originLon };
    let roadHeading: number | undefined;
    let foundRoad = false;

    const segments = roadGeometries.get(cw.roadId);
    if (segments && segments.length > 0) {
      const result = resolveSTtoXYWithHeading(segments, cw.s, cw.t);
      if (result) {
        const [lon, lat] = localToLonLat(result.xy, coordTransform);
        center = { lat, lng: lon };
        roadHeading = result.heading;
        foundRoad = true;
      }
    }

    if (!foundRoad) {
      warnings.push(`crosswalk-builder: no road geometry for crosswalk ${cw.objectId} on road ${cw.roadId}`);
    }

    // Determine nearest junction
    let isNearJunction = false;
    let nearestJunctionEntityId: string | undefined;
    let nearestDist = Infinity;
    for (const junc of junctions) {
      const dlat = junc.center.lat - center.lat;
      const dlng = junc.center.lng - center.lng;
      const dist = dlat * dlat + dlng * dlng;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestJunctionEntityId = junc.entityId;
      }
    }
    if (nearestDist < NEAR_JUNCTION_DEG * NEAR_JUNCTION_DEG) {
      isNearJunction = true;
    } else {
      nearestJunctionEntityId = undefined;
    }

    // Total heading = road direction + object's own rotation relative to road.
    // Most crosswalks have hdg ≈ 0 or π/2 to cross the road perpendicularly.
    const totalHeading = roadHeading != null ? roadHeading + cw.hdg : undefined;
    const region = buildCrosswalkRegion(center, cw.length, cw.width, totalHeading);

    entities.push({
      entityId: `crosswalk_${idx}`,
      kind: "crosswalk",
      center,
      region,
      provenance: {
        sourceFile: "xodr",
        sourceIds: [cw.objectId],
        extractorVersion: "1.0.0",
      },
      xodrObjectId: cw.objectId,
      isNearJunction,
      nearestJunctionEntityId,
    });
  }

  return { entities, warnings };
}

/**
 * Build an oriented polygon for a crosswalk using the road heading.
 * Falls back to an axis-aligned BBOX if heading is unavailable.
 */
function buildCrosswalkRegion(
  center: { lat: number; lng: number },
  length: number,
  width: number,
  heading?: number,
): CrosswalkEntity["region"] {
  const DEG2RAD = Math.PI / 180;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(center.lat * DEG2RAD);

  if (heading == null) {
    // Fallback: axis-aligned BBOX
    const halfLenDeg = (length / 2) / mPerDegLat;
    const halfWidDeg = (width / 2) / mPerDegLng;
    return {
      type: "BBOX",
      bbox: {
        min_lat: center.lat - halfLenDeg,
        min_lng: center.lng - halfWidDeg,
        max_lat: center.lat + halfLenDeg,
        max_lng: center.lng + halfWidDeg,
      },
    };
  }

  // Crosswalks span perpendicular to the road. In XODR convention,
  // "length" is along the s-axis (road direction) and "width" is
  // perpendicular. Build 4 corners rotated by the road heading.
  const halfLen = length / 2;
  const halfWid = width / 2;
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  // Corner offsets in local meters: [along-road, perpendicular]
  const corners: [number, number][] = [
    [-halfLen, -halfWid],
    [halfLen, -halfWid],
    [halfLen, halfWid],
    [-halfLen, halfWid],
  ];

  const ring: [number, number][] = corners.map(([along, perp]) => {
    // Rotate by road heading (XODR heading is from x-axis, CCW)
    const dx = along * cosH - perp * sinH;
    const dy = along * sinH + perp * cosH;
    // Convert meters to degrees
    const lng = center.lng + dx / mPerDegLng;
    const lat = center.lat + dy / mPerDegLat;
    return [lng, lat];
  });
  // Close the ring
  ring.push(ring[0]!);

  return { type: "Polygon", coordinates: [ring] };
}
