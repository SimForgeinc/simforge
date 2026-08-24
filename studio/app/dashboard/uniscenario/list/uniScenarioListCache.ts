import type {
  UniScenarioDatasetDto,
  UniScenarioDatasetReadinessDto,
  UniScenarioDocumentSummaryDto,
  UniScenarioRatingAggregateDto,
  UniScenarioTagDto,
} from "@/app/lib/uniscenario/contracts";

/**
 * Module-scoped list state that outlives a route transition.
 *
 * Ported from v1's `datasetBrowserCache`, and it is a plain mutable object on purpose: the point is
 * that navigating away from the list and back does not re-flash an empty grid, which React state
 * cannot do because the components unmount. Every client below seeds `useState` from here and writes
 * back on mutation, so the cache and the rendered state stay in step.
 *
 * Two field names diverge from v1, because in v2 they would describe the wrong thing:
 * `documentsByDataset` (v1: `scenariosByDataset`) since a v2 row is a document, and a flat
 * `tagCatalog` instead of v1's `tagCatalogByDataset` since the catalog is now workspace-scoped
 * (§6.3) rather than re-seeded per dataset.
 */
export type UniScenarioListCache = {
  datasets: UniScenarioDatasetDto[];
  datasetsLoaded: boolean;
  selectedDatasetId: string | null;
  documentsByDataset: Record<string, UniScenarioDocumentSummaryDto[]>;
  /**
   * Documents created locally that a server page has not caught up with yet.
   *
   * Kept apart from `documentsByDataset` so a page load that lands mid-create re-merges them
   * instead of dropping the row the user is looking at.
   */
  pendingDocumentsByDataset: Record<string, UniScenarioDocumentSummaryDto[]>;
  nextCursorByDataset: Record<string, string | null>;
  expandedMapLabelsByDataset: Record<string, Set<string>>;
  selectedDocumentIdByDataset: Record<string, string>;
  tagCatalog: UniScenarioTagDto[];
  tagCatalogLoaded: boolean;
  ratingAggregatesByDataset: Record<string, Record<string, UniScenarioRatingAggregateDto>>;
  selectedTagFilterByDataset: Record<string, string | null>;
  selectedCreatorFilterByDataset: Record<string, string | null>;
  loadedDatasetIds: Set<string>;
  readinessByDataset: Record<string, UniScenarioDatasetReadinessDto["summary"]>;
  /**
   * Whether a selected scenario previews with the cinematic camera.
   *
   * A viewing preference rather than per-dataset state, so it is one flag: the
   * user who turns the cuts off wants them off for the next scenario too.
   */
  cinematicPreviewEnabled: boolean;
};

export const uniScenarioListCache: UniScenarioListCache = {
  datasets: [],
  datasetsLoaded: false,
  selectedDatasetId: null,
  documentsByDataset: {},
  pendingDocumentsByDataset: {},
  nextCursorByDataset: {},
  expandedMapLabelsByDataset: {},
  selectedDocumentIdByDataset: {},
  tagCatalog: [],
  tagCatalogLoaded: false,
  ratingAggregatesByDataset: {},
  selectedTagFilterByDataset: {},
  selectedCreatorFilterByDataset: {},
  loadedDatasetIds: new Set(),
  readinessByDataset: {},
  cinematicPreviewEnabled: true,
};

/** v1's four seeded defaults, as the client-side fallback before the catalog fetch lands. */
export const DEFAULT_UNISCENARIO_TAG_COLORS = [
  "#e8e044",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#94a3b8",
] as const;

export const DEFAULT_UNISCENARIO_TAG_COLOR = DEFAULT_UNISCENARIO_TAG_COLORS[0];

/** Only used by tests, which must not inherit another test's list state. */
export function resetUniScenarioListCache() {
  uniScenarioListCache.datasets = [];
  uniScenarioListCache.datasetsLoaded = false;
  uniScenarioListCache.selectedDatasetId = null;
  uniScenarioListCache.documentsByDataset = {};
  uniScenarioListCache.pendingDocumentsByDataset = {};
  uniScenarioListCache.nextCursorByDataset = {};
  uniScenarioListCache.expandedMapLabelsByDataset = {};
  uniScenarioListCache.selectedDocumentIdByDataset = {};
  uniScenarioListCache.tagCatalog = [];
  uniScenarioListCache.tagCatalogLoaded = false;
  uniScenarioListCache.ratingAggregatesByDataset = {};
  uniScenarioListCache.selectedTagFilterByDataset = {};
  uniScenarioListCache.selectedCreatorFilterByDataset = {};
  uniScenarioListCache.loadedDatasetIds = new Set();
  uniScenarioListCache.readinessByDataset = {};
  uniScenarioListCache.cinematicPreviewEnabled = true;
}
