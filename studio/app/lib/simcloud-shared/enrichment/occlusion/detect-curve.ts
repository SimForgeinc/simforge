/**
 * CURVE_OCCLUSION — sharp bends where a stopped actor / VRU is hidden by
 * the road's own geometry.
 *
 * Lightweight: scan parsed XODR <geometry> records, flag arc/spiral
 * sections whose magnitude of curvature ≥ ~0.02 (radius < 50 m, the same
 * "sharp" threshold the search-index curvature classifier uses), persist
 * for at least 15 m so a tiny junction transition arc doesn't trigger a
 * candidate. Score blends curvature magnitude with proximity to a
 * crosswalk or junction (since a sharp bend with a crosswalk just past
 * apex is the actual scenario-relevant case).
 */

import type { CandidateLocation } from "../../map-candidate-location";
import type { CoordTransform } from "../xodr-geometry";
import {
  parseGeometrySegments,
  resolveSTtoXY,
  localToLonLat,
} from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { distanceMeters, type LatLng } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";

const SHARP_CURVATURE = 0.02;
const MIN_LENGTH_M = 15;
const NEARBY_RADIUS_M = 80;

export type DetectCurveOcclusionInput = {
  mapAssetId: string;
  xodrText: string;
  coordTransform: CoordTransform;
  crosswalks: LatLng[];
  junctions: LatLng[];
};

type CurvedSection = {
  roadId: string;
  s: number;
  length: number;
  curvature: number;
};

/**
 * Walk a road body, return arc/spiral subranges that exceed the sharp
 * curvature threshold for ≥ MIN_LENGTH_M. Spirals are sliced at the
 * midpoint where their instantaneous curvature crosses the threshold.
 */
function findSharpSections(roadId: string, roadBody: string): CurvedSection[] {
  const segments = parseGeometrySegments(roadBody);
  const out: CurvedSection[] = [];
  for (const seg of segments) {
    if (seg.length < MIN_LENGTH_M) continue;
    if (seg.type === "arc") {
      const k = Math.abs(seg.curvature ?? 0);
      if (k >= SHARP_CURVATURE) {
        out.push({ roadId, s: seg.s, length: seg.length, curvature: k });
      }
    } else if (seg.type === "spiral") {
      const k0 = Math.abs(seg.curvStart ?? 0);
      const k1 = Math.abs(seg.curvEnd ?? 0);
      const peak = Math.max(k0, k1);
      if (peak >= SHARP_CURVATURE && seg.length >= MIN_LENGTH_M) {
        out.push({ roadId, s: seg.s, length: seg.length, curvature: peak });
      }
    }
  }
  return out;
}

export function detectCurveOcclusion(
  input: DetectCurveOcclusionInput,
): CandidateLocation[] {
  const { mapAssetId, xodrText, coordTransform, crosswalks, junctions } = input;
  if (!xodrText) return [];

  const cleaned = stripXmlComments(xodrText);
  const out: CandidateLocation[] = [];
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;
    const juncAttr = attr(roadAttrs, "junction");
    if (juncAttr && juncAttr !== "-1") continue; // skip junction-internal roads

    const segments = parseGeometrySegments(roadBody);
    if (segments.length === 0) continue;

    const sections = findSharpSections(roadId, roadBody);
    for (const sec of sections) {
      const midS = sec.s + sec.length / 2;
      const xy = resolveSTtoXY(segments, midS, 0);
      if (!xy) continue;
      const [lng, lat] = localToLonLat(xy, coordTransform);
      const center = { lat, lng };

      const nearestCrosswalk = nearestDistance(center, crosswalks);
      const nearestJunction = nearestDistance(center, junctions);
      const crosswalkNearby = nearestCrosswalk < NEARBY_RADIUS_M;
      const intersectionNearby = nearestJunction < NEARBY_RADIUS_M;

      const radiusM = sec.curvature > 0 ? 1 / sec.curvature : Infinity;
      // Curvature-magnitude term: 0 at threshold, 1 at radius ≤ 25m.
      const curvScore = Math.min(1, (sec.curvature - SHARP_CURVATURE) / 0.04);
      // Length term saturates at 60m so a 200m hairpin doesn't keep climbing.
      const lengthScore = Math.min(1, sec.length / 60);
      // Conflict-point boost: crosswalk/junction within 80m raises confidence.
      const conflictScore =
        (crosswalkNearby ? 0.5 : 0) + (intersectionNearby ? 0.5 : 0);
      const confidence =
        0.45 + 0.2 * curvScore + 0.15 * lengthScore + 0.2 * conflictScore;

      out.push(
        makeOcclusionCandidate({
          mapAssetId,
          subtype: "CURVE_OCCLUSION",
          clusterKey: `${roadId}_s${Math.round(sec.s)}`,
          center,
          region: { type: "Point", coordinates: [lng, lat] },
          confidence,
          label: `Curve occlusion on road ${roadId}`,
          reason: `Sharp bend (radius ${
            Number.isFinite(radiusM) ? `~${Math.round(radiusM)}m` : "tight"
          }) over ${Math.round(sec.length)}m of road ${roadId}`,
          primitives: {
            road_id: roadId,
            curvature: round4(sec.curvature),
            min_radius_m: Number.isFinite(radiusM) ? Math.round(radiusM) : 0,
            sharp_section_length_m: Math.round(sec.length),
            distance_to_crosswalk_m: roundOrNeg(nearestCrosswalk),
            distance_to_intersection_m: roundOrNeg(nearestJunction),
          },
          supportingFeatures: {
            highCurvature: true,
            crosswalkNearby,
            intersectionNearby,
          },
        }),
      );
    }
  }
  return out;
}

function nearestDistance(p: LatLng, points: LatLng[]): number {
  let best = Infinity;
  for (const q of points) {
    const d = distanceMeters(p, q);
    if (d < best) best = d;
  }
  return best;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function roundOrNeg(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : -1;
}
