"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  UniScenarioDocumentSummaryDto,
  UniScenarioRatingAggregateDto,
  UniScenarioTagDto,
} from "@/app/lib/uniscenario/contracts";
import * as api from "./api";
import { UniScenarioNameConflict } from "./api";
import {
  DEFAULT_UNISCENARIO_TAG_COLOR,
  uniScenarioListCache,
} from "./uniScenarioListCache";

export type UniScenarioTagManagerResult = {
  tags: UniScenarioTagDto[];
  tagsLoading: boolean;
  tagError: string | null;
  ratingAggregates: Record<string, UniScenarioRatingAggregateDto>;
  ratingsLoading: boolean;
  ratingError: string | null;
  ratingSavingIds: ReadonlySet<string>;
  selectedTagFilter: string | null;
  selectedCreatorFilter: string | null;
  newTagName: string;
  newTagColor: string;
  setNewTagName: (name: string) => void;
  setNewTagColor: (color: string) => void;
  createTag: () => Promise<void>;
  renameTag: (tagId: string, label: string) => Promise<void>;
  setTagColor: (tagId: string, color: string) => Promise<void>;
  deleteTag: (tagId: string) => Promise<void>;
  /** Add or remove one tag on one document. Sends the document's whole resulting set. */
  toggleDocumentTag: (documentId: string, tagId: string) => Promise<void>;
  /** Idempotent add — what a drag-and-drop assignment means. */
  assignDocumentTag: (documentId: string, tagId: string) => Promise<void>;
  selectTagFilter: (tagId: string | null) => void;
  selectCreatorFilter: (creator: string | null) => void;
  setDocumentRating: (documentId: string, rating: number) => Promise<void>;
  clearTagError: () => void;
};

/**
 * The tag catalog, tag assignment, and ratings for one dataset's list.
 *
 * v1 kept all of this in localStorage: the catalog was re-seeded per dataset, assignments never left
 * the browser, and "show me every crash" was impossible across datasets or across machines. Here the
 * catalog is a workspace-scoped table and assignments are rows, so a tag applied on one machine is
 * visible on the next (§6.3).
 *
 * Assignment is a set-replace against `PUT /documents/[id]/tags`, not add/remove: the row already
 * holds its complete tag list, and two concurrent single-tag toggles on the same row would otherwise
 * interleave into a state neither client asked for.
 */
