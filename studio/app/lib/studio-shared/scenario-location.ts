import { z } from "zod";

/** Bounding box (lat/lng). */
export const BboxSchema = z.object({
  min_lat: z.number(),
  min_lng: z.number(),
  max_lat: z.number(),
  max_lng: z.number(),
});
export type Bbox = z.infer<typeof BboxSchema>;

/** Region with a bounding box. */
export const RegionBboxSchema = z.object({
  type: z.literal("BBOX"),
  bbox: BboxSchema,
});
export type RegionBbox = z.infer<typeof RegionBboxSchema>;

/**
 * Scenario location (place/intent + region).
 * References a MapAsset by map_asset_id (resolved via MapAssetCatalog service).
 */
export const ScenarioLocationSchema = z.object({
  scenario_location_id: z.string(),
  map_asset_id: z.string(),
  display_name: z.string(),
  intent: z.string(),
  region: RegionBboxSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScenarioLocation = z.infer<typeof ScenarioLocationSchema>;
