import type { MapAsset } from "@simforge-oss/studio-shared";
import type { Bounds } from "@/app/lib/runtime/map-data";
import { localPointToLngLat } from "./coordinates";

export function localBoundsToLngLatBounds(
  bounds: Bounds | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref"> | null | undefined,
): [[number, number], [number, number]] | null {
  if (!bounds || !asset?.map_coordinate_ref) return null;

  // Project the SW (minX, maxY) and NE (maxX, minY) corners of the y-down
  // local-meters bbox through the same TMerc inverse `localPointToLngLat`
  // uses. Replaces the prior equirectangular formula whose 0.13–0.27%
  // systematic drift accumulated visibly on bigger maps.
  const sw = localPointToLngLat({ x: bounds.minX, y: bounds.maxY }, asset);
  const ne = localPointToLngLat({ x: bounds.maxX, y: bounds.minY }, asset);
  if (!sw || !ne) return null;

  return [sw, ne];
}
