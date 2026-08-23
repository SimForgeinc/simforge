import { z } from "zod";

export const MapAssetAddressSchema = z.object({
  id: z.string(),
  map_asset_id: z.string(),
  building_id: z.string().nullable(),
  number: z.string().nullable(),
  street: z.string().nullable(),
  postcode: z.string().nullable(),
  formatted: z.string(),
  normalized: z.string(),
  lat: z.number(),
  lng: z.number(),
  /**
   * Closest point on a named drivable Overture road segment to (lat,lng).
   * Populated by the enrichment Lambda so callers can spawn a vehicle at a
   * legal start position when "go to 600 Main St" — the address point alone
   * sits on the lot or rooftop, which is not callable in simulation.
   * Null when no road segment lies within the search radius.
   */
  road_access_lat: z.number().nullable(),
  road_access_lng: z.number().nullable(),
  road_access_distance_m: z.number().nullable(),
  road_access_road_name: z.string().nullable(),
});

export type MapAssetAddress = z.infer<typeof MapAssetAddressSchema>;
