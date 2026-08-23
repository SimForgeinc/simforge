/**
 * CREST_OCCLUSION — hill crests where stopped traffic / VRUs sit just past
 * the apex.
 *
 * Sample each road's elevation polynomial at fixed strides, look for sign
 * changes in the first derivative (slope crossing zero from positive to
 * negative). Estimate the crest radius from the local second derivative
 * and proxy stopping-sight-distance with the parabolic-crest formula
 * SSD ≈ √(8·H·R) where H ≈ driver-eye height (1.08 m). When SSD is short
 * (< ~80 m) the crest is occlusion-prone enough to flag.
 *
 * Heuristic, not a real visibility analysis — matches the brief.
 */

import type { CandidateLocation } from "../../map-candidate-location";
import type { CoordTransform } from "../xodr-geometry";
import {
  parseGeometrySegments,
  parseElevationProfile,
  resolveSTtoXY,
  sampleElevation,
  localToLonLat,
} from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { distanceMeters, type LatLng } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";

const SAMPLE_STRIDE_M = 5;
const MIN_PEAK_DELTA_Z_M = 1.5; // ignore wiggles smaller than ~1.5 m
const SSD_LIMIT_M = 80; // crests with sight distance ≥ 80 m aren't flagged
const NEARBY_RADIUS_M = 80;
const DRIVER_EYE_HEIGHT_M = 1.08;

export type DetectCrestOcclusionInput = {
  mapAssetId: string;
  xodrText: string;
  coordTransform: CoordTransform;
  crosswalks: LatLng[];
  junctions: LatLng[];
};

type CrestCandidate = {
  roadId: string;
  s: number;
  /** Vertical curvature magnitude (1/m). Larger = sharper crest. */
  kV: number;
  /** Crest height above the surrounding minima (m). */
  deltaZ: number;
};

function findCrests(
  roadId: string,
  roadBody: string,
  lengthM: number,
): CrestCandidate[] {
  const profile = parseElevationProfile(roadBody);
  if (profile.length === 0) return [];

  const out: CrestCandidate[] = [];
  const sampleCount = Math.max(4, Math.ceil(lengthM / SAMPLE_STRIDE_M));
  const zs: number[] = [];
  const ss: number[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const s = (i / sampleCount) * lengthM;
    ss.push(s);
    zs.push(sampleElevation(profile, s));
  }
  if (zs.length < 5) return [];

  for (let i = 1; i < zs.length - 1; i++) {
    const prev = zs[i - 1]!;
    const curr = zs[i]!;
    const next = zs[i + 1]!;
    if (!(curr >= prev && curr >= next)) continue;
    if (curr === prev && curr === next) continue;

    // Walk left/right until z falls noticeably or the road ends; that gives
    // the crest's vertical "sticking out" amount used for the SSD proxy.
    let left = i;
    while (left > 0 && zs[left - 1]! <= zs[left]!) left--;
    let right = i;
    while (right < zs.length - 1 && zs[right + 1]! <= zs[right]!) right++;
    const deltaZ = curr - Math.min(zs[left]!, zs[right]!);
    if (deltaZ < MIN_PEAK_DELTA_Z_M) continue;

    // Local second derivative ≈ (z_{i-1} - 2·z_i + z_{i+1}) / h²
    const h = ss[i + 1]! - ss[i - 1]!;
    const stride = (h ?? SAMPLE_STRIDE_M * 2) / 2;
    const d2 = (prev - 2 * curr + next) / (stride * stride);
    const kV = Math.abs(d2);
    if (kV < 1e-5) continue;

    out.push({ roadId, s: ss[i]!, kV, deltaZ });
  }
  return out;
}

export function detectCrestOcclusion(
  input: DetectCrestOcclusionInput,
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
    const lengthM = Number(attr(roadAttrs, "length") ?? "0");
    if (!Number.isFinite(lengthM) || lengthM < 30) continue;
    const juncAttr = attr(roadAttrs, "junction");
    if (juncAttr && juncAttr !== "-1") continue;

    const segments = parseGeometrySegments(roadBody);
    if (segments.length === 0) continue;

    const crests = findCrests(roadId, roadBody, lengthM);
    for (const c of crests) {
      // SSD ≈ √(8·H·R) where R = 1/kV. Short SSD → occlusion candidate.
      const radius = 1 / c.kV;
      const ssd = Math.sqrt(8 * DRIVER_EYE_HEIGHT_M * radius);
      if (ssd >= SSD_LIMIT_M) continue;

      const xy = resolveSTtoXY(segments, c.s, 0);
      if (!xy) continue;
      const [lng, lat] = localToLonLat(xy, coordTransform);
      const center = { lat, lng };

      const nearestCrosswalk = nearestDistance(center, crosswalks);
      const nearestJunction = nearestDistance(center, junctions);
      const crosswalkNearby = nearestCrosswalk < NEARBY_RADIUS_M;
      const intersectionNearby = nearestJunction < NEARBY_RADIUS_M;

      // Tightness term: ssd/SSD_LIMIT_M inverted, so a very short SSD
      // (e.g. 30m) maps to ~0.6 and a borderline 78m crest maps to ~0.03.
      const tightness = 1 - ssd / SSD_LIMIT_M;
      const conflictScore =
        (crosswalkNearby ? 0.5 : 0) + (intersectionNearby ? 0.5 : 0);
      const heightScore = Math.min(1, c.deltaZ / 4);
      const confidence =
        0.45 + 0.2 * tightness + 0.15 * heightScore + 0.2 * conflictScore;

      out.push(
        makeOcclusionCandidate({
          mapAssetId,
          subtype: "CREST_OCCLUSION",
          clusterKey: `${roadId}_s${Math.round(c.s)}`,
          center,
          region: { type: "Point", coordinates: [lng, lat] },
          confidence,
          label: `Crest occlusion on road ${roadId}`,
          reason: `Hill crest on road ${roadId} with ~${Math.round(
            ssd,
          )}m sight-distance proxy (Δz ${c.deltaZ.toFixed(1)}m)`,
          primitives: {
            road_id: roadId,
            crest_s: Math.round(c.s),
            sight_distance_m: Math.round(ssd),
            elevation_delta_m: round2(c.deltaZ),
            vertical_curvature: round6(c.kV),
            distance_to_crosswalk_m: roundOrNeg(nearestCrosswalk),
            distance_to_intersection_m: roundOrNeg(nearestJunction),
          },
          supportingFeatures: {
            crestDetected: true,
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

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}

function roundOrNeg(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : -1;
}
