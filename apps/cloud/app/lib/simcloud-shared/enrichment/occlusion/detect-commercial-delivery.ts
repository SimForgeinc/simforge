/**
 * COMMERCIAL_DELIVERY_OCCLUSION — commercial POIs (retail, restaurant)
 * fronting a narrow road are likely to host double-parked delivery
 * trucks that occlude approaching VRUs.
 *
 * Input is the Overture commercial POIs from the enrichment phase. We
 * boost confidence when the POI sits within ~25 m of a known crosswalk
 * or junction (delivery + crossing in the same scene = the failure
 * mode).
 */

import type { CandidateLocation } from "../../map-candidate-location";
import { distanceMeters, type LatLng } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";
import type { OcclusionPoi } from "./types";

const NEARBY_RADIUS_M = 25;

export type DetectCommercialDeliveryInput = {
  mapAssetId: string;
  commercialPois: OcclusionPoi[];
  crosswalks: LatLng[];
  junctions: LatLng[];
  /**
   * POIs whose centroid lies inside any of these "narrow road" centroids
   * (within `narrowRoadRadiusM`) inherit a higher confidence. Pass an
   * empty list when no XODR-derived narrow context is available.
   */
  narrowRoadCentroids?: LatLng[];
  narrowRoadRadiusM?: number;
};

const COMMERCIAL_TYPES = new Set(["retail", "restaurant"]);

export function detectCommercialDeliveryOcclusion(
  input: DetectCommercialDeliveryInput,
): CandidateLocation[] {
  const {
    mapAssetId,
    commercialPois,
    crosswalks,
    junctions,
    narrowRoadCentroids = [],
    narrowRoadRadiusM = 60,
  } = input;
  const out: CandidateLocation[] = [];

  for (let i = 0; i < commercialPois.length; i++) {
    const poi = commercialPois[i]!;
    if (!COMMERCIAL_TYPES.has(poi.type)) continue;

    const center = { lat: poi.lat, lng: poi.lng };
    const nearestCrosswalk = nearest(center, crosswalks);
    const nearestJunction = nearest(center, junctions);
    const crosswalkNearby = nearestCrosswalk < NEARBY_RADIUS_M;
    const intersectionNearby = nearestJunction < NEARBY_RADIUS_M;
    if (!crosswalkNearby && !intersectionNearby) continue;

    const onNarrowRoad =
      narrowRoadCentroids.length > 0 &&
      narrowRoadCentroids.some(
        (n) => distanceMeters(center, n) <= narrowRoadRadiusM,
      );

    const proximityScore =
      Math.max(0, 1 - Math.min(nearestCrosswalk, nearestJunction) / NEARBY_RADIUS_M) *
      0.4;
    const narrowBoost = onNarrowRoad ? 0.2 : 0;
    const confidence = 0.5 + proximityScore + narrowBoost;

    out.push(
      makeOcclusionCandidate({
        mapAssetId,
        subtype: "COMMERCIAL_DELIVERY_OCCLUSION",
        clusterKey: `poi_${i}_${Math.round(poi.lat * 1e5)}_${Math.round(poi.lng * 1e5)}`,
        center,
        region: { type: "Point", coordinates: [poi.lng, poi.lat] },
        confidence,
        label: poi.name
          ? `Delivery occlusion at ${poi.name}`
          : `Delivery occlusion at ${poi.type} POI`,
        reason: `${poi.type} POI within ${Math.round(
          Math.min(nearestCrosswalk, nearestJunction),
        )}m of a ${crosswalkNearby ? "crosswalk" : "junction"}${
          onNarrowRoad ? " on a narrow road" : ""
        }`,
        primitives: {
          poi_type: poi.type,
          poi_name: poi.name ?? "",
          distance_to_crosswalk_m: roundOrNeg(nearestCrosswalk),
          distance_to_intersection_m: roundOrNeg(nearestJunction),
          on_narrow_road: onNarrowRoad,
        },
        supportingFeatures: {
          commercialNearby: true,
          crosswalkNearby,
          intersectionNearby,
          narrowRoad: onNarrowRoad,
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
