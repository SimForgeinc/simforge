/**
 * Geometry-inspection tool for the AI Search collision flow.
 *
 * Background: when the user asks the AI Search panel to *build* a collision
 * scenario at a chosen map document, the LLM service needs more than the
 * search corpus alone gives it — facts and scenarioTags describe the place,
 * but not the road segments + lane structure the draft builder needs to
 * spawn actors on.
 *
 * This tool fills that gap with a single read: given a documentId, return
 * the document's classification facts plus a small projected slice of the
 * runtime road network around the document's center. The LLM passes the
 * report through to `propose_scenario_draft`; the builder consumes the
 * `availableLanes` list to anchor each actor by role.
 *
 * No new indexes or tables: it reuses the search corpus plus the accepted
 * semantic publication's exact execution-bound road network.
 */
import "server-only";
import {
  isPedestrianSpawnCandidate,
  type CandidateLocation,
  type MapAsset,
} from "@simcloud/shared";
import { readSemanticRoadSegmentsByMapAssetId } from "@/app/lib/maps/topology/server/semantic-road-network";
import { lngLatToRuntimePoint } from "@/app/lib/editor-map/coordinates";
import { getCandidateLocationsByMapAssetId } from "@/app/lib/db/map-candidate-location-store";
import { getAddressesByMapAssetId } from "@/app/lib/db/map-asset-address-store";
import type { MapSearchDocument } from "@/app/lib/maps/search/map-search-corpus";
import { loadMapSearchCorpus } from "@/app/lib/maps/search/server/map-search-service";

/** Hard ceiling on how many lane segments the tool returns. The model + the
 * builder both rank against the proximity-sorted prefix; surfacing more
 * doesn't pay for the prompt-tokens cost. */
const MAX_LANE_SAMPLES = 20;

/** Default search radius when the LLM doesn't specify one. Generous enough
 * to span a 4-leg intersection's approach roads at typical urban scale. */
const DEFAULT_RADIUS_M = 60;
const MAX_RADIUS_M = 250;

/**
 * Compact lane-segment record returned to the LLM. Mirrors the runtime
 * road-segment shape from `RuntimeMapResponse.road_segments` but trimmed
 * to the fields the draft builder needs (everything else is noise in the
 * tool response).
 */
export interface GeometryLaneSample {
  road_id: number;
  section_id: number;
  lane_id: number;
  /** `driving` | `sidewalk` | `bidirectional` | `parking` | `shoulder` | … */
  lane_type: string;
  is_junction: boolean;
  /** Yaw of the segment midpoint in radians; lets the builder reason about
   *  approach direction without re-projecting. */
  midpoint_yaw_rad: number;
  /** Runtime y-up local meters at the segment midpoint. */
  midpoint: { x: number; y: number };
  /** Distance in meters from the document's center to the segment midpoint. */
  distance_m_from_center: number;
  /** Approximate segment length along the centerline. */
  length_m: number;
}

