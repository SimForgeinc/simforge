import type { MapAssetAddress } from "@simforge/studio-shared";
import { queryRows } from "./data-api";

/**
 * Read all Overture-derived address rows for a map asset.
 *
 * Used by the search-index build to lift every persisted address into the
 * sidecar so natural-language queries like "200 Main St" resolve to a
 * known location, and so two-hop queries ("3-way junction near 200 Main
 * St") can use the address's centroid + frontage road as a spatial
 * anchor without scanning the overlay GeoJSON.
 *
 * Sorted by `building_id NULLS LAST, normalized` so addresses inside the
 * same building stay adjacent in iteration order — useful when the
 * downstream emitter wants to dedupe per-building (skip every-unit
 * apartment numbers) without an extra grouping pass.
 */
type Row = {
  id: string;
  map_asset_id: string;
  building_id: string | null;
  number: string | null;
  street: string | null;
  postcode: string | null;
  formatted: string;
  normalized: string;
  lat: number | string;
  lng: number | string;
  road_access_lat: number | string | null;
  road_access_lng: number | string | null;
  road_access_distance_m: number | string | null;
  road_access_road_name: string | null;
};

export async function getAddressesByMapAssetId(
  mapAssetId: string,
): Promise<MapAssetAddress[]> {
  const rows = await queryRows<Row>(
    `
      SELECT id, map_asset_id, building_id, number, street, postcode,
             formatted, normalized, lat, lng,
             road_access_lat, road_access_lng,
             road_access_distance_m, road_access_road_name
      FROM map_asset_addresses
      WHERE map_asset_id = :map_asset_id
      ORDER BY building_id NULLS LAST, normalized
    `,
    { map_asset_id: mapAssetId },
  );
  return (rows ?? []).map((r) => ({
    id: r.id,
    map_asset_id: r.map_asset_id,
    building_id: r.building_id,
    number: r.number,
    street: r.street,
    postcode: r.postcode,
    formatted: r.formatted,
    normalized: r.normalized,
    lat: Number(r.lat),
    lng: Number(r.lng),
    road_access_lat: r.road_access_lat == null ? null : Number(r.road_access_lat),
    road_access_lng: r.road_access_lng == null ? null : Number(r.road_access_lng),
    road_access_distance_m:
      r.road_access_distance_m == null ? null : Number(r.road_access_distance_m),
    road_access_road_name: r.road_access_road_name,
  }));
}
