/**
 * NARROW_BUILDING_CORRIDOR — buildings flank a narrow road on both sides
 * with little setback, choking sightlines.
 *
 * Walks each XODR road, identifies "narrow" segments (driving-lane count
 * ≤ 2), samples its reference line, and emits a candidate when at least
 * one building footprint sits within `MAX_SETBACK_M` of the centerline on
 * each side for ≥ MIN_NARROW_LENGTH_M of road.
 *
 * Uses XODR road geometry + Overture buildings; degrades gracefully when
 * either is missing (returns []).
 */

import type { CandidateLocation } from "../../map-candidate-location";
import type { CoordTransform } from "../xodr-geometry";
import {
  parseGeometrySegments,
  resolveSTtoXYWithHeading,
  localToLonLat,
} from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { distanceMeters } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";
import type { OcclusionBuilding } from "./types";

const MAX_SETBACK_M = 8;
const MIN_NARROW_LENGTH_M = 30;
const SAMPLE_STRIDE_M = 5;
const NARROW_LANE_COUNT_MAX = 2;

export type DetectNarrowCorridorInput = {
  mapAssetId: string;
  xodrText: string;
  coordTransform: CoordTransform;
  buildings: OcclusionBuilding[];
};

type RoadInfo = {
  roadId: string;
  /** [lat, lng, s] sample points along the centerline. */
  centerline: { lat: number; lng: number; s: number; heading: number }[];
  drivingLaneCount: number;
};

function summarizeRoads(
  cleaned: string,
  coordTransform: CoordTransform,
): RoadInfo[] {
  const roads: RoadInfo[] = [];
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;
    const lengthM = Number(attr(roadAttrs, "length") ?? "0");
    if (!Number.isFinite(lengthM) || lengthM < MIN_NARROW_LENGTH_M) continue;
    const juncAttr = attr(roadAttrs, "junction");
    if (juncAttr && juncAttr !== "-1") continue;

    let drivingLaneCount = 0;
    const laneRe = /<lane\b[^>]*\btype="([^"]+)"/gi;
    let lm: RegExpExecArray | null;
    while ((lm = laneRe.exec(roadBody)) !== null) {
      if ((lm[1] ?? "").toLowerCase() === "driving") drivingLaneCount += 1;
    }
    if (drivingLaneCount === 0 || drivingLaneCount > NARROW_LANE_COUNT_MAX) {
      continue;
    }

    const segments = parseGeometrySegments(roadBody);
    if (segments.length === 0) continue;

    const samples = Math.max(2, Math.ceil(lengthM / SAMPLE_STRIDE_M));
    const centerline: RoadInfo["centerline"] = [];
    for (let i = 0; i <= samples; i++) {
      const s = (i / samples) * lengthM;
      const r = resolveSTtoXYWithHeading(segments, s, 0);
      if (!r) continue;
      const [lng, lat] = localToLonLat(r.xy, coordTransform);
      centerline.push({ lat, lng, s, heading: r.heading });
    }
    if (centerline.length < 4) continue;

    roads.push({ roadId, centerline, drivingLaneCount });
  }
  return roads;
}