export function useUniScenarioTagManager({
  datasetId,
  documents,
  spliceDocument,
}: {
  datasetId: string | null;
  documents: UniScenarioDocumentSummaryDto[];
  spliceDocument: (next: UniScenarioDocumentSummaryDto) => void;
}): UniScenarioTagManagerResult {
  const [tags, setTags] = useState<UniScenarioTagDto[]>(() => uniScenarioListCache.tagCatalog);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [ratingAggregates, setRatingAggregates] = useState<
    Record<string, UniScenarioRatingAggregateDto>
  >(() => (datasetId ? (uniScenarioListCache.ratingAggregatesByDataset[datasetId] ?? {}) : {}));
  const [ratingsLoading, setRatingsLoading] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [ratingSavingIds, setRatingSavingIds] = useState<Set<string>>(() => new Set());
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(() =>
    datasetId ? (uniScenarioListCache.selectedTagFilterByDataset[datasetId] ?? null) : null,
  );
  const [selectedCreatorFilter, setSelectedCreatorFilter] = useState<string | null>(() =>
    datasetId ? (uniScenarioListCache.selectedCreatorFilterByDataset[datasetId] ?? null) : null,
  );
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<string>(DEFAULT_UNISCENARIO_TAG_COLOR);

  const publishTags = useCallback((next: UniScenarioTagDto[]) => {
    uniScenarioListCache.tagCatalog = next;
    uniScenarioListCache.tagCatalogLoaded = true;
    setTags(next);
  }, []);

  // ── Catalog ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (uniScenarioListCache.tagCatalogLoaded) return;
    const abort = new AbortController();
    setTagsLoading(true);
    api
      .listTags(abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        publishTags(next);
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted || (failure as { name?: string } | null)?.name === "AbortError") {
          return;
        }
        setTagError(failure instanceof Error ? failure.message : "Failed to load tags.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setTagsLoading(false);
      });
    return () => abort.abort();
  }, [publishTags]);

  const createTag = useCallback(async () => {
    const label = newTagName.trim();
    if (!label) return;
    setTagError(null);
    try {
      const created = await api.createTag({ label, color: newTagColor });
      publishTags([...tags.filter((tag) => tag.id !== created.id), created].sort(byLabel));
      setNewTagName("");
      setNewTagColor(DEFAULT_UNISCENARIO_TAG_COLOR);
    } catch (failure) {
      setTagError(
        failure instanceof UniScenarioNameConflict
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : "Failed to create tag.",
      );
    }
  }, [newTagColor, newTagName, publishTags, tags]);

  const renameTag = useCallback(
    async (tagId: string, labelValue: string) => {
      const label = labelValue.trim();
      if (!label) return;
      const previous = tags;
      setTagError(null);
      publishTags(tags.map((tag) => (tag.id === tagId ? { ...tag, label } : tag)).sort(byLabel));
      try {
        const updated = await api.updateTag(tagId, { label });
        publishTags(
          uniScenarioListCache.tagCatalog
            .map((tag) => (tag.id === updated.id ? updated : tag))
            .sort(byLabel),
        );
      } catch (failure) {
        publishTags(previous);
        setTagError(failure instanceof Error ? failure.message : "Failed to rename tag.");
      }
    },
    [publishTags, tags],
  );

  const setTagColor = useCallback(
    async (tagId: string, color: string) => {
      const previous = tags;
      setTagError(null);
      publishTags(tags.map((tag) => (tag.id === tagId ? { ...tag, color } : tag)));
      try {
        await api.updateTag(tagId, { color });
      } catch (failure) {
        publishTags(previous);
        setTagError(failure instanceof Error ? failure.message : "Failed to recolour tag.");
      }
    },
    [publishTags, tags],
  );

  /**
   * Delete a tag, and drop it from every loaded row.
   *
   * The server deletes the assignments with it, so the local rows have to follow or the list keeps
   * rendering a tag that no longer exists until the next page fetch.
   */
  const deleteTag = useCallback(
    async (tagId: string) => {
      const previous = tags;
      setTagError(null);
      publishTags(tags.filter((tag) => tag.id !== tagId));
      try {
        await api.deleteTag(tagId);
        for (const document of documents) {
          if (!document.tags.some((tag) => tag.id === tagId)) continue;
          spliceDocument({
            ...document,
            tags: document.tags.filter((tag) => tag.id !== tagId),
          });
        }
        setSelectedTagFilter((current) => (current === tagId ? null : current));
      } catch (failure) {
        publishTags(previous);
        setTagError(failure instanceof Error ? failure.message : "Failed to delete tag.");
      }
    },
    [documents, publishTags, spliceDocument, tags],
  );

  // ── Assignment ────────────────────────────────────────────────────────────

  const applyTagSet = useCallback(
    async (documentId: string, nextTagIds: string[]) => {
      const document = documents.find((entry) => entry.id === documentId);
      if (!document) return;
      const previousTags = document.tags;
      const catalogById = new Map(uniScenarioListCache.tagCatalog.map((tag) => [tag.id, tag]));
      const optimistic = nextTagIds.flatMap((tagId) => {
        const tag = catalogById.get(tagId);
        return tag ? [{ id: tag.id, label: tag.label, color: tag.color }] : [];
      });
      spliceDocument({ ...document, tags: optimistic });
      try {
        const saved = await api.setDocumentTags(documentId, nextTagIds);
        spliceDocument({
          ...document,
          tags: saved.map((tag) => ({ id: tag.id, label: tag.label, color: tag.color })),
        });
      } catch (failure) {
        spliceDocument({ ...document, tags: previousTags });
        setTagError(failure instanceof Error ? failure.message : "Failed to save tags.");
      }
    },
    [documents, spliceDocument],
  );

  const toggleDocumentTag = useCallback(
    async (documentId: string, tagId: string) => {
      const document = documents.find((entry) => entry.id === documentId);
      if (!document) return;
      const currentIds = document.tags.map((tag) => tag.id);
      await applyTagSet(
        documentId,
        currentIds.includes(tagId)
          ? currentIds.filter((id) => id !== tagId)
          : [...currentIds, tagId],
      );
    },
    [applyTagSet, documents],
  );

  const assignDocumentTag = useCallback(
    async (documentId: string, tagId: string) => {
      const document = documents.find((entry) => entry.id === documentId);
      if (!document) return;
      const currentIds = document.tags.map((tag) => tag.id);
      if (currentIds.includes(tagId)) return;
      await applyTagSet(documentId, [...currentIds, tagId]);
    },
    [applyTagSet, documents],
  );

  // ── Filters ───────────────────────────────────────────────────────────────

  const selectTagFilter = useCallback(
    (tagId: string | null) => {
      setSelectedTagFilter(tagId);
      if (!datasetId) return;
      uniScenarioListCache.selectedTagFilterByDataset = {
        ...uniScenarioListCache.selectedTagFilterByDataset,
        [datasetId]: tagId,
      };
    },
    [datasetId],
  );

  const selectCreatorFilter = useCallback(
    (creator: string | null) => {
      setSelectedCreatorFilter(creator);
      if (!datasetId) return;
      uniScenarioListCache.selectedCreatorFilterByDataset = {
        ...uniScenarioListCache.selectedCreatorFilterByDataset,
        [datasetId]: creator,
      };
    },
    [datasetId],
  );

  // ── Ratings ───────────────────────────────────────────────────────────────

  /**
   * The id list, as a stable string key.
   *
   * `documents` is a fresh array on every splice, so depending on it directly would refetch the batch
   * aggregate on every keystroke of an inline rename. The separator is an escape rather than the
   * literal control byte it used to be: a raw NUL in a source file is invisible to `git status` and
   * to a `grep` that skips binary files, so it survives every gate and only shows in a diff stat.
   */
  const documentIdKey = useMemo(
    () => [...new Set(documents.map((document) => document.id))].sort().join("\u0000"),
    [documents],
  );
  const ratedDocumentIds = useMemo(
    () => (documentIdKey ? documentIdKey.split("\u0000") : []),
    [documentIdKey],
  );
  const ratingAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!datasetId || ratedDocumentIds.length === 0) return;
    ratingAbortRef.current?.abort();
    const abort = new AbortController();
    ratingAbortRef.current = abort;
    setRatingsLoading(true);
    setRatingError(null);
    // One batch call for the page rather than one per row — `document_review_state_v` is a view over
    // all of them.
    api
      .listRatingAggregates(ratedDocumentIds.slice(0, 200), abort.signal)
      .then((aggregates) => {
        if (abort.signal.aborted) return;
        const byDocument = Object.fromEntries(
          aggregates.map((aggregate) => [aggregate.documentId, aggregate]),
        );
        uniScenarioListCache.ratingAggregatesByDataset = {
          ...uniScenarioListCache.ratingAggregatesByDataset,
          [datasetId]: byDocument,
        };
        setRatingAggregates(byDocument);
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted || (failure as { name?: string } | null)?.name === "AbortError") {
          return;
        }
        setRatingError(failure instanceof Error ? failure.message : "Failed to load ratings.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setRatingsLoading(false);
      });
    return () => abort.abort();
  }, [datasetId, ratedDocumentIds]);

  const setDocumentRating = useCallback(
    async (documentId: string, rating: number) => {
      if (!datasetId || rating < 1 || rating > 5) return;
      const document = documents.find((entry) => entry.id === documentId);
      // Re-clicking your own score clears it, as in v1.
      const clearing = ratingAggregates[documentId]?.viewerScore === rating;
      setRatingSavingIds((saving) => new Set(saving).add(documentId));
      setRatingError(null);
      try {
        const aggregate = clearing
          ? await api.clearDocumentRating(documentId)
          : await api.setDocumentRating(documentId, {
              score: rating,
              // Pin WHICH revision was reviewed when the document has one. v1 structurally could not
              // record this, because `draft_json` was mutable under the rating (§6.2).
              revisionId: document?.latestRevisionId ?? null,
            });
        setRatingAggregates((current) => {
          const next = { ...current };
          if (aggregate) next[documentId] = aggregate;
          else delete next[documentId];
          uniScenarioListCache.ratingAggregatesByDataset = {
            ...uniScenarioListCache.ratingAggregatesByDataset,
            [datasetId]: next,
          };
          return next;
        });
      } catch (failure) {
        setRatingError(failure instanceof Error ? failure.message : "Failed to save rating.");
      } finally {
        setRatingSavingIds((saving) => {
          const next = new Set(saving);
          next.delete(documentId);
          return next;
        });
      }
    },
    [datasetId, documents, ratingAggregates],
  );

  return {
    tags,
    tagsLoading,
    tagError,
    ratingAggregates,
    ratingsLoading,
    ratingError,
    ratingSavingIds,
    selectedTagFilter,
    selectedCreatorFilter,
    newTagName,
    newTagColor,
    setNewTagName,
    setNewTagColor,
    createTag,
    renameTag,
    setTagColor,
    deleteTag,
    toggleDocumentTag,
    assignDocumentTag,
    selectTagFilter,
    selectCreatorFilter,
    setDocumentRating,
    clearTagError: useCallback(() => setTagError(null), []),
  };
}

function byLabel(a: UniScenarioTagDto, b: UniScenarioTagDto) {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}
