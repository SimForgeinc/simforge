import type { MapAsset } from "@simforge/studio-shared";
import { MAP_ASSET_DESCRIPTOR_TAGS } from "@simforge/studio-shared";

export type CatalogView = "grid" | "map";
export type CatalogSort = "date" | "name" | "mileage";

const TAG_DEFINITIONS = new Map(
  MAP_ASSET_DESCRIPTOR_TAGS.map((t) => [t.id, t.shortDefinition]),
);

/** Build a lowercase search corpus for a map asset. */
export function buildCorpus(asset: MapAsset): string {
  const tagText = (asset.tags ?? [])
    .flatMap((id) => [id.replace(/_/g, " "), TAG_DEFINITIONS.get(id) ?? ""])
    .join(" ");
  const place = asset.place_context
    ? [asset.place_context.city, asset.place_context.state, asset.place_context.country]
        .filter(Boolean)
        .join(" ")
    : "";
  return [asset.name, asset.description ?? "", tagText, place]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Filter assets by search query against pre-built corpora. */
export function filterAssets(
  assets: MapAsset[],
  corpora: string[],
  query: string,
): MapAsset[] {
  const q = query.trim().toLowerCase();
  if (!q) return assets;
  return assets.filter((_, i) => corpora[i]!.includes(q));
}

/** Sort assets by the selected criterion. */
export function sortAssets(assets: MapAsset[], sort: CatalogSort): MapAsset[] {
  const sorted = [...assets];
  switch (sort) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "mileage":
      sorted.sort((a, b) => {
        const ma = a.map_stats?.road_network?.total_centerline_length_m ?? 0;
        const mb = b.map_stats?.road_network?.total_centerline_length_m ?? 0;
        return mb - ma;
      });
      break;
    case "date":
    default:
      sorted.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      break;
  }
  return sorted;
}
