import { scenarioListCache } from "./scenarioListCache";

export const SCENARIO_VIEW_STORAGE_KEY = "simforge.scenarioDatasetView.v1";

type PersistedScenarioViewState = {
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
    Object.entries(scenarioListCache.expandedMapLabelsByDataset).map(([datasetId, labels]) => [
      datasetId,
      [...labels].slice(0, 1),
    ]),
  );
}

export function persistScenarioViewState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SCENARIO_VIEW_STORAGE_KEY,
      JSON.stringify({
        selectedDatasetId: scenarioListCache.selectedDatasetId,
        selectedDocumentIdByDataset: scenarioListCache.selectedDocumentIdByDataset,
        expandedMapLabelsByDataset: serializeExpandedMapLabels(),
        cinematicPreviewEnabled: scenarioListCache.cinematicPreviewEnabled,
      }),
    );
  } catch {
    // View restoration is best-effort; ignore storage quota and privacy-mode failures.
  }
}

export function hydrateScenarioViewStateFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SCENARIO_VIEW_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedScenarioViewState;
    if ("selectedDatasetId" in parsed) {
      scenarioListCache.selectedDatasetId = parsed.selectedDatasetId ?? null;
    }
    if (parsed.selectedDocumentIdByDataset) {
      scenarioListCache.selectedDocumentIdByDataset = parsed.selectedDocumentIdByDataset;
    }
    if (parsed.expandedMapLabelsByDataset) {
      scenarioListCache.expandedMapLabelsByDataset = Object.fromEntries(
        Object.entries(parsed.expandedMapLabelsByDataset).map(([datasetId, labels]) => [
          datasetId,
          new Set(labels.slice(0, 1)),
        ]),
      );
    }
    if (typeof parsed.cinematicPreviewEnabled === "boolean") {
      scenarioListCache.cinematicPreviewEnabled = parsed.cinematicPreviewEnabled;
    }
  } catch {
    return;
  }
}

export function rememberScenarioSelection(datasetId: string, documentId: string) {
  scenarioListCache.selectedDatasetId = datasetId;
  scenarioListCache.selectedDocumentIdByDataset = {
    ...scenarioListCache.selectedDocumentIdByDataset,
    [datasetId]: documentId,
  };
  persistScenarioViewState();
}

export function rememberCinematicPreviewEnabled(enabled: boolean) {
  scenarioListCache.cinematicPreviewEnabled = enabled;
  persistScenarioViewState();
}
