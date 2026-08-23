/**
 * PARKING_NEAR_CONFLICT_POINT — parked cars hide pedestrians/cyclists
 * when the parking run sits right next to a crosswalk or junction.
 *
 * Inputs come from the metadata phase scene graph: parking clusters
 * marked `isStreetParking`, plus crosswalk and junction centroids.
 * Score blends parked-car capacity (clusters with longer runs / more
 * spaces score higher) with proximity to the conflict point.
 */

import type { CandidateLocation } from "../../map-candidate-location";
import type {
  CrosswalkEntity,
  JunctionEntity,
  ParkingClusterEntity,
} from "../../map-intelligence";
import { distanceMeters } from "./geo";
import { makeOcclusionCandidate } from "./make-candidate";

const NEAR_CONFLICT_RADIUS_M = 30;

export type DetectParkingConflictInput = {
  mapAssetId: string;
  parkingClusters: ParkingClusterEntity[];
  crosswalks: CrosswalkEntity[];
  junctions: JunctionEntity[];
};

export function detectParkingNearConflict(
  input: DetectParkingConflictInput,
): CandidateLocation[] {
  const { mapAssetId, parkingClusters, crosswalks, junctions } = input;
  const out: CandidateLocation[] = [];

  for (const cluster of parkingClusters) {
    if (!cluster.isStreetParking) continue;

    let nearestCrosswalkM = Infinity;
    for (const cw of crosswalks) {
      const d = distanceMeters(cluster.center, cw.center);
      if (d < nearestCrosswalkM) nearestCrosswalkM = d;
    }
    let nearestJunctionM = Infinity;
    for (const j of junctions) {
      const d = distanceMeters(cluster.center, j.center);
      if (d < nearestJunctionM) nearestJunctionM = d;
    }
    const minConflict = Math.min(nearestCrosswalkM, nearestJunctionM);
    if (minConflict > NEAR_CONFLICT_RADIUS_M) continue;

    const crosswalkNearby = nearestCrosswalkM < NEAR_CONFLICT_RADIUS_M;
    const intersectionNearby = nearestJunctionM < NEAR_CONFLICT_RADIUS_M;

    // Capacity proxy: street-parking clusters carry totalLengthM. Treat ≥30m
    // as "enough cars to occlude". spaceCount, when populated, raises the
    // ceiling further.
    const lengthScore = Math.min(1, cluster.totalLengthM / 60);
    const spaceCount = cluster.spaceCount ?? 0;
    const spaceScore = Math.min(1, spaceCount / 8);
    const proximityScore = 1 - minConflict / NEAR_CONFLICT_RADIUS_M;
    const confidence =
      0.5 + 0.15 * lengthScore + 0.15 * spaceScore + 0.2 * proximityScore;

    out.push(
      makeOcclusionCandidate({
        mapAssetId,
        subtype: "PARKING_NEAR_CONFLICT_POINT",
        clusterKey: cluster.entityId,
        center: cluster.center,
        region: cluster.region,
        confidence,
        label: `Parked cars near ${
          crosswalkNearby ? "crosswalk" : "junction"
        }`,
        reason: `Street-parking run within ${Math.round(
          minConflict,
        )}m of a ${crosswalkNearby ? "crosswalk" : "junction"}`,
        primitives: {
          parking_cluster_id: cluster.entityId,
          parking_length_m: Math.round(cluster.totalLengthM),
          space_count: spaceCount,
          distance_to_crosswalk_m: roundOrNeg(nearestCrosswalkM),
          distance_to_intersection_m: roundOrNeg(nearestJunctionM),
        },
        supportingFeatures: {
          parkingNearby: true,
          crosswalkNearby,
          intersectionNearby,
        },
      }),
    );
  }
  return out;
}

function roundOrNeg(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : -1;
}
