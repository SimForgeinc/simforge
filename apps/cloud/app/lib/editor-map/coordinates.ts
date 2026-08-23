import type { MapAsset } from "@simcloud/shared";
import { MapProjection } from "@simcloud/shared";
import {
  editorLocalPointToRuntimePoint,
  runtimePointToEditorLocalPoint,
} from "./coordinate-frames";

// Coordinate contract:
// - Runtime points are the frontend/API actor and trajectory frame.
// - Editor-local points are y-down map-overlay points.
// - Raw CARLA Location.y is mirrored from runtime point y for our map bundles.
// See docs/carla-coordinate-systems.md before adding another conversion path.

/**
 * Convert WGS84 (lng, lat) to local meters in the **y-down** editor frame.
 *
 * Projection is performed by `MapProjection` (a thin proj4 wrapper) against
 * the asset's declared `proj_string` (verbatim from the XODR's
 * `<geoReference>`), with a vanilla `+proj=tmerc` synthesized from
 * `origin_lat`/`origin_lon` as a fallback for legacy assets that have an
 * origin but no full PROJ string. Replaced an earlier flat-earth
 * equirectangular approximation that diverged from the XODR-declared
 * projection by 0.13–0.27% per metre away from origin.
 *
 * Returns null when the asset has neither a PROJ string nor an origin.
 */
export function lngLatToLocalPoint(
  lng: number,
  lat: number,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): { x: number; y: number } | null {
  const proj = MapProjection.fromCoordinateRef(asset.map_coordinate_ref ?? {});
  if (!proj) return null;
  const { x, y } = proj.geoToLocal(lng, lat);
  return runtimePointToEditorLocalPoint({ x, y });
}

/**
 * Convert WGS84 (lng, lat) to frontend runtime meters for actor/path payloads.
 * This is not raw CARLA `Location.y`; the worker flips runtime Y when spawning
 * actors into CARLA.
 * See `lngLatToLocalPoint` for the projection rationale.
 */
export function lngLatToRuntimePoint(
  lng: number,
  lat: number,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): { x: number; y: number } | null {
  const proj = MapProjection.fromCoordinateRef(asset.map_coordinate_ref ?? {});
  if (!proj) return null;
  return proj.geoToLocal(lng, lat);
}

/** Inverse of `lngLatToLocalPoint`. */
export function localPointToLngLat(
  point: { x: number; y: number } | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): [number, number] | null {
  if (!point) return null;
  const proj = MapProjection.fromCoordinateRef(asset.map_coordinate_ref ?? {});
  if (!proj) return null;
  const runtimePoint = editorLocalPointToRuntimePoint(point);
  const { lon, lat } = proj.localToGeo(runtimePoint.x, runtimePoint.y);
  return [lon, lat];
}

/** Inverse of `lngLatToRuntimePoint`. */
export function runtimePointToLngLat(
  point: { x: number; y: number } | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): [number, number] | null {
  if (!point) return null;
  const proj = MapProjection.fromCoordinateRef(asset.map_coordinate_ref ?? {});
  if (!proj) return null;
  const { lon, lat } = proj.localToGeo(point.x, point.y);
  return [lon, lat];
}