export interface GeometryReport {
  documentId: string;
  documentFamily: MapSearchDocument["objectFamily"];
  documentSubtype: string;
  documentLabel: string;
  /** Map-document facts the LLM already saw in search, repeated here so the
   *  geometry response is self-contained for the draft builder. */
  facts: string[];
  /** Humanized scenarioTags from the document (e.g. "Signalized"). */
  scenarioTags: string[];
  /** Backend map name the draft will execute against. */
  backendMapName: string;
  /**
   * Whether the tool resolved a center point. Without one we can't filter
   * lanes by radius — the LLM should fall back to picking a different doc
   * or asking the user to choose a junction/street nearby.
   */
  centerResolved: boolean;
  /**
   * `documentCenter` is the projected runtime point if center was resolved.
   * Useful for the draft builder when no candidate-based lanes are nearby
   * (it still needs an x/y reference for placement_mode=point fallbacks).
   */
  documentCenter?: { x: number; y: number };
  /** Lanes within radius, sorted by proximity ascending. */
  availableLanes: GeometryLaneSample[];
  /** Convenience flags the LLM uses to pick a family. */
  placementHints: {
    hasDrivableSegments: boolean;
    hasSidewalkSegments: boolean;
    hasMultipleApproachRoads: boolean;
    hasOppositeDirectionLanes: boolean;
    hasAdjacentLanes: boolean;
  };
  /**
   * True when the chosen document is a pedestrian-spawn-eligible
   * location — crosswalks, sidewalks, transit stops, school / hospital /
   * commercial frontages, parking, "Pedestrian At …" occlusion
   * candidates, or any junction/street whose adjacency derivation set
   * `pedestrian_spawn: true` in the sidecar. Lifted from the document's
   * facts (`"pedestrian spawn"` badge emitted by both the sidecar build
   * and the legacy corpus build via `isPedestrianSpawnCandidate`). The
   * scenario builder consumes this directly — no client-side substring
   * matching.
   */
  pedestrianSpawn: boolean;
}

export class InspectGeometryUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InspectGeometryUnavailableError";
    this.code = code;
  }
}

// ── Implementation ──────────────────────────────────────────────────────────

function pickCandidateForDocument(
  doc: MapSearchDocument,
  candidates: CandidateLocation[],
): CandidateLocation | null {
  if (!doc.candidateId) return null;
  return candidates.find((c) => c.id === doc.candidateId) ?? null;
}

function midpointOfCenterline(
  centerline: ReadonlyArray<{ x: number; y: number; z: number; yaw: number; s: number }>,
): { x: number; y: number; yaw: number } | null {
  if (centerline.length === 0) return null;
  const midIdx = Math.floor(centerline.length / 2);
  const p = centerline[midIdx]!;
  // Runtime bundle yaw is in DEGREES (sourced from CARLA's
  // `Transform.Rotation.yaw`, see `_carla_to_frontend` in
  // services/carla-worker/carla_worker/metadata.py). Downstream
  // (`midpoint_yaw_rad`, lane-graph forward-direction detection, planner
  // dot-product alignment) all expects radians. Convert at this single
  // boundary so the rest of the pipeline can stay unit-safe.
  return { x: p.x, y: p.y, yaw: (p.yaw * Math.PI) / 180 };
}

