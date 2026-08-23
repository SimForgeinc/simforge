/**
 * Build a CandidateLocation from a detector's structured output.
 *
 * Centralizes evidence/region/tag plumbing so each detector can stay
 * focused on its own heuristics rather than rebuilding the candidate
 * envelope every time.
 *
 * Occlusion candidates use the same column shape as every other kind in
 * `map_candidate_locations`: facts ride in `tags` and `evidence[].primitives`.
 * No top-level kind-specific field, no per-kind column. Subtype, severity,
 * supporting-feature flags, and the supported scenario-template list are all
 * encoded through that vocabulary so the search-index builder lifts them via
 * its generic primitives loop.
 */

import type {
  CandidateLocation,
  CandidateLocationEvidence,
  CandidateLocationRegion,
  CandidateLocationSource,
  OcclusionSubtype,
  OcclusionSupportingFeatures,
} from "../../map-candidate-location";
import { roundConfidence, severityFromConfidence } from "./score";

const DETECTOR_VERSION = "1.0.0";

const SUBTYPE_TO_SOURCE: Record<OcclusionSubtype, CandidateLocationSource> = {
  CURVE_OCCLUSION: "detector_occlusion_curve",
  CREST_OCCLUSION: "detector_occlusion_crest",
  PARKING_NEAR_CONFLICT_POINT: "detector_occlusion_parking_conflict",
  NARROW_BUILDING_CORRIDOR: "detector_occlusion_narrow_corridor",
  COMMERCIAL_DELIVERY_OCCLUSION: "detector_occlusion_commercial_delivery",
  BUS_STOP_OCCLUSION: "detector_occlusion_bus_stop",
};

const SUBTYPE_TO_DETECTOR_ID: Record<OcclusionSubtype, string> = {
  CURVE_OCCLUSION: "occlusion-curve-detector",
  CREST_OCCLUSION: "occlusion-crest-detector",
  PARKING_NEAR_CONFLICT_POINT: "occlusion-parking-conflict-detector",
  NARROW_BUILDING_CORRIDOR: "occlusion-narrow-corridor-detector",
  COMMERCIAL_DELIVERY_OCCLUSION: "occlusion-commercial-delivery-detector",
  BUS_STOP_OCCLUSION: "occlusion-bus-stop-detector",
};

const SUBTYPE_TO_DEFAULT_TAGS: Record<OcclusionSubtype, string[]> = {
  CURVE_OCCLUSION: ["OCCLUSION_CURVE", "OCCLUSION", "VRU_VISIBILITY"],
  CREST_OCCLUSION: ["OCCLUSION_CREST", "OCCLUSION", "STOPPED_TRAFFIC_AHEAD"],
  PARKING_NEAR_CONFLICT_POINT: [
    "OCCLUSION_PARKING_VRU",
    "OCCLUSION",
    "PEDESTRIAN_DARTOUT",
  ],
  NARROW_BUILDING_CORRIDOR: [
    "OCCLUSION_NARROW_CORRIDOR",
    "OCCLUSION",
    "TIGHT_SIGHTLINES",
  ],
  COMMERCIAL_DELIVERY_OCCLUSION: [
    "OCCLUSION_DELIVERY_TRUCK",
    "OCCLUSION",
    "BLOCKED_LANE",
  ],
  BUS_STOP_OCCLUSION: ["OCCLUSION_BUS", "OCCLUSION", "PEDESTRIAN_AT_BUS_STOP"],
};

const SUBTYPE_TO_TEMPLATES: Record<OcclusionSubtype, string[]> = {
  CURVE_OCCLUSION: [
    "occluded_pedestrian_around_curve",
    "stopped_vehicle_around_curve",
  ],
  CREST_OCCLUSION: ["stopped_traffic_over_crest", "pedestrian_over_crest"],
  PARKING_NEAR_CONFLICT_POINT: [
    "pedestrian_emerging_between_parked_cars",
    "child_dartout_from_parked_cars",
  ],
  NARROW_BUILDING_CORRIDOR: [
    "pedestrian_dartout_at_corner",
    "cyclist_emerging_from_alley",
  ],
  COMMERCIAL_DELIVERY_OCCLUSION: [
    "double_parked_delivery_truck",
    "pedestrian_emerging_around_truck",
  ],
  BUS_STOP_OCCLUSION: [
    "pedestrian_emerging_around_bus",
    "bus_blocking_crosswalk",
  ],
};

