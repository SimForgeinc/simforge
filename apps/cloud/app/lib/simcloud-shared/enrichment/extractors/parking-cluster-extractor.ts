/**
 * Parking-cluster extractor — converts ParkingClusterEntity records (from
 * `buildParkingClusters`) into CandidateLocation rows for the
 * map_candidate_locations table.
 *
 * Used by the third-party-enrichment Lambda after it rebuilds parking
 * clusters with Overture polygons as the aggregator. Output is partitioned
 * across two sources:
 *
 *   • `detector_parking` — clusters with provenance.sourceFile === "geojson"
 *     (lane-backed street parking, or convex-hull aggregations of orphan
 *     ParkingSpace polygons that fall outside every Overture lot).
 *   • `overture_parking` — clusters with provenance.sourceFile === "overture"
 *     (lots keyed on an Overture parking polygon, with any in-house
 *     ParkingSpaces inside that polygon attached as members).
 *
 * Each cluster gets a content-stable `clusterKey` so the Lambda's deterministic
 * row-ID hashing produces the same row IDs across runs. Stable IDs matter
 * because the downstream search-index rebuild fingerprints candidate row IDs;
 * if they churn, the index gets needlessly invalidated on every run.
 */

import type { ParkingClusterEntity } from "../../map-intelligence";
import type {
  CandidateLocation,
  CandidateLocationKind,
  CandidateLocationSource,
} from "../../map-candidate-location";

export interface ExtractedParkingCandidate {
  location: CandidateLocation;
  /** Stable identity for the cluster — see file header. */
  clusterKey: string;
}

function deriveKind(cluster: ParkingClusterEntity): CandidateLocationKind {
  if (cluster.isStreetParking) return "street_parking";
  if (cluster.isStandaloneLot) return "parking_lot";
  return "parking_cluster";
}

function deriveSource(cluster: ParkingClusterEntity): CandidateLocationSource {
  return cluster.provenance.sourceFile === "overture"
    ? "overture_parking"
    : "detector_parking";
}

/**
 * Per-cluster stable identity used to hash the persisted row ID. Encodes
 * source + the IDs of the features that the cluster was built from, so two
 * runs that produce the same semantic cluster get the same key regardless
 * of cluster ordering or insertion order.
 *
 *   • Overture lot: key = "overture:<overtureLotId>"
 *   • Lane-backed:  key = "geojson:lane:<sorted_lane_ids>"
 *   • Convex-hull:  key = "geojson:spaces:<sorted_space_ids>"
 *
 * The fallback "geojson:entity:<entityId>" handles edge cases where neither
 * member set is populated (shouldn't occur, but keeps the contract total).
 */
function clusterIdentityKey(cluster: ParkingClusterEntity): string {
  if (cluster.provenance.sourceFile === "overture") {
    const overtureId = cluster.provenance.sourceIds[0] ?? cluster.entityId;
    return `overture:${overtureId}`;
  }
  if (cluster.parkingLaneIds.length > 0) {
    return `geojson:lane:${[...cluster.parkingLaneIds].sort().join(",")}`;
  }
  if (cluster.parkingSpaceIds && cluster.parkingSpaceIds.length > 0) {
    return `geojson:spaces:${[...cluster.parkingSpaceIds].sort().join(",")}`;
  }
  return `geojson:entity:${cluster.entityId}`;
}

function buildLabel(cluster: ParkingClusterEntity, kind: CandidateLocationKind): string {
  switch (kind) {
    case "street_parking":
      return "Street parking";
    case "parking_lot":
      return cluster.provenance.sourceFile === "overture"
        ? "Parking lot"
        : "Parking lot";
    default:
      return "Parking cluster";
  }
}

function buildReason(cluster: ParkingClusterEntity, kind: CandidateLocationKind): string {
  if (kind === "street_parking") {
    const len = cluster.totalLengthM > 0 ? ` (~${cluster.totalLengthM} m of curb)` : "";
    return `On-street curb parking${len}.`;
  }
  if (cluster.provenance.sourceFile === "overture") {
    const memberCount = cluster.spaceCount ?? 0;
    return memberCount > 0
      ? `Off-street parking lot from Overture, with ${memberCount} in-house ParkingSpace${memberCount === 1 ? "" : "s"} inside.`
      : "Off-street parking lot from Overture.";
  }
  return `Off-street parking lot aggregated from ${cluster.spaceCount ?? 0} in-house ParkingSpace polygons.`;
}

export function extractParkingCandidates(
  clusters: ParkingClusterEntity[],
  mapAssetId: string,
): ExtractedParkingCandidate[] {
  if (clusters.length === 0) return [];

  const out: ExtractedParkingCandidate[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;
    const kind = deriveKind(c);
    const source = deriveSource(c);
    const clusterKey = clusterIdentityKey(c);
    const label = buildLabel(c, kind);
    const reason = buildReason(c, kind);

    // Evidence references the underlying primitives. We intentionally include
    // both the source-feature IDs (which the downstream street-name resolver
    // can use for boundary matching) and the cluster's member-feature counts.
    const sourceIdSummary: Record<string, number | boolean | string> = {
      source_count: c.provenance.sourceIds.length,
      source_file: c.provenance.sourceFile,
    };
    if (c.parkingLaneIds.length > 0) sourceIdSummary["lane_count"] = c.parkingLaneIds.length;
    if (c.parkingSpaceIds && c.parkingSpaceIds.length > 0) {
      sourceIdSummary["space_count"] = c.parkingSpaceIds.length;
    }

    const location: CandidateLocation = {
      // Caller (Lambda) overwrites this with the deterministic hash; placeholder
      // here keeps the row valid for tests that use the bare extractor output.
      id: `_raw_parking_${i}`,
      map_asset_id: mapAssetId,
      kind,
      source,
      label,
      description: reason,
      reason,
      // Detector-derived clusters carry confidence 0.7 to mirror today's
      // detector_parking rows (anchor-generator uses the per-evidence
      // confidence; parking-detector uses 0.7 as the baseline).
      confidence: 0.7,
      tags: kind === "parking_lot" ? ["PARKING_LOT_APPROACH"] : kind === "street_parking" ? ["NARROW_RESIDENTIAL_STREET_WITH_PARKING"] : [],
      evidence: [
        {
          detectorId: "parking_cluster_extractor",
          detectorVersion: "1.0.0",
          primitives: sourceIdSummary,
          confidence: 0.7,
          matchedTags: kind === "parking_lot" ? ["PARKING_LOT_APPROACH"] : [],
          explanation: `${kind} cluster sourced from ${c.provenance.sourceFile}`,
        },
      ],
      region: c.region,
      center: c.center,
    };

    out.push({ location, clusterKey });
  }

  return out;
}
