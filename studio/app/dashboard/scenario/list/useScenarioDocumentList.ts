"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ScenarioDatasetReadinessDto,
  ScenarioDocumentSummaryDto,
} from "@/app/lib/scenario/contracts";
import * as api from "./api";
import { updateDocumentList } from "./document-list-utils";
import { scenarioListCache } from "./scenarioListCache";

const PAGE_SIZE = 50;

export type ScenarioDocumentListResult = {
  documents: ScenarioDocumentSummaryDto[];
  /** `null` before the first page resolves — distinguishable from an empty dataset. */
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  readiness: ScenarioDatasetReadinessDto["summary"] | null;
  error: string | null;
  loadFirstPage: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadReadiness: (signal?: AbortSignal) => Promise<boolean>;
  /** Optimistic splice. Pass a function for read-modify-write against the current list. */
  spliceDocument: (next: ScenarioDocumentSummaryDto) => void;
  removeDocument: (documentId: string) => void;
  setDocuments: (next: ScenarioDocumentSummaryDto[]) => void;
  clearError: () => void;
};

/**
 * Load and paginate one dataset's documents.
 *
 * Cursor pagination, not `LIMIT 100`: `listScenarioDocumentSummaries` orders by
 * `updated_at DESC, id DESC` and the cursor is keyed on that pair, so editing a document while
 * paging moves it rather than making the next page skip or repeat rows — which an `OFFSET` would.
 *
 * Every mutation in the sibling hooks splices through `spliceDocument`/`removeDocument` rather than
 * calling `loadFirstPage` again. That is the house pattern (§5.6) and it is load bearing, not a perf
 * trick: a refetch after a rename would drop every page past the first and scroll the user back to
 * the top of the list they were working in.
 */
