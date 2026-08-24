import {
  GALLERY_ACTOR_CLASSES,
  type GalleryAssetSummary,
} from "@/app/lib/asset-gallery/contracts";
import type { CarlaCompatibility } from "@/app/lib/scenario/carla-compatibility";

/**
 * The gallery's control surface, split by who can actually answer each control.
 *
 * `q`, `actorClass` and `mine` are query params on `GET /api/asset-gallery`, so
 * they narrow the whole library and a match may live on a page nobody has
 * scrolled to yet. CARLA compatibility and sort order have no such param, so
 * they are applied here over the pages already loaded — which is a real
 * limitation, not a shortcut, and the toolbar says so next to the result count
 * whenever another page is still waiting behind a cursor.
 */

export type GallerySort = "newest" | "name" | "triangles";
export type GalleryCarlaFilter = "all" | "native" | "browser-only";

/** Menu order, and the source of both the labels and the radio items. */
export const GALLERY_SORT_ORDER = ["newest", "name", "triangles"] as const;

export const GALLERY_SORT_LABELS = {
  newest: "Newest",
  name: "Name",
  triangles: "Triangles",
} as const satisfies Record<GallerySort, string>;

export const GALLERY_ACTOR_CLASS_OPTIONS = [
  { value: "all", label: "All actor classes" },
  ...GALLERY_ACTOR_CLASSES.map((value) => ({
    value,
    // The raw enum is snake_case. A dropdown item is plain text in a portal, so
    // CSS `capitalize` never reaches it — the label has to arrive readable.
    label: value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
  })),
];

export const GALLERY_CARLA_FILTER_OPTIONS = [
  { value: "all", label: "CARLA: any" },
  { value: "native", label: "CARLA ready" },
  { value: "browser-only", label: "Browser only" },
];

/**
 * Every gallery upload lands here: a model published through this page has no
 * CARLA blueprint bound to it, so it renders in browser preview and
 * browser-recorded renders but is absent from a CARLA render.
 */
export const GALLERY_UPLOAD_CARLA_COMPATIBILITY: CarlaCompatibility = {
  status: "browser-only",
  reason:
    "User-uploaded model has no CARLA runtime blueprint; it renders in browser preview and browser-recorded renders only.",
};

/**
 * Apply the two client-side controls in one pass.
 *
 * `native` resolves to nothing by construction rather than by search: the
 * gallery cannot hold a CARLA-native model, so filtering for one is a question
 * whose answer is known without touching the array.
 */
export function galleryVisibleAssets(
  items: readonly GalleryAssetSummary[],
  carla: GalleryCarlaFilter,
  sort: GallerySort,
): GalleryAssetSummary[] {
  if (carla === "native") return [];
  const visible = [...items];
  if (sort === "name") {
    visible.sort((left, right) => left.title.localeCompare(right.title));
  } else if (sort === "triangles") {
    // Heaviest first: the reason to sort on triangles is to find the models
    // that will cost a scene its frame budget, not the cheapest ones.
    visible.sort((left, right) => right.triangleCount - left.triangleCount);
  } else {
    visible.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }
  return visible;
}