/**
 * Mapping from OcclusionSupportingFeatures keys to the snake_case primitive
 * names that the search-index builder reads as flat scalar facts. Keeping the
 * names stable here is the single source of truth — the build-search-index
 * decoder reads back from these same keys.
 */
const SUPPORTING_FEATURE_PRIMITIVE_KEYS: Record<
  keyof OcclusionSupportingFeatures,
  string
> = {
  crosswalkNearby: "crosswalk_nearby",
  intersectionNearby: "intersection_nearby",
  parkingNearby: "parking_nearby",
  busStopNearby: "bus_stop_nearby",
  commercialNearby: "commercial_nearby",
  narrowRoad: "narrow_road",
  highCurvature: "high_curvature",
  crestDetected: "crest_detected",
};

export type MakeOcclusionCandidateInput = {
  mapAssetId: string;
  subtype: OcclusionSubtype;
  /** Stable per-detector key used to derive the candidate id. */
  clusterKey: string;
  center: { lat: number; lng: number };
  region: CandidateLocationRegion;
  /** Pre-rounded 0–1 confidence; severity is bucketed from this. */
  confidence: number;
  /** Human-readable label (street-name resolver may overwrite later). */
  label: string;
  reason: string;
  /** Detector-specific numeric / boolean / string evidence. */
  primitives: Record<string, number | boolean | string>;
  supportingFeatures: OcclusionSupportingFeatures;
  /** Extra scenario-relevance tags appended to the subtype defaults. */
  extraTags?: string[];
};

export function makeOcclusionCandidate(
  input: MakeOcclusionCandidateInput,
): CandidateLocation {
  const {
    mapAssetId,
    subtype,
    clusterKey,
    center,
    region,
    label,
    reason,
    primitives,
    supportingFeatures,
    extraTags = [],
  } = input;

  const confidence = roundConfidence(input.confidence);
  const source = SUBTYPE_TO_SOURCE[subtype];
  const detectorId = SUBTYPE_TO_DETECTOR_ID[subtype];
  const defaults = SUBTYPE_TO_DEFAULT_TAGS[subtype];
  const templates = SUBTYPE_TO_TEMPLATES[subtype];
  const tags = Array.from(new Set([...defaults, ...extraTags]));

  // Flatten subtype + severity + supportingFeatures + templates into the
  // standard primitives Record so the row stores everything via the existing
  // tags + evidence columns. The search-index builder decodes these keys
  // back into structured facts.
  const flatPrimitives: Record<string, number | boolean | string> = {
    ...primitives,
    occlusion_subtype: subtype,
    severity: severityFromConfidence(confidence),
  };
  for (const [k, primitiveKey] of Object.entries(
    SUPPORTING_FEATURE_PRIMITIVE_KEYS,
  )) {
    const v = supportingFeatures[k as keyof OcclusionSupportingFeatures];
    if (v) flatPrimitives[primitiveKey] = true;
  }
  if (templates.length > 0) {
    flatPrimitives.supported_scenario_templates_json = JSON.stringify(templates);
  }

  const evidence: CandidateLocationEvidence = {
    detectorId,
    detectorVersion: DETECTOR_VERSION,
    primitives: flatPrimitives,
    confidence,
    matchedTags: tags,
    explanation: reason,
  };

  return {
    id: `_occlusion_${subtype.toLowerCase()}_${clusterKey}`,
    map_asset_id: mapAssetId,
    kind: "occlusion",
    source,
    label,
    reason,
    confidence,
    tags,
    evidence: [evidence],
    region,
    center,
    scenarioTags: tags,
  };
}

export const OCCLUSION_DETECTOR_VERSION = DETECTOR_VERSION;
