/**
 * Build per-scenario-family map layers from candidate locations.
 *
 * Mirrors the enrichment-overlay model (`MapOverlayLayer`): one toggleable
 * layer per scenario family, each carrying a GeoJSON FeatureCollection of all
 * that family's candidates. The Insights tab and these layers share the same
 * family grouping (`buildScenarioFamilyGroups`), so a family's candidate count
 * here matches what the Insights tab shows.
 *
 * Each feature embeds the full candidate payload as properties so a map click
 * routes through the standard feature-inspection path (property panel + copy
 * GeoJSON) exactly like any other map object. Object/array fields are
 * JSON-encoded because MapLibre only preserves scalar feature-property values
 * through `queryRenderedFeatures`.
 */

import type { CandidateLocation } from "@simforge/studio-shared";
import { buildScenarioFamilyGroups } from "@/app/lib/scenario-intelligence-ui";
import {
  candidateRegionToGeometry,
  type CandidateHighlightGeometry,
} from "./candidate-location-utils";

/** Property key marking a feature as a scenario-candidate (for click routing). */
export const SCENARIO_CANDIDATE_FEATURE_KIND = "scenario_candidate";

/** A single scenario-family layer: metadata + its candidates' GeoJSON. */
export interface ScenarioCandidateFamilyLayer {
  /** Scenario family id (e.g. "pedestrian", "intersections", "other"). */
  familyId: string;
  /** Human-readable family name shown in the panel (e.g. "Pedestrian Safety"). */
  label: string;
  /** Lucide icon name for the family (unused on the map; available for the panel). */
  iconName: string;
  /** Number of candidates in this family. */
  count: number;
  /** FeatureCollection of every candidate in the family, full payload embedded. */
  data: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: CandidateHighlightGeometry;
      properties: Record<string, unknown>;
    }>;
  };
}

/**
 * Flatten a candidate into inspectable feature properties — the FULL
 * `CandidateLocation` payload so copied GeoJSON can reconstruct the original.
 * Raw `tags` and `scenarioTags` are kept distinct (not merged), and object /
 * array fields are JSON-encoded so they survive MapLibre's scalar-only
 * property pipeline as a single, readable string. The only added keys are the
 * `feature_kind` marker (for click routing) and the derived `family`/
 * `family_id` convenience fields.
 */
function candidateProperties(
  candidate: CandidateLocation,
  familyId: string,
  familyLabel: string,
): Record<string, unknown> {
  return {
    feature_kind: SCENARIO_CANDIDATE_FEATURE_KIND,
    family: familyLabel,
    family_id: familyId,
    // Scalar CandidateLocation fields.
    id: candidate.id,
    map_asset_id: candidate.map_asset_id,
    kind: candidate.kind,
    source: candidate.source,
    label: candidate.label,
    reason: candidate.reason,
    confidence: candidate.confidence,
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.rank != null ? { rank: candidate.rank } : {}),
    ...(candidate.anchorEntityId ? { anchorEntityId: candidate.anchorEntityId } : {}),
    ...(candidate.explanation ? { explanation: candidate.explanation } : {}),
    ...(candidate.created_at ? { created_at: candidate.created_at } : {}),
    ...(candidate.updated_at ? { updated_at: candidate.updated_at } : {}),
    // Object / array fields, JSON-encoded. `tags` and `scenarioTags` stay
    // separate so raw vs scenario tags aren't conflated downstream.
    tags: JSON.stringify(candidate.tags),
    ...(candidate.scenarioTags ? { scenarioTags: JSON.stringify(candidate.scenarioTags) } : {}),
    evidence: JSON.stringify(candidate.evidence),
    region: JSON.stringify(candidate.region),
    center: JSON.stringify(candidate.center),
  };
}

/**
 * Group candidate locations by scenario family and build one map layer per
 * family that has candidates. Families with no candidates (and the "Other"
 * fallback when empty) are omitted, matching the Insights tab.
 */
export function buildScenarioCandidateFamilyLayers(
  candidateLocations: CandidateLocation[],
): ScenarioCandidateFamilyLayer[] {
  if (candidateLocations.length === 0) return [];

  // assetTags = [] — candidate grouping is driven entirely by the candidates
  // themselves; asset tags only add tag chips in the Insights view.
  const groups = buildScenarioFamilyGroups([], candidateLocations);

  return groups.map((group) => ({
    familyId: group.family.id,
    label: group.family.name,
    iconName: group.family.iconName,
    count: group.candidates.length,
    data: {
      type: "FeatureCollection" as const,
      features: group.candidates.map((candidate) => ({
        type: "Feature" as const,
        geometry: candidateRegionToGeometry(candidate),
        properties: candidateProperties(candidate, group.family.id, group.family.name),
      })),
    },
  }));
}
