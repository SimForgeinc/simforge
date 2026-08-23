import type { CandidateLocation } from "../../map-candidate-location";
import type { ParkingClusterEntity } from "../../map-intelligence";
import { buildParkingClusters } from "../builders/parking-builder";

/**
 * Extract street-parking candidate locations from a RoadRunner GeoJSON export.
 *
 * Thin adapter over `buildParkingClusters`, which is the single source of
 * truth for parking classification. It surfaces two flavors of street
 * parking as `isStreetParking` clusters:
 *
 *   • lane-backed — `Lane[LaneType=Parking]` centerlines, buffered and
 *     clustered by proximity; and
 *   • space-backed — `ParkingSpace` rows that line a driving lane (the
 *     "streets with parking close to the street" case), grouped per nearest
 *     driving lane so they never fuse across an intersection.
 *
 * This used to carry its own copy of the space-adjacency heuristic, which had
 * drifted from the builder (it ran lot-first and so misclassified contiguous
 * curb rows as lots). Folding that logic into `buildParkingClusters` keeps a
 * single definition; new callers should prefer
 * `buildParkingClusters` + `extractParkingCandidates` directly.
 *
 * Browser-compatible — pure JSON parsing + geometry math, no Node.js deps.
 */
export function extractStreetParkingCandidates(
  geojsonText: string,
): { locations: CandidateLocation[]; warnings: string[] } {
  const { entities, warnings } = buildParkingClusters(geojsonText);
  const locations = entities
    .filter((e) => e.isStreetParking)
    .map((e, i) => toStreetParkingCandidate(e, i));
  return { locations, warnings };
}

function toStreetParkingCandidate(
  cluster: ParkingClusterEntity,
  index: number,
): CandidateLocation {
  const laneBacked = cluster.parkingLaneIds.length > 0;
  const lengthM = cluster.totalLengthM;
  const lengthStr = lengthM > 0 ? ` (${lengthM}m)` : "";
  const spaceCount = cluster.spaceCount ?? cluster.parkingSpaceIds?.length ?? 0;
  const tags = laneBacked
    ? ["STREET_PARKING"]
    : ["STREET_PARKING", "NARROW_STREET_ADJACENT_PARKING"];
  const confidence = laneBacked ? 0.95 : 0.85;
  const reason = laneBacked
    ? `Lane with LaneType=Parking from RoadRunner GeoJSON`
    : `ParkingSpace polygons lining a Lane[LaneType=driving]`;
  const explanation = laneBacked
    ? `Street parking lane${lengthStr}`
    : `Street parking inferred from ${spaceCount} parking space${spaceCount === 1 ? "" : "s"} adjacent to a driving lane`;

  return {
    id: `_raw_street_parking_${index}`,
    map_asset_id: "",
    kind: "street_parking",
    source: "geojson_street_parking",
    label: `Street parking${lengthStr}`,
    description: laneBacked
      ? `Parking lane${lengthStr}`
      : `Parked-car row adjacent to a driving lane`,
    reason,
    confidence,
    tags,
    evidence: [
      {
        detectorId: "geojson_street_parking_extractor",
        detectorVersion: "2.0.0",
        primitives: {
          lane_backed: laneBacked,
          lane_count: cluster.parkingLaneIds.length,
          space_count: spaceCount,
          length_m: lengthM,
        },
        confidence,
        matchedTags: tags,
        explanation,
      },
    ],
    region: cluster.region,
    center: cluster.center,
  };
}
