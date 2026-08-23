import type { MapAsset } from "@simcloud/shared";

/**
 * SimScene CDN serving per-map satellite ortho tile pyramids (CloudFront in
 * front of the private prod-simscene-tiles bucket; CORS enabled). Tiles are
 * standard XYZ / Web-Mercator WebP. Missing tiles return 403 (not 404) under
 * OAC, which MapLibre treats the same as an empty tile.
 */
export const SIMSCENE_TILES_BASE_URL =
  process.env.NEXT_PUBLIC_SIMSCENE_TILES_BASE_URL ?? "https://dwcye2facbmg3.cloudfront.net";

/** Pyramids exist for z14-22 only (z22 ≈ 2.4 cm/px; native imagery ≈ z19-20). */
export const SATELLITE_MIN_ZOOM = 14;
export const SATELLITE_MAX_ZOOM = 22;

/** Prefix for the per-image-service raster source/layer ids in the MapLibre style. */
export const SATELLITE_SOURCE_ID = "simscene-satellite";

/** A single satellite raster layer derived from one SimScene image service. */
export type SatelliteImageryLayer = {
  /** Stable id (source + layer) used within the MapLibre style. */
  id: string;
  /** XYZ tile URL template ({z}/{x}/{y} placeholders). */
  tiles: string;
  /** [west, south, east, north] coverage bounds — stops MapLibre requesting tiles outside the pyramid. */
  bounds: [number, number, number, number];
};

/**
 * Satellite raster layers for a map asset, one per configured image service.
 * A map often needs several tilesets to cover its full extent, so the layers
 * are stacked (list order = bottom-to-top). Returns [] when the asset has no
 * imagery configured.
 */
export function satelliteImageryLayersForAsset(
  asset: Pick<MapAsset, "imagery_tilesets" | "bbox"> | null | undefined,
): SatelliteImageryLayer[] {
  const tilesets = asset?.imagery_tilesets;
  if (!tilesets || tilesets.length === 0) return [];
  const bounds: [number, number, number, number] = [
    asset.bbox.min_lng,
    asset.bbox.min_lat,
    asset.bbox.max_lng,
    asset.bbox.max_lat,
  ];
  return tilesets
    .filter((t) => t.tileset_id && t.layer_id)
    .map((t, index) => ({
      id: `${SATELLITE_SOURCE_ID}-${index}`,
      tiles: `${SIMSCENE_TILES_BASE_URL}/tilesets/${t.tileset_id}/${t.layer_id}/{z}/{x}/{y}.webp`,
      bounds,
    }));
}
