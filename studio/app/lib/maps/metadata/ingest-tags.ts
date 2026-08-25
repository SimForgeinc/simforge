import type { MapStats } from "@simforge/studio-shared";
import { MAP_ASSET_DESCRIPTOR_TAG_IDS } from "@simforge/studio-shared";

const ALLOWED = new Set(MAP_ASSET_DESCRIPTOR_TAG_IDS);

/**
 * Deterministic descriptor tags from computed map stats (Step 4 of metadata plan).
 */
export function deriveIngestTagsFromMapStats(stats: MapStats): string[] {
  const out: string[] = [];
  const rn = stats.road_network;
  const sig = stats.signalization;
  const fi = stats.feature_inventory;

  const sidewalk = rn?.lane_counts?.sidewalk ?? fi?.lanes?.sidewalk_total ?? 0;
  const bike = rn?.lane_counts?.biking ?? fi?.lanes?.bike_total ?? 0;
  const parking = rn?.parking_space_count ?? fi?.parking_spaces ?? 0;
  const roadsBike = rn?.roads_with_bike_lanes ?? 0;
  const roadsSide = rn?.roads_with_sidewalks ?? 0;
  // INTERSECTION_SIGNALIZED uses rrdata signalization only (signal_controlled_object_count).
  // feature_inventory.junctions has no signal-controlled count — different ID space from xodr.
  const sigJ = sig?.signal_controlled_object_count ?? 0;
  const maxGrade = rn?.max_grade_pct ?? 0;
  const seg4 = rn?.segments_above_4pct_grade ?? 0;
  const crossTotal = rn?.crosswalk_count ?? fi?.crosswalks?.total ?? 0;
  const crossUnsig = fi?.crosswalks?.unsignalized ?? crossTotal;

  if (sidewalk >= 20 || roadsSide >= 10) push(out, "SIDEWALK_PEDESTRIAN_NETWORK");
  if (bike >= 20 || roadsBike >= 10) push(out, "BIKE_LANE_STANDARD");
  if (sigJ >= 1) push(out, "INTERSECTION_SIGNALIZED");
  if (parking >= 20) push(out, "NARROW_RESIDENTIAL_STREET_WITH_PARKING");
  if (parking >= 20) push(out, "PARKING_LOT_INTERNAL_CIRCULATION");
  if (seg4 >= 20 || maxGrade >= 6) push(out, "ROAD_GRADE_CREST_ELEVATION_CHANGE");
  if (crossTotal >= 1 && crossUnsig >= 1) push(out, "CROSSWALK_MARKED_UNSIGNALIZED");

  return [...new Set(out)];
}

function push(arr: string[], id: string) {
  if (ALLOWED.has(id)) arr.push(id);
}
