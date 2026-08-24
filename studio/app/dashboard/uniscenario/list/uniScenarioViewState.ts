import { uniScenarioListCache } from "./uniScenarioListCache";

export const UNISCENARIO_VIEW_STORAGE_KEY = "simforge.uniscenarioDatasetView.v1";

type PersistedUniScenarioViewState = {
  selectedDatasetId?: string | null;
  selectedDocumentIdByDataset?: Record<string, string>;
  expandedMapLabelsByDataset?: Record<string, string[]>;
  cinematicPreviewEnabled?: boolean;
};

/**
 * Only the one open map group is persisted per dataset.
 *
 * The list opens exactly one group at a time (`toggleMapGroup` replaces rather than adds), so
 * storing more would restore a state the UI cannot itself produce.
 */
function serializeExpandedMapLabels() {
  return Object.fromEntries(
    Object.entries(uniScenarioListCache.expandedMapLabelsByDataset).map(([datasetId, labels]) => [
      datasetId,
      [...labels].slice(0, 1),
    ]),
  );
}

export function persistUniScenarioViewState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      UNISCENARIO_VIEW_STORAGE_KEY,
      JSON.stringify({
        selectedDatasetId: uniScenarioListCache.selectedDatasetId,
        selectedDocumentIdByDataset: uniScenarioListCache.selectedDocumentIdByDataset,
        expandedMapLabelsByDataset: serializeExpandedMapLabels(),
        cinematicPreviewEnabled: uniScenarioListCache.cinematicPreviewEnabled,
      }),
    );
  } catch {
    // View restoration is best-effort; ignore storage quota and privacy-mode failures.
  }
}

export function hydrateUniScenarioViewStateFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(UNISCENARIO_VIEW_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedUniScenarioViewState;
    if ("selectedDatasetId" in parsed) {
      uniScenarioListCache.selectedDatasetId = parsed.selectedDatasetId ?? null;
    }
    if (parsed.selectedDocumentIdByDataset) {
      uniScenarioListCache.selectedDocumentIdByDataset = parsed.selectedDocumentIdByDataset;
    }
    if (parsed.expandedMapLabelsByDataset) {
      uniScenarioListCache.expandedMapLabelsByDataset = Object.fromEntries(
        Object.entries(parsed.expandedMapLabelsByDataset).map(([datasetId, labels]) => [
          datasetId,
          new Set(labels.slice(0, 1)),
        ]),
      );
    }
    if (typeof parsed.cinematicPreviewEnabled === "boolean") {
      uniScenarioListCache.cinematicPreviewEnabled = parsed.cinematicPreviewEnabled;
    }
  } catch {
    return;
  }
}

export function rememberUniScenarioSelection(datasetId: string, documentId: string) {
  uniScenarioListCache.selectedDatasetId = datasetId;
  uniScenarioListCache.selectedDocumentIdByDataset = {
    ...uniScenarioListCache.selectedDocumentIdByDataset,
    [datasetId]: documentId,
  };
  persistUniScenarioViewState();
}

export function rememberCinematicPreviewEnabled(enabled: boolean) {
  uniScenarioListCache.cinematicPreviewEnabled = enabled;
  persistUniScenarioViewState();
}