export function useScenarioDocumentList(datasetId: string | null): ScenarioDocumentListResult {
  const [documents, setDocumentsState] = useState<ScenarioDocumentSummaryDto[]>(() =>
    datasetId ? (scenarioListCache.documentsByDataset[datasetId] ?? []) : [],
  );
  const [loaded, setLoaded] = useState(() =>
    Boolean(datasetId && scenarioListCache.loadedDatasetIds.has(datasetId)),
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(() =>
    Boolean(datasetId && scenarioListCache.nextCursorByDataset[datasetId]),
  );
  const [readiness, setReadiness] = useState<ScenarioDatasetReadinessDto["summary"] | null>(() =>
    datasetId ? (scenarioListCache.readinessByDataset[datasetId] ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  // One controller for the whole hook: switching datasets or unmounting must abandon the in-flight
  // page, or a slow first page can land after a faster one for a different dataset.
  const abortRef = useRef<AbortController | null>(null);

  const publish = useCallback(
    (id: string, next: ScenarioDocumentSummaryDto[]) => {
      scenarioListCache.documentsByDataset = {
        ...scenarioListCache.documentsByDataset,
        [id]: next,
      };
      setDocumentsState(next);
    },
    [],
  );

  useEffect(() => {
    setDocumentsState(datasetId ? (scenarioListCache.documentsByDataset[datasetId] ?? []) : []);
    setLoaded(Boolean(datasetId && scenarioListCache.loadedDatasetIds.has(datasetId)));
    setHasMore(Boolean(datasetId && scenarioListCache.nextCursorByDataset[datasetId]));
    setReadiness(datasetId ? (scenarioListCache.readinessByDataset[datasetId] ?? null) : null);
    setError(null);
  }, [datasetId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const loadPage = useCallback(
    async (append: boolean) => {
      if (!datasetId) return;
      const cursor = append ? scenarioListCache.nextCursorByDataset[datasetId] : null;
      if (append && !cursor) return;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await api.listDocumentSummaries(
          { datasetId, limit: PAGE_SIZE, cursor },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        // Locally-created rows are re-merged on every page: a create followed immediately by a page
        // fetch would otherwise briefly lose the row the user is looking at, because the projection
        // has not caught up with the insert yet.
        const merged = new Map(
          (append ? (scenarioListCache.documentsByDataset[datasetId] ?? []) : []).map(
            (document) => [document.id, document] as const,
          ),
        );
        for (const document of scenarioListCache.pendingDocumentsByDataset[datasetId] ?? []) {
          merged.set(document.id, document);
        }
        for (const document of page.documents) merged.set(document.id, document);
        scenarioListCache.loadedDatasetIds.add(datasetId);
        scenarioListCache.nextCursorByDataset = {
          ...scenarioListCache.nextCursorByDataset,
          [datasetId]: page.nextCursor,
        };
        publish(datasetId, [...merged.values()]);
        setHasMore(Boolean(page.nextCursor));
        setLoaded(true);
        setError(null);
      } catch (loadError) {
        if (abort.signal.aborted || (loadError as { name?: string } | null)?.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load scenarios.",
        );
      } finally {
        if (abort.signal.aborted) return;
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [datasetId, publish],
  );

  const loadFirstPage = useCallback(() => loadPage(false), [loadPage]);
  const loadMore = useCallback(() => loadPage(true), [loadPage]);

  /**
   * Refresh render-state badges without replacing the list.
   *
   * Readiness is auxiliary: a failure here leaves the loaded documents alone and reports nothing,
   * because a stale render icon is not worth an error banner over the list it decorates.
   */
  const loadReadiness = useCallback(async (signal?: AbortSignal) => {
    if (!datasetId) return false;
    try {
      const snapshot = await api.getDatasetReadiness(datasetId, signal);
      if (signal?.aborted) return false;
      const renderedByDocument = new Map(
        snapshot.scenarios.map((entry) => [entry.id, Boolean(entry.has_render)] as const),
      );
      scenarioListCache.readinessByDataset = {
        ...scenarioListCache.readinessByDataset,
        [datasetId]: snapshot.summary,
      };
      setReadiness(snapshot.summary);
      if (renderedByDocument.size > 0) {
        publish(
          datasetId,
          (scenarioListCache.documentsByDataset[datasetId] ?? []).map((document) => ({
            ...document,
            hasRender: renderedByDocument.get(document.id) ?? false,
          })),
        );
      }
      return true;
    } catch (loadError) {
      if (
        signal?.aborted ||
        (loadError as { name?: string } | null)?.name === "AbortError"
      ) {
        return false;
      }
      // Intentionally silent — see above.
      return false;
    }
  }, [datasetId, publish]);

  const spliceDocument = useCallback(
    (next: ScenarioDocumentSummaryDto) => {
      const id = next.datasetId || datasetId;
      if (!id) return;
      publish(id, updateDocumentList(scenarioListCache.documentsByDataset[id], next));
    },
    [datasetId, publish],
  );

  const removeDocument = useCallback(
    (documentId: string) => {
      if (!datasetId) return;
      publish(
        datasetId,
        (scenarioListCache.documentsByDataset[datasetId] ?? []).filter(
          (document) => document.id !== documentId,
        ),
      );
      scenarioListCache.pendingDocumentsByDataset = {
        ...scenarioListCache.pendingDocumentsByDataset,
        [datasetId]: (scenarioListCache.pendingDocumentsByDataset[datasetId] ?? []).filter(
          (document) => document.id !== documentId,
        ),
      };
    },
    [datasetId, publish],
  );

  const setDocuments = useCallback(
    (next: ScenarioDocumentSummaryDto[]) => {
      if (!datasetId) return;
      scenarioListCache.loadedDatasetIds.add(datasetId);
      publish(datasetId, next);
      setLoaded(true);
    },
    [datasetId, publish],
  );

  return {
    documents,
    loaded,
    loading,
    loadingMore,
    hasMore,
    readiness,
    error,
    loadFirstPage,
    loadMore,
    loadReadiness,
    spliceDocument,
    removeDocument,
    setDocuments,
    clearError: useCallback(() => setError(null), []),
  };
}
