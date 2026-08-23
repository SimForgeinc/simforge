/**
 * Road segment scene-graph builder.
 *
 * Parses XODR road blocks to extract per-road entities with lane types,
 * speed limits, grade, signal categories, and geographic center.
 */

import type { RoadSegmentEntity } from "../../map-intelligence";
import type { CoordTransform } from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { parseGeometrySegments, resolveSTtoXY, localToLonLat } from "../xodr-geometry";
import { bufferLineString } from "../buffer-line-string";
import { simplifyPolygon } from "../simplify-polygon";

export type BuildRoadSegmentsResult = {
  entities: RoadSegmentEntity[];
  warnings: string[];
};

export function buildRoadSegments(
  xodrText: string,
  coordTransform: CoordTransform,
): BuildRoadSegmentsResult {
  const warnings: string[] = [];
  if (!xodrText.trim()) {
    warnings.push("road-segment-builder: empty XODR text");
    return { entities: [], warnings };
  }

  const cleaned = stripXmlComments(xodrText);
  const entities: RoadSegmentEntity[] = [];

  // Split into road blocks
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  let idx = 0;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;

    const lengthM = Number(attr(roadAttrs, "length") ?? "0");
    if (!Number.isFinite(lengthM) || lengthM <= 0) continue;

    const juncAttr = attr(roadAttrs, "junction");
    const isJunctionInternal = !!juncAttr && juncAttr !== "-1";

    // Lane type counts
    const laneCountByType: Record<string, number> = {};
    const laneRe = /<lane\b[^>]*\btype="([^"]+)"/gi;
    let lm: RegExpExecArray | null;
    while ((lm = laneRe.exec(roadBody)) !== null) {
      const t = (lm[1] ?? "").toLowerCase();
      laneCountByType[t] = (laneCountByType[t] ?? 0) + 1;
    }

    const hasSidewalk = (laneCountByType["sidewalk"] ?? 0) > 0;
    const hasBikeLane = (laneCountByType["biking"] ?? 0) > 0;
    const hasParkingLane = (laneCountByType["parking"] ?? 0) > 0;

    // Speed limit (first match in this road block)
    let speedLimitMph: number | undefined;
    const speedRe = /<speed\b[^>]*\bmax="([-0-9.eE+]+)"[^>]*\bunit="mph"/i;
    const speedMatch = roadBody.match(speedRe);
    if (speedMatch?.[1]) {
      const v = Number(speedMatch[1]);
      if (Number.isFinite(v) && v > 0 && v < 500) speedLimitMph = Math.round(v);
    }

    // Grade (net grade per road from elevation polynomials)
    let gradePct: number | undefined;
    const elevEntries: { s: number; a: number; b: number; c: number; d: number }[] = [];
    const elevTagRe = /<elevation\b[^>]*>/gi;
    let em: RegExpExecArray | null;
    while ((em = elevTagRe.exec(roadBody)) !== null) {
      const tag = em[0];
      const s = Number(tag.match(/\bs="([-0-9.eE+]+)"/)?.[ 1] ?? NaN);
      const a = Number(tag.match(/\ba="([-0-9.eE+]+)"/)?.[ 1] ?? NaN);
      const b = Number(tag.match(/\bb="([-0-9.eE+]+)"/)?.[ 1] ?? NaN);
      const c = Number(tag.match(/\bc="([-0-9.eE+]+)"/)?.[ 1] ?? 0);
      const d = Number(tag.match(/\bd="([-0-9.eE+]+)"/)?.[ 1] ?? 0);
      if (Number.isFinite(s) && Number.isFinite(a) && Number.isFinite(b))
        elevEntries.push({ s, a, b, c, d });
    }
    if (elevEntries.length > 0) {
      elevEntries.sort((x, y) => x.s - y.s);
      const zStart = elevEntries[0]!.a;
      const last = elevEntries[elevEntries.length - 1]!;
      const ds = lengthM - last.s;
      const zEnd = last.a + last.b * ds + last.c * ds * ds + last.d * ds * ds * ds;
      const pct = (Math.abs(zEnd - zStart) / lengthM) * 100;
      if (pct > 0.1) gradePct = Math.round(pct * 10) / 10;
    }

    // Signal categories on this road
    const signalCategories: string[] = [];
    const sigCatSet = new Set<string>();
    const sigRe = /<signal\b[^>]*>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sigRe.exec(roadBody)) !== null) {
      const tag = sm[0];
      const sName = tag.match(/\bname="([^"]*)"/i)?.[1] ?? "";
      const category = classifySignalCategory(sName);
      if (!sigCatSet.has(category)) {
        sigCatSet.add(category);
        signalCategories.push(category);
      }
    }

    // Compute center from geometry midpoint and sample the reference line
    // along the full road to build a road-shaped Polygon region. This lets
    // search results highlight the actual road instead of a single point.
    const segments = parseGeometrySegments(roadBody);
    let center = { lat: coordTransform.originLat, lng: coordTransform.originLon };
    const centerline: [number, number][] = [];
    if (segments.length > 0) {
      const midS = lengthM / 2;
      const midXy = resolveSTtoXY(segments, midS, 0);
      if (midXy) {
        const [lon, lat] = localToLonLat(midXy, coordTransform);
        center = { lat, lng: lon };
      }
      // Sample at ~5 m strides (min 4, max 128 samples) for a smooth polyline
      // that's still cheap to buffer + simplify.
      const SAMPLE_STRIDE_M = 5;
      const sampleCount = Math.max(4, Math.min(128, Math.ceil(lengthM / SAMPLE_STRIDE_M) + 1));
      for (let i = 0; i < sampleCount; i++) {
        const s = (i / (sampleCount - 1)) * lengthM;
        const xy = resolveSTtoXY(segments, s, 0);
        if (!xy) continue;
        const [lon, lat] = localToLonLat(xy, coordTransform);
        centerline.push([lon, lat]);
      }
    }

    // Half-width scales with total lane count so a 6-lane arterial draws a
    // visibly wider ribbon than a 2-lane residential street, without needing
    // per-lane geometry. Bounded ≥4 m so even single-lane roads are legible.
    const totalLaneCount = Object.values(laneCountByType).reduce((a, b) => a + b, 0);
    const halfWidthM = Math.max(4, totalLaneCount * 1.8);

    let region: RoadSegmentEntity["region"];
    if (centerline.length >= 2) {
      const ring = simplifyPolygon(
        bufferLineString(centerline, halfWidthM, centerline[0]![1]),
        64,
      );
      region = { type: "Polygon", coordinates: [ring] };
    } else {
      region = { type: "Point", coordinates: [center.lng, center.lat] };
    }

    entities.push({
      entityId: `road_${idx}`,
      kind: "road_segment",
      center,
      region,
      provenance: {
        sourceFile: "xodr",
        sourceIds: [roadId],
        extractorVersion: "1.0.0",
      },
      roadId,
      lengthM: Math.round(lengthM),
      laneCountByType,
      speedLimitMph,
      gradePct,
      hasSidewalk,
      hasBikeLane,
      hasParkingLane,
      signalCategories,
      isJunctionInternal,
    });
    idx += 1;
  }

  return { entities, warnings };
}

/**
 * Lightweight signal classification from name attribute.
 * Simplified version of the full classifyAndEnrichSignal() in xodr-signals.ts.
 */
function classifySignalCategory(name: string): string {
  const n = name.toLowerCase();
  if (/signal_.*light|walk_light/i.test(n)) return "traffic_light";
  if (/stopline/i.test(n)) return "stop_line";
  if (/^sign_r1[_-]1/i.test(n) || /stop.*sign/i.test(n)) return "stop_sign";
  if (/^sign_r1[_-]2/i.test(n) || /yield/i.test(n)) return "yield_sign";
  if (/^sign_r2/i.test(n) || /speed.*limit/i.test(n)) return "speed_limit_sign";
  if (/bus.?stop/i.test(n)) return "bus_stop";
  if (/^sign_s/i.test(n) || /school/i.test(n)) return "school_sign";
  if (/^sign_w/i.test(n)) return "warning_sign";
  if (/^sign_/i.test(n)) return "regulatory_sign";
  return "unknown";
}