function lengthOfCenterline(
  centerline: ReadonlyArray<{ s: number }>,
): number {
  if (centerline.length < 2) return 0;
  const first = centerline[0]!.s;
  const last = centerline[centerline.length - 1]!.s;
  return Math.max(0, Math.abs(last - first));
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute placement hints from a lane-sample list. Pre-computed server-side
 * so the LLM doesn't have to scan the array — keeps the prompt tight.
 */
function computePlacementHints(
  lanes: GeometryLaneSample[],
): GeometryReport["placementHints"] {
  const drivable = lanes.filter((l) => l.lane_type === "driving" || l.lane_type === "bidirectional");
  const sidewalks = lanes.filter((l) => l.lane_type === "sidewalk");

  const roadIds = new Set<number>();
  for (const l of drivable) roadIds.add(l.road_id);

  // Opposite-direction lanes on a single road are detected via opposing
  // lane_id signs (CARLA convention: positive lane_id = left of reference
  // direction, negative = right). Adjacent lanes share the same sign.
  const hasOppositeDirectionLanes = (() => {
    const byRoad = new Map<number, Set<number>>();
    for (const l of drivable) {
      if (!byRoad.has(l.road_id)) byRoad.set(l.road_id, new Set());
      byRoad.get(l.road_id)!.add(Math.sign(l.lane_id));
    }
    for (const signs of byRoad.values()) {
      if (signs.has(1) && signs.has(-1)) return true;
    }
    return false;
  })();

  const hasAdjacentLanes = (() => {
    const byRoadAndSign = new Map<string, number>();
    for (const l of drivable) {
      const key = `${l.road_id}:${Math.sign(l.lane_id)}`;
      byRoadAndSign.set(key, (byRoadAndSign.get(key) ?? 0) + 1);
    }
    for (const n of byRoadAndSign.values()) {
      if (n >= 2) return true;
    }
    return false;
  })();

  return {
    hasDrivableSegments: drivable.length > 0,
    hasSidewalkSegments: sidewalks.length > 0,
    hasMultipleApproachRoads: roadIds.size >= 2,
    hasOppositeDirectionLanes,
    hasAdjacentLanes,
  };
}

export interface InspectLocationGeometryArgs {
  /** Map asset row (used for coordinate ref + carla_map_name). */
  mapAsset: Pick<MapAsset, "map_asset_id" | "carla_map_name" | "map_coordinate_ref">;
  /** MapSearchDocument id the LLM picked. */
  documentId: string;
  /** Search radius in meters; clamped to [10, MAX_RADIUS_M]. */
  radius_m?: number;
}

/**
 * Resolve a geometry report for `documentId` against this map asset.
 *
 * Throws `InspectGeometryUnavailableError` for caller-actionable failures
 * (unknown document, map has no CARLA map, runtime bundle missing). The
 * service wrapper catches these and surfaces a tool-error to the LLM so
 * the model can apologize and pivot rather than crash the turn.
 */
export async function inspectLocationGeometry(
  args: InspectLocationGeometryArgs,
): Promise<GeometryReport> {
  const backendMapName = args.mapAsset.carla_map_name?.trim() ?? "";
  if (!backendMapName) {
    throw new InspectGeometryUnavailableError(
      "map_unavailable",
      "Map asset is not available in CARLA yet.",
    );
  }

  const radius_m = Math.min(
    MAX_RADIUS_M,
    Math.max(10, args.radius_m ?? DEFAULT_RADIUS_M),
  );

  const corpus = await loadMapSearchCorpus(args.mapAsset.map_asset_id);
  if (!corpus) {
    throw new InspectGeometryUnavailableError(
      "corpus_unavailable",
      "Map has no searchable corpus yet.",
    );
  }
  const doc = corpus.documents.find((d) => d.id === args.documentId);
  if (!doc) {
    throw new InspectGeometryUnavailableError(
      "unknown_document",
      `Unknown document id '${args.documentId}'.`,
    );
  }

  // Center resolution.
  //
  // Three paths:
  //   - Candidate-backed doc (most POIs, crosswalks, junctions, …):
  //     use the candidate's stored centroid.
  //   - Address-family doc (`addr_…`): use the address's `road_access_*`
  //     point when available — that's the closest point on a road to
  //     the address centroid, computed at enrichment time. Falls back
  //     to the address geometry itself if road_access is missing.
  //     Why: the raw address point often sits in the middle of a
  //     building, ~30–50m from any drivable lane. Using road_access
  //     anchors the scenario to the right curb, which is what the
  //     user means by "scenario at 600 Clipper Drive".
  //   - Road-network-only doc (junction/street without a candidate):
  //     v1 returns `centerResolved: false` — the LLM picks a different doc.
  let centerLngLat: { lng: number; lat: number } | null = null;
  let candidate: CandidateLocation | null = null;
  const addressFacts: string[] = [];
  if (doc.candidateId) {
    const candidates = await getCandidateLocationsByMapAssetId(
      args.mapAsset.map_asset_id,
    );
    candidate = pickCandidateForDocument(doc, candidates);
    if (candidate) {
      centerLngLat = { lng: candidate.center.lng, lat: candidate.center.lat };
    }
  } else if (doc.objectFamily === "address") {
    const addresses = await getAddressesByMapAssetId(args.mapAsset.map_asset_id);
    const addr = addresses.find((a) => a.id === doc.id);
    if (addr) {
      if (addr.road_access_lat != null && addr.road_access_lng != null) {
        centerLngLat = { lat: addr.road_access_lat, lng: addr.road_access_lng };
        if (addr.road_access_road_name) {
          const distanceLabel =
            addr.road_access_distance_m != null
              ? ` (${addr.road_access_distance_m.toFixed(0)}m)`
              : "";
          addressFacts.push(
            `access via ${addr.road_access_road_name}${distanceLabel}`,
          );
        }
      } else {
        // Address has no enriched road-access point — fall back to the
        // raw geometry. Scenario placement at this point may be off-road
        // (the LLM should treat the absence of an "access via …" fact
        // as a yellow flag).
        centerLngLat = { lat: addr.lat, lng: addr.lng };
      }
    }
  }

  // `pedestrianSpawn` — canonical signal that this location is a
  // pedestrian spawn point. Two sources, ORed for resilience:
  //   - The doc's humanized "pedestrian spawn" badge (emitted by both
  //     the sidecar build and the legacy corpus build). Present after
  //     the search-index sidecar is refreshed post the pedestrian-spawn
  //     canonical-signal commit.
  //   - The candidate itself via `isPedestrianSpawnCandidate(candidate)`.
  //     Catches the case where the sidecar predates the canonical
  //     signal (un-refreshed maps still light up correctly).
  const pedestrianSpawn =
    doc.exactMapAttributes.includes("pedestrian spawn") ||
    (candidate != null && isPedestrianSpawnCandidate(candidate));

  const baseReport: GeometryReport = {
    documentId: doc.id,
    documentFamily: doc.objectFamily,
    documentSubtype: doc.subtype,
    documentLabel: doc.label,
    facts: [...addressFacts, ...doc.exactMapAttributes].slice(0, 12),
    scenarioTags: doc.scenarioTags.slice(0, 12),
    backendMapName,
    centerResolved: false,
    availableLanes: [],
    placementHints: {
      hasDrivableSegments: false,
      hasSidewalkSegments: false,
      hasMultipleApproachRoads: false,
      hasOppositeDirectionLanes: false,
      hasAdjacentLanes: false,
    },
    pedestrianSpawn,
  };

  if (!centerLngLat) return baseReport;

  const runtimeCenter = lngLatToRuntimePoint(
    centerLngLat.lng,
    centerLngLat.lat,
    args.mapAsset,
  );
  if (!runtimeCenter) return baseReport;

  const segments =
    (await readSemanticRoadSegmentsByMapAssetId(args.mapAsset.map_asset_id)) ?? [];
  if (segments.length === 0) {
    return { ...baseReport, centerResolved: true, documentCenter: runtimeCenter };
  }

  // Compute proximity and project the centerline midpoint of every
  // candidate segment, then keep the closest `MAX_LANE_SAMPLES`.
  const ranked: GeometryLaneSample[] = [];
  for (const seg of segments) {
    const mid = midpointOfCenterline(seg.centerline);
    if (!mid) continue;
    const d = distance(runtimeCenter, mid);
    if (d > radius_m) continue;
    ranked.push({
      road_id: seg.road_id,
      section_id: seg.section_id,
      lane_id: seg.lane_id,
      lane_type: (seg.lane_type ?? "").toLowerCase() || "unknown",
      is_junction: seg.is_junction,
      midpoint_yaw_rad: mid.yaw,
      midpoint: { x: mid.x, y: mid.y },
      distance_m_from_center: Math.round(d * 10) / 10,
      length_m: Math.round(lengthOfCenterline(seg.centerline) * 10) / 10,
    });
  }
  ranked.sort((a, b) => a.distance_m_from_center - b.distance_m_from_center);
  const trimmed = ranked.slice(0, MAX_LANE_SAMPLES);

  return {
    ...baseReport,
    centerResolved: true,
    documentCenter: runtimeCenter,
    availableLanes: trimmed,
    placementHints: computePlacementHints(trimmed),
  };
}
