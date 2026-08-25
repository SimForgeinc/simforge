import type { MapEnrichmentFeatureCounts } from "../map-asset-enrichment";

/**
 * Derives scenario tags from Overture feature counts.
 * Pure function — shared between the Overture enrichment workflow and
 * any future metadata-population workflow that can supply feature counts.
 */
export function deriveEnrichmentTags(
  featureCounts: MapEnrichmentFeatureCounts,
): string[] {
  const tags: string[] = [];
  if ((featureCounts.bus_stops ?? 0) > 0) tags.push("TRANSIT_BUS_STOP");
  if ((featureCounts.schools ?? 0) > 0) tags.push("SCHOOL_ZONE_BOUNDARY");
  if ((featureCounts.hospitals ?? 0) > 0) tags.push("HOSPITAL_APPROACH");
  if ((featureCounts.gas_stations ?? 0) > 0) tags.push("GAS_STATION_APPROACH");
  if ((featureCounts.crosswalks ?? 0) > 0) tags.push("CROSSWALK_PRESENT");
  // Overture footway/sidewalk segments. The in-house road detector already
  // fires SIDEWALK_PEDESTRIAN_NETWORK when XODR road blocks carry sidewalk
  // lanes; surfacing it here on the Overture pathway means the tag still
  // fires on maps whose in-house sidewalk lane coverage is sparse.
  if ((featureCounts.sidewalks ?? 0) > 0) tags.push("SIDEWALK_PEDESTRIAN_NETWORK");
  // Commercial POIs (PR-138 follow-up). These tags surface in scenario-tag
  // queries (e.g. "show me maps with retail") and unlock kind-driven family
  // grouping in Scenario Insights.
  if ((featureCounts.retail ?? 0) > 0) tags.push("RETAIL_FRONTAGE");
  if ((featureCounts.restaurant ?? 0) > 0) tags.push("RESTAURANT_FRONTAGE");
  if ((featureCounts.hotel ?? 0) > 0) tags.push("HOTEL_APPROACH");
  if ((featureCounts.airport ?? 0) > 0) tags.push("AIRPORT_APPROACH");
  if ((featureCounts.shopping_mall ?? 0) > 0) tags.push("SHOPPING_MALL_APPROACH");
  if ((featureCounts.transit_stop ?? 0) > 0) tags.push("TRANSIT_STOP_CORRIDOR");
  return [...new Set(tags)].sort();
}
