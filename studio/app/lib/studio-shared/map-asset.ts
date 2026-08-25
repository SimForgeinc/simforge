import { z } from "zod";
import { BboxSchema } from "./scenario-location";
import { MapEnrichmentSummarySchema } from "./map-asset-enrichment";
import {
  MapCoordinateRefSchema,
  MapPlaceContextSchema,
  MapSourceSchema,
  MapStatsSchema,
} from "./map-asset-metadata";

/**
 * Artifact type enum.
 * - geojson: standard GeoJSON artifact, visualizable in a variety of tools
 * - xodr: OpenDRIVE format for loading the map into CARLA simulator
 * - rrdata_xml: Road Runner metadata when the map asset is generated via Road Runner
 * - fbx: texture file for the map asset generated via Road Runner
 * - mp4: fly-by video of the 3D map asset for visual reference in simulation planning
 * - mp4_preview: auto-generated low-res, short, muted downsample of an `mp4` fly-by video.
 *   Produced out-of-band by the map-flyby-preview Lambda on upload and used as the catalog
 *   card preview. Managed by that Lambda, not the web edit flow.
 * - image: thumbnail/screenshot of the 3D map asset (jpg, png, webp)
 * - thumbnail: auto-generated map preview image captured from the dark basemap + feature layers
 * - runtime_bundle: generated editor/runtime map bundle for a CARLA map
 * - actor_catalog: static CARLA actor catalog available to the editor
 */
export const MapAssetArtifactType = z.enum([
  "geojson",
  "xodr",
  "rrdata_xml",
  "fbx",
  "mp4",
  "mp4_preview",
  "image",
  "signals_geojson",
  "lane_polygons_geojson",
  "thumbnail",
  "3d_manifest",
  "search_index",
  "topology_index",
  "runtime_bundle",
  "actor_catalog",
]);
export type MapAssetArtifactType = z.infer<typeof MapAssetArtifactType>;

export const MAP_ASSET_ARTIFACT_TYPE_VALUES: readonly MapAssetArtifactType[] =
  MapAssetArtifactType.options;

/** Single map asset artifact (type + URI + optional integrity hash + optional label). */
export const MapAssetArtifactSchema = z.object({
  artifact_type: MapAssetArtifactType,
  uri: z.string(),
  sha256: z.string(),
  /** Human-readable label for media artifacts (e.g. "north approach", "intersection overview"). */
  label: z.string().optional(),
  /** File size in bytes (from S3 upload). */
  size_bytes: z.number().nullable().optional(),
  /** When this artifact was added to the map. */
  created_at: z.string().nullable().optional(),
});
export type MapAssetArtifact = z.infer<typeof MapAssetArtifactSchema>;

/** List of map artifacts (each carries its type). */
export const MapAssetArtifactsSchema = z.array(MapAssetArtifactSchema);
export type MapAssetArtifacts = z.infer<typeof MapAssetArtifactsSchema>;

/**
 * A single SimScene satellite image service: a tileset + the RGB layer within it.
 * A map carries a LIST of these because one tileset often covers only part of a
 * map's extent; stacked together their union covers the whole area.
 */
export const MapImageryTilesetSchema = z.object({
  tileset_id: z.string(),
  layer_id: z.string(),
});
export type MapImageryTileset = z.infer<typeof MapImageryTilesetSchema>;

/** Center point (lat/lng). */
export const MapAssetCenterSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type MapAssetCenter = z.infer<typeof MapAssetCenterSchema>;

/**
 * Tags: set of string labels describing map elements relevant for scenario creation.
 * Values come from a pre-defined list of map-asset descriptor tags (see map-asset-tags).
 */
export const MapAssetTagsSchema = z.array(z.string());
export type MapAssetTags = z.infer<typeof MapAssetTagsSchema>;

/**
 * Map asset: a single map asset representing a geographic area.
 * Scenario-independent; served by MapAssetCatalog (SimCloud backend proxies to it).
 * Includes generic representation (GeoJSON) and consumer-specific formats (XODR, RRData, FBX).
 */
export const MapAssetSchema = z.object({
  map_asset_id: z.string(),
  name: z.string(),
  /** CARLA simulator map name (e.g. "Belmont_Office_Park_Belmont_CA"). Null if no CARLA map exists for this asset. */
  carla_map_name: z.string().nullish(),
  /** CARLA 0.10.0 / UE5 map name for this asset. Null/absent if the map is not servable on the UE5 runtime. */
  ue5_carla_map_name: z.string().nullish(),
  /** SimScene image services serving this map's satellite ortho imagery. Stacked as raster layers; empty/absent = no satellite basemap. */
  imagery_tilesets: z.array(MapImageryTilesetSchema).nullish(),
  description: z.string().optional(),
  crs: z.string(),
  bbox: BboxSchema,
  center: MapAssetCenterSchema,
  created_at: z.string(),
  artifacts: MapAssetArtifactsSchema,
  /** Labels from a pre-defined descriptor taxonomy (e.g. INTERSECTION_SIGNALIZED, SCHOOL_ZONE_BOUNDARY). */
  tags: MapAssetTagsSchema.optional(),
  /** Extracted from OpenDRIVE / RoadRunner exports (optional for legacy maps). */
  map_source: MapSourceSchema.optional(),
  map_coordinate_ref: MapCoordinateRefSchema.optional(),
  metadata_last_populated_at: z.string().optional(),
  /** Present when loaded with stats join or after metadata compute. */
  map_stats: MapStatsSchema.optional(),
  /** Reverse-geocoded city/state/country from origin_lat/lon. Populated at upload time. */
  place_context: MapPlaceContextSchema.optional(),
  /** Lightweight third-party enrichment summary. Full overlay payload is fetched separately. */
  enrichment_summary: MapEnrichmentSummarySchema.optional(),
});
export type MapAsset = z.infer<typeof MapAssetSchema>;
