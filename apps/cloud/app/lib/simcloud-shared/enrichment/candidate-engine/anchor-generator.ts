/**
 * Anchor generator — groups detector results by anchor entity and produces
 * one CandidateLocation per unique anchor entity in the scene graph.
 */

import type {
  MapSceneGraph,
  DetectorResult,
  DetectorEvidence,
  JunctionEntity,
  RoadSegmentEntity,
  CrosswalkEntity,
  ParkingClusterEntity,
  SignalEntity,
} from "../../map-intelligence";
import type {
  CandidateLocation,
  CandidateLocationKind,
  CandidateLocationSource,
  CandidateLocationRegion,
} from "../../map-candidate-location";

// ── Entity lookup helper ──────────────────────────────────────────────────

type SceneEntity =
  | JunctionEntity
  | RoadSegmentEntity
  | CrosswalkEntity
  | ParkingClusterEntity
  | SignalEntity;

function findEntity(
  entityId: string,
  sceneGraph: MapSceneGraph,
): SceneEntity | undefined {
  return (
    sceneGraph.junctions.find((e) => e.entityId === entityId) ??
    sceneGraph.roadSegments.find((e) => e.entityId === entityId) ??
    sceneGraph.crosswalks.find((e) => e.entityId === entityId) ??
    sceneGraph.parkingClusters.find((e) => e.entityId === entityId) ??
    sceneGraph.signals.find((e) => e.entityId === entityId) ??
    sceneGraph.signs.find((e) => e.entityId === entityId)
  );
}

// ── Kind / source derivation ──────────────────────────────────────────────

function deriveKind(entity: SceneEntity): CandidateLocationKind {
  switch (entity.kind) {
    case "junction":
      return "junction";
    case "crosswalk":
      return "crosswalk_zone";
    case "parking_cluster": {
      const parking = entity as ParkingClusterEntity;
      if (parking.isStreetParking) return "street_parking";
      if (parking.isStandaloneLot) return "parking_lot";
      return "parking_cluster";
    }
    case "road_segment":
      return "road_segment";
    case "signal":
    case "sign":
      return "junction"; // fallback
  }
}

function deriveSource(entity: SceneEntity): CandidateLocationSource {
  switch (entity.kind) {
    case "junction":
      return "detector_intersection";
    case "crosswalk":
      return "detector_crosswalk";
    case "parking_cluster":
      return "detector_parking";
    case "road_segment":
      return "detector_road";
    case "signal":
    case "sign":
      return "detector_intersection"; // fallback
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

export function generateAnchors(
  results: DetectorResult[],
  sceneGraph: MapSceneGraph,
): CandidateLocation[] {
  // Group results by anchor entity ID
  const groups = new Map<string, DetectorResult[]>();
  for (const result of results) {
    const existing = groups.get(result.anchorEntityId);
    if (existing) {
      existing.push(result);
    } else {
      groups.set(result.anchorEntityId, [result]);
    }
  }

  const candidates: CandidateLocation[] = [];
  let idx = 0;

  for (const [anchorEntityId, groupResults] of groups) {
    const entity = findEntity(anchorEntityId, sceneGraph);
    if (!entity) continue;

    // Collect all evidence objects from this group
    const allEvidence: DetectorEvidence[] = groupResults.map((r) => r.evidence);

    // Find highest-confidence evidence for the label
    const bestEvidence = allEvidence.reduce((best, ev) =>
      ev.confidence > best.confidence ? ev : best,
    );

    // Max confidence across all evidences
    const confidence = Math.max(...allEvidence.map((ev) => ev.confidence));

    // Union of all matched tags
    const tagSet = new Set<string>();
    for (const ev of allEvidence) {
      for (const tag of ev.matchedTags) {
        tagSet.add(tag);
      }
    }
    const tags = [...tagSet];

    // Join all explanations for reason
    const reason = allEvidence.map((ev) => ev.explanation).join("; ");

    candidates.push({
      id: `_anchor_${idx}`,
      map_asset_id: "",
      kind: deriveKind(entity),
      source: deriveSource(entity),
      label: bestEvidence.explanation,
      reason,
      confidence,
      tags,
      evidence: allEvidence,
      region: entity.region as CandidateLocationRegion,
      center: entity.center,
      scenarioTags: tags,
      anchorEntityId,
    });

    idx++;
  }

  return candidates;
}
