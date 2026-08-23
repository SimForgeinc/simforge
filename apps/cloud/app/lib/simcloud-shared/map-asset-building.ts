import { z } from "zod";

export const MapAssetBuildingSchema = z.object({
  id: z.string(),
  map_asset_id: z.string(),
  name: z.string().nullable(),
  class: z.string().nullable(),
  subtype: z.string().nullable(),
  centroid_lat: z.number(),
  centroid_lng: z.number(),
  height: z.number().nullable(),
  num_floors: z.number().nullable(),
  address_count: z.number(),
  /**
   * Formatted text of the in-building address closest to the centroid.
   * Null when no Overture address point falls inside the footprint.
   */
  primary_address: z.string().nullable(),
});

export type MapAssetBuilding = z.infer<typeof MapAssetBuildingSchema>;