export function detectNarrowBuildingCorridor(
  input: DetectNarrowCorridorInput,
): CandidateLocation[] {
  const { mapAssetId, xodrText, coordTransform, buildings } = input;
  if (!xodrText || buildings.length === 0) return [];

  const cleaned = stripXmlComments(xodrText);
  const roads = summarizeRoads(cleaned, coordTransform);
  const out: CandidateLocation[] = [];

  for (const road of roads) {
    const flanked: { idx: number; left: number; right: number }[] = [];
    for (let i = 0; i < road.centerline.length; i++) {
      const sample = road.centerline[i]!;
      // Project each building onto local "left of heading" / "right of heading".
      let nearestLeft = Infinity;
      let nearestRight = Infinity;
      for (const b of buildings) {
        const d = distanceMeters({ lat: sample.lat, lng: sample.lng }, b);
        if (d > MAX_SETBACK_M + 30) continue; // coarse filter
        // Side test: bearing from sample to building, compared to road heading.
        const dx =
          (b.lng - sample.lng) *
          111_320 *
          Math.cos((sample.lat * Math.PI) / 180);
        const dy = (b.lat - sample.lat) * 111_320;
        const local = dx * Math.cos(-sample.heading) - dy * Math.sin(-sample.heading);
        const lateral =
          dx * Math.sin(-sample.heading) + dy * Math.cos(-sample.heading);
        // The y-axis in XODR local frame is "left of heading"; sample.heading
        // already aligns with the local +x. So `lateral` > 0 → left side.
        if (Math.abs(local) > MAX_SETBACK_M * 2) continue;
        const setback = Math.abs(lateral);
        if (setback > MAX_SETBACK_M) continue;
        if (lateral >= 0 && setback < nearestLeft) nearestLeft = setback;
        else if (lateral < 0 && setback < nearestRight) nearestRight = setback;
      }
      if (
        Number.isFinite(nearestLeft) &&
        Number.isFinite(nearestRight) &&
        nearestLeft <= MAX_SETBACK_M &&
        nearestRight <= MAX_SETBACK_M
      ) {
        flanked.push({ idx: i, left: nearestLeft, right: nearestRight });
      }
    }
    if (flanked.length === 0) continue;

    // Group consecutive flanked samples into runs; only emit when a run
    // covers MIN_NARROW_LENGTH_M end-to-end.
    let runStart = flanked[0]!.idx;
    let runEnd = runStart;
    let runLeftMin = flanked[0]!.left;
    let runRightMin = flanked[0]!.right;
    for (let k = 1; k <= flanked.length; k++) {
      const cur = flanked[k];
      const continues = cur && cur.idx === flanked[k - 1]!.idx + 1;
      if (continues) {
        runEnd = cur!.idx;
        runLeftMin = Math.min(runLeftMin, cur!.left);
        runRightMin = Math.min(runRightMin, cur!.right);
        continue;
      }
      const sStart = road.centerline[runStart]!.s;
      const sEnd = road.centerline[runEnd]!.s;
      const runLengthM = sEnd - sStart;
      if (runLengthM >= MIN_NARROW_LENGTH_M) {
        const midIdx = Math.round((runStart + runEnd) / 2);
        const mid = road.centerline[midIdx]!;
        const setback = Math.min(runLeftMin, runRightMin);
        const tightness = 1 - setback / MAX_SETBACK_M;
        const lengthScore = Math.min(1, runLengthM / 80);
        const confidence = 0.5 + 0.25 * tightness + 0.15 * lengthScore;
        out.push(
          makeOcclusionCandidate({
            mapAssetId,
            subtype: "NARROW_BUILDING_CORRIDOR",
            clusterKey: `${road.roadId}_s${Math.round(sStart)}-${Math.round(sEnd)}`,
            center: { lat: mid.lat, lng: mid.lng },
            region: { type: "Point", coordinates: [mid.lng, mid.lat] },
            confidence,
            label: `Narrow building corridor on road ${road.roadId}`,
            reason: `Road ${road.roadId} has buildings within ${MAX_SETBACK_M}m on both sides for ${Math.round(
              runLengthM,
            )}m`,
            primitives: {
              road_id: road.roadId,
              driving_lane_count: road.drivingLaneCount,
              corridor_length_m: Math.round(runLengthM),
              left_setback_m: round1(runLeftMin),
              right_setback_m: round1(runRightMin),
            },
            supportingFeatures: {
              narrowRoad: true,
            },
          }),
        );
      }
      if (cur) {
        runStart = cur.idx;
        runEnd = cur.idx;
        runLeftMin = cur.left;
        runRightMin = cur.right;
      }
    }
  }

  return out;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
