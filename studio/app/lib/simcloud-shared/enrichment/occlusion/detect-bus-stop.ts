/**
 * BUS_STOP_OCCLUSION — a stopped bus blocks the curb-adjacent lane and
 * hides pedestrians/cyclists, especially when a crosswalk sits within a
 * stride or two of the stop pole.
 *
 * Input is the Overture bus-stop point list from the enrichment phase.
 * Confidence climbs with crosswalk proximity and falls when no
 * crosswalk is anywhere near (a bus stop with no crosswalk for 100 m
 * isn't the scenario we're after).
 */

import type { CandidateLocation } from "../../map-candidate-location";
import { distanceMeters, type LatLng } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";

const NEARBY_RADIUS_M = 25;

export type DetectBusStopInput = {
  mapAssetId: string;
  busStops: LatLng[];
  crosswalks: LatLng[];
  junctions: LatLng[];
};

export function detectBusStopOcclusion(
  input: DetectBusStopInput,
): CandidateLocation[] {
  const { mapAssetId, busStops, crosswalks, junctions } = input;
  const out: CandidateLocation[] = [];

  for (let i = 0; i < busStops.length; i++) {
    const stop = busStops[i]!;
    const nearestCrosswalk = nearest(stop, crosswalks);
    const nearestJunction = nearest(stop, junctions);
    const crosswalkNearby = nearestCrosswalk < NEARBY_RADIUS_M;
    const intersectionNearby = nearestJunction < NEARBY_RADIUS_M;
    if (!crosswalkNearby && !intersectionNearby) continue;

    const proximityScore = Math.max(
      0,
      1 - Math.min(nearestCrosswalk, nearestJunction) / NEARBY_RADIUS_M,
    );
    const confidence = 0.55 + 0.35 * proximityScore;

    out.push(
      makeOcclusionCandidate({
        mapAssetId,
        subtype: "BUS_STOP_OCCLUSION",
        clusterKey: `bus_${i}_${Math.round(stop.lat * 1e5)}_${Math.round(stop.lng * 1e5)}`,
        center: stop,
        region: { type: "Point", coordinates: [stop.lng, stop.lat] },
        confidence,
        label: "Bus stop occlusion",
        reason: `Bus stop within ${Math.round(
          Math.min(nearestCrosswalk, nearestJunction),
        )}m of a ${crosswalkNearby ? "crosswalk" : "junction"}`,
        primitives: {
          distance_to_crosswalk_m: roundOrNeg(nearestCrosswalk),
          distance_to_intersection_m: roundOrNeg(nearestJunction),
        },
        supportingFeatures: {
          busStopNearby: true,
          crosswalkNearby,
          intersectionNearby,
        },
      }),
    );
  }
  return out;
}

function nearest(p: LatLng, points: LatLng[]): number {
  let best = Infinity;
  for (const q of points) {
    const d = distanceMeters(p, q);
    if (d < best) best = d;
  }
  return best;
}

function roundOrNeg(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : -1;
}
