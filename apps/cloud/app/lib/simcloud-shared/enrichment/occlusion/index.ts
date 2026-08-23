/**
 * Occlusion-likelihood candidate generation.
 *
 * Two phase-aligned entry points:
 *
 *   - `runMetadataPhaseOcclusion` runs after XODR + scene-graph build:
 *     CURVE_OCCLUSION, CREST_OCCLUSION, PARKING_NEAR_CONFLICT_POINT.
 *
 *   - `runEnrichmentPhaseOcclusion` runs after Overture queries:
 *     NARROW_BUILDING_CORRIDOR, COMMERCIAL_DELIVERY_OCCLUSION,
 *     BUS_STOP_OCCLUSION.
 *
 * Both return a flat `CandidateLocation[]` deduped within each subtype
 * (10 m radius). Callers group by `source` for delete-and-replace upserts
 * — same pattern as the existing detector pipelines.
 */

import type { CandidateLocation } from "../../map-candidate-location";
import { dedupeBySubtype } from "./cluster";
import { detectCurveOcclusion } from "./detect-curve";
import { detectCrestOcclusion } from "./detect-crest";
import { detectParkingNearConflict } from "./detect-parking-near-conflict";
import { detectNarrowBuildingCorridor } from "./detect-narrow-corridor";
import { detectCommercialDeliveryOcclusion } from "./detect-commercial-delivery";
import { detectBusStopOcclusion } from "./detect-bus-stop";
import type {
  OcclusionEnrichmentPhaseInput,
  OcclusionMetadataPhaseInput,
} from "./types";

const DEDUP_RADIUS_M = 10;

export function runMetadataPhaseOcclusion(
  input: OcclusionMetadataPhaseInput,
): CandidateLocation[] {
  const { mapAssetId, xodrText, coordTransform, sceneGraph } = input;
  const crosswalkCenters = sceneGraph.crosswalks.map((c) => c.center);
  const junctionCenters = sceneGraph.junctions.map((j) => j.center);

  const all: CandidateLocation[] = [
    ...detectCurveOcclusion({
      mapAssetId,
      xodrText,
      coordTransform,
      crosswalks: crosswalkCenters,
      junctions: junctionCenters,
    }),
    ...detectCrestOcclusion({
      mapAssetId,
      xodrText,
      coordTransform,
      crosswalks: crosswalkCenters,
      junctions: junctionCenters,
    }),
    ...detectParkingNearConflict({
      mapAssetId,
      parkingClusters: sceneGraph.parkingClusters,
      crosswalks: sceneGraph.crosswalks,
      junctions: sceneGraph.junctions,
    }),
  ];
  return dedupeBySubtype(all, DEDUP_RADIUS_M);
}

export function runEnrichmentPhaseOcclusion(
  input: OcclusionEnrichmentPhaseInput,
): CandidateLocation[] {
  const {
    mapAssetId,
    xodrText,
    coordTransform,
    buildings,
    busStops,
    commercialPois,
    crosswalks,
    junctions,
  } = input;

  const narrow = xodrText
    ? detectNarrowBuildingCorridor({
        mapAssetId,
        xodrText,
        coordTransform,
        buildings,
      })
    : [];

  // Reuse narrow-corridor centroids as a "narrow road" hint for the
  // commercial-delivery detector so a chain of small storefronts on a
  // 2-lane road scores higher than the same chain on an arterial.
  const narrowRoadCentroids = narrow.map((c) => c.center);

  const all: CandidateLocation[] = [
    ...narrow,
    ...detectCommercialDeliveryOcclusion({
      mapAssetId,
      commercialPois,
      crosswalks,
      junctions,
      narrowRoadCentroids,
    }),
    ...detectBusStopOcclusion({
      mapAssetId,
      busStops,
      crosswalks,
      junctions,
    }),
  ];
  return dedupeBySubtype(all, DEDUP_RADIUS_M);
}

export type {
  OcclusionMetadataPhaseInput,
  OcclusionEnrichmentPhaseInput,
  OcclusionBuilding,
  OcclusionPoi,
  LatLng as OcclusionLatLng,
} from "./types";
export { OCCLUSION_DETECTOR_VERSION } from "./make-candidate";
