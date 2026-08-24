"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Tags } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import type {
  ScenarioDatasetDto,
  ScenarioDocumentSummaryDto,
} from "@/app/lib/scenario/contracts";
import {
  TopBarActionsPortal,
  useSetPageTitle,
} from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";
import { cn } from "@/app/lib/utils";
import { CopyableErrorMessage } from "../list/CopyableErrorMessage";
import { MetadataDetailsDialog } from "../list/MetadataDetailsDialog";
import { ScenarioDocumentCreator } from "../list/ScenarioDocumentCreator";
import { ScenarioMapPickerDialog } from "../list/ScenarioMapPickerDialog";
import { ScenarioTagFilterDropdown } from "../list/ScenarioTagFilterDropdown";
import * as api from "../list/api";
import {
  documentCreatorKey,
  documentName,
  documentSummaryFromDocument,
} from "../list/document-list-utils";
import type { ScenarioMapOption } from "../list/document-map-groups";
import { scenarioListCache } from "../list/scenarioListCache";
import {
  hydrateScenarioViewStateFromStorage,
  persistScenarioViewState,
  rememberScenarioSelection,
} from "../list/scenarioViewState";
import { useScenarioDocumentActions } from "../list/useScenarioDocumentActions";
import { useScenarioDocumentList } from "../list/useScenarioDocumentList";
import { useScenarioOpenScenarioImport } from "../list/useScenarioOpenScenarioImport";
import { useScenarioTagManager } from "../list/useScenarioTagManager";

/** Readiness refresh cadence while a render is in flight, matching v1. */
const READINESS_POLL_MS = 5_000;

function editorHref(datasetId: string, documentId?: string) {
  const query = new URLSearchParams({ dataset: datasetId });
  if (documentId) query.set("document", documentId);
  return `/dashboard/scenario?${query}`;
}

function StandaloneDatasetTitle({ title }: { title: string }) {
  useSetPageTitle(title);
  return null;
}

/**
 * One dataset's document list.
 *
 * This surface did not exist in v2 at all: the editor called `listScenarioDocuments(datasetId)` and
 * took `documents[0]`, so every sibling document in a dataset was unreachable from the UI.
 *
 * `initialDataset` and `initialDocuments` are the house pattern; both are optional because the route
 * that supplies them is new and its server component may not be wired yet.
 */
export function ScenarioDatasetDetailClient({
  datasetId,
  initialDataset,
  initialDocuments,
  onBack,
  onEditDocument,
  onPreviewDocument,
  onExitEdit,
  onRenderDocument,
  editActiveDocumentId,
  renderActiveDocumentId,
  renderWorkLive,
  renderCompletionGeneration = 0,
}: {
  datasetId: string;
  initialDataset?: ScenarioDatasetDto | null;
  initialDocuments?: ScenarioDocumentSummaryDto[];
  /**
   * Overrides for mounting this list inside the datasets surface rather than on its own route.
   *
   * All optional, and every default is the standalone-route behaviour, so the `[datasetId]` page keeps
   * working untouched. When the surface supplies them, the pencil and render button switch mode in place
   * instead of navigating — a route change here would dispose the world scene beside the list.
   */
  onBack?: () => void;
  onEditDocument?: (document: ScenarioDocumentSummaryDto) => void;
  /** Select a row for world-pane preview without entering the editor. */
  onPreviewDocument?: (document: ScenarioDocumentSummaryDto) => void;
  onExitEdit?: () => void;
  onRenderDocument?: (document: ScenarioDocumentSummaryDto) => void;
  editActiveDocumentId?: string | null;
  renderActiveDocumentId?: string | null;
  /** Render job liveness from the pane that owns the job state. Omit when unavailable. */
  renderWorkLive?: boolean;
  /** Increments on a live-to-terminal transition so badges reconcile exactly once. */
  renderCompletionGeneration?: number;
}) {
  const router = useRouter();
  const hydratedRef = useRef(false);

  // Hydrate before initializing local state. The cache is module state, so a second hydrate would
  // clobber a selection the user has already made in this session.
  if (!hydratedRef.current) {
    hydratedRef.current = true;
    hydrateScenarioViewStateFromStorage();
  }

  const [dataset, setDataset] = useState<ScenarioDatasetDto | null>(
    () =>
      initialDataset ??
      scenarioListCache.datasets.find((entry) => entry.id === datasetId) ??
      null,
  );
  const [maps, setMaps] = useState<ScenarioMapOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);

  const reportError = useCallback((errorValue: unknown, fallback: string) => {
    setError(errorValue instanceof Error ? errorValue.message : fallback);
  }, []);

  const list = useScenarioDocumentList(datasetId);
  const hasReliableRenderLiveness = renderWorkLive !== undefined;
  const [readinessLoadedDatasetId, setReadinessLoadedDatasetId] = useState<string | null>(null);
  const [reconciledCompletion, setReconciledCompletion] = useState(() => ({
    datasetId,
    generation: renderCompletionGeneration,
  }));

  useEffect(() => {
    if (!initialDocuments) return;
    scenarioListCache.loadedDatasetIds.add(datasetId);
    list.setDocuments(initialDocuments);
  }, [datasetId, initialDocuments, list]);

  useEffect(() => {
    // Refetch whenever this list is the visible surface, not just on mount: the editor is where
    // documents change, so the list's copy is the one most likely to be stale, and the list stays
    // mounted-but-hidden behind the editor rather than unmounting (see ScenarioDatasetsClient).
    //
    // Concretely, a summary projected at create time reports no sensor profile — a new scenario has
    // no actors yet — and nothing re-derived it when the author fitted a sensor, so the row's render
    // affordance stayed disabled for the rest of the session. Cached and server-rendered rows are
    // the first paint, not the answer.
    //
    // This does not weaken the splice-only rule (§5.6): it fires when a dataset opens and when the
    // editor closes, both of which are single-page states, never after a rename or a tag edit, so
    // no later page can be dropped under the user.
    if (editActiveDocumentId) return;
    void list.loadFirstPage();
    // `list` is a fresh object each render; keying on the ids is what makes this fire once per
    // dataset and once per editor close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, editActiveDocumentId]);

  useEffect(() => {
    if (initialDataset) {
      setDataset(initialDataset);
      return;
    }
    const abort = new AbortController();
    void (async () => {
      try {
        const datasets = await api.listDatasets(abort.signal);
        if (abort.signal.aborted) return;
        scenarioListCache.datasets = datasets;
        scenarioListCache.datasetsLoaded = true;
        setDataset(datasets.find((entry) => entry.id === datasetId) ?? null);
      } catch (loadError) {
        if (abort.signal.aborted) return;
        reportError(loadError, "Failed to load this dataset.");
      }
    })();
    return () => abort.abort();
  }, [datasetId, initialDataset, reportError]);

  useEffect(() => {
    const abort = new AbortController();
    void api
      .listMapOptions(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setMaps(next);
      })
      .catch(() => {
        // The map catalog only gates "New Scenario"; the list itself is still usable without it.
      });
    return () => abort.abort();
  }, []);

  const tagManager = useScenarioTagManager({
    datasetId,
    documents: list.documents,
    spliceDocument: list.spliceDocument,
  });

  const actions = useScenarioDocumentActions({
    datasetId,
    maps,
    reportError,
    spliceDocument: list.spliceDocument,
    removeDocument: list.removeDocument,
    onOpenDocument: (nextDatasetId, documentId, document) => {
      if (onEditDocument && document) onEditDocument(document);
      else router.push(editorHref(nextDatasetId, documentId));
    },
  });

  // `resolveScenarioDatasetAccess` is the enforcement; this is the display hint that keeps the
  // affordances honest, derived from the same two fields (§6.5).
  const datasetEditable = Boolean(
    dataset && dataset.visibility === "workspace" && !dataset.isSystemManaged,
  );

  const creatorOptions = useMemo(() => {
    const counts = new Map<
      string,
      { value: string; label: string; count: number }
    >();
    for (const document of list.documents) {
      const creator = documentCreatorKey(document);
      if (!creator) continue;
      const current = counts.get(creator);
      counts.set(creator, {
        value: creator,
        label: creator,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [list.documents]);

  const activeTagFilter = tagManager.selectedTagFilter;
  const activeCreatorFilter = tagManager.selectedCreatorFilter;

  const visibleDocuments = useMemo(() => {
    if (!activeTagFilter && !activeCreatorFilter) return list.documents;
    return list.documents
      .filter((document) => {
        if (
          activeTagFilter &&
          !document.tags.some((tag) => tag.id === activeTagFilter)
        ) {
          return false;
        }
        if (
          activeCreatorFilter &&
          documentCreatorKey(document) !== activeCreatorFilter
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => documentName(a).localeCompare(documentName(b)));
  }, [activeCreatorFilter, activeTagFilter, list.documents]);

  const renderInProgress = renderWorkLive === true;
  const completionPending =
    hasReliableRenderLiveness &&
    reconciledCompletion.datasetId === datasetId &&
    reconciledCompletion.generation !== renderCompletionGeneration;
  const initialReadinessPending = readinessLoadedDatasetId !== datasetId;
  const pollReadiness = useCallback(async (signal: AbortSignal) => {
    const loaded = await list.loadReadiness(signal);
    if (!loaded || signal.aborted) return;
    setReadinessLoadedDatasetId(datasetId);
    if (hasReliableRenderLiveness && !renderWorkLive) {
      setReconciledCompletion({
        datasetId,
        generation: renderCompletionGeneration,
      });
    }
    // `list` is a fresh object each render; the dataset and render ownership
    // inputs are the callback's actual resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    datasetId,
    hasReliableRenderLiveness,
    renderCompletionGeneration,
    renderWorkLive,
  ]);
  // Standalone routes do not own render-job state, so they retain the existing
  // five-second polling for correctness. The integrated surface stops after
  // its initial snapshot and resumes only while its render owner reports live
  // work, with one keyed reconciliation after completion.
  useVisiblePolling(
    pollReadiness,
    READINESS_POLL_MS,
    !editActiveDocumentId &&
      list.loaded &&
      list.documents.length > 0 &&
      (!hasReliableRenderLiveness ||
        initialReadinessPending ||
        renderWorkLive === true ||
        completionPending),
    `${datasetId}:${hasReliableRenderLiveness ? renderCompletionGeneration : "unowned"}`,
  );

  const toggleTagEditor = useCallback(() => {
    setTagEditorOpen((open) => !open);
  }, []);

  const openDocument = useCallback(
    (document: ScenarioDocumentSummaryDto) => {
      rememberScenarioSelection(datasetId, document.id);
      router.push(editorHref(datasetId, document.id));
    },
    [datasetId, router],
  );

  const openScenarioImport = useScenarioOpenScenarioImport({
    datasetId,
    maps,
    onImported: (document) => {
      const summary = documentSummaryFromDocument(document);
      list.spliceDocument(summary);
      rememberScenarioSelection(datasetId, document.id);
      if (onEditDocument) onEditDocument(summary);
      else router.push(editorHref(datasetId, document.id));
    },
  });

  const selectDocument = useCallback(
    (document: ScenarioDocumentSummaryDto) => {
      rememberScenarioSelection(datasetId, document.id);
      if (onPreviewDocument) onPreviewDocument(document);
      else router.push(editorHref(datasetId, document.id));
    },
    [datasetId, onPreviewDocument, router],
  );

  const combinedError = error ?? list.error ?? tagManager.tagError;
  const showTopBarControls = !editActiveDocumentId;

  return (
    <>
      {!onBack ? (
        <StandaloneDatasetTitle title={dataset?.name ?? "Dataset"} />
      ) : null}
      {showTopBarControls ? (
        <TopBarActionsPortal>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className={cn(
                "h-8 gap-2 rounded-none border-border/80 px-3 font-[Share_Tech_Mono,IBM_Plex_Mono,monospace] text-[10px] font-bold uppercase tracking-[0.16em]",
                tagEditorOpen
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-background/70 text-foreground/75 hover:bg-muted hover:text-foreground",
              )}
              aria-pressed={tagEditorOpen}
              aria-label={tagEditorOpen ? "Close tag editor" : "Add tags"}
              onClick={toggleTagEditor}
            >
              <Tags className="size-3.5" aria-hidden="true" />
              {tagEditorOpen ? "Done Tags" : "Add Tags"}
            </Button>
            <ScenarioTagFilterDropdown
              tags={tagManager.tags}
              creatorOptions={creatorOptions}
              selectedTagFilter={tagManager.selectedTagFilter}
              selectedCreatorFilter={tagManager.selectedCreatorFilter}
              onSelectTagFilter={tagManager.selectTagFilter}
              onSelectCreatorFilter={tagManager.selectCreatorFilter}
            />
          </div>
        </TopBarActionsPortal>
      ) : null}
      <section
        className={cn(
          "flex h-full min-h-0 flex-col text-foreground",
          onBack ? "bg-transparent" : "bg-background",
        )}
        data-testid="scenario-document-index"
        data-dataset-id={datasetId}
      >
        {showTopBarControls ? (
          <header
            className="space-y-2.5 border-b border-white/15 px-3 py-3"
            data-testid="scenario-scenario-list-header"
          >
            <div className="flex min-w-0 items-start gap-2">
              {onBack ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 rounded-none bg-transparent hover:bg-transparent hover:text-primary"
                  aria-label="Back to datasets"
                  onClick={onBack}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  asChild
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 rounded-none bg-transparent hover:bg-transparent hover:text-primary"
                >
                  <Link
                    href="/dashboard/scenario"
                    aria-label="Back to datasets"
                  >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="font-meta text-micro font-bold uppercase tracking-meta-wider text-foreground">
                  Scenarios
                </h2>
                <p className="truncate text-meta text-white/75">
                  {dataset?.name ?? "Dataset"}
                </p>
              </div>
            </div>
            <p className="font-meta text-micro uppercase tracking-meta-wider text-white/70">
              {list.documents.length}{" "}
              {list.documents.length === 1 ? "scenario" : "scenarios"}
              {list.readiness ? ` · ${list.readiness.rendered} rendered` : null}
              {!datasetEditable ? " · Read-only" : null}
            </p>
            {datasetEditable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 rounded-none border-0 border-t border-white/10 bg-transparent px-0 font-[Share_Tech_Mono,IBM_Plex_Mono,monospace] text-[10px] font-bold uppercase tracking-[0.16em] text-primary hover:bg-transparent hover:text-primary/80"
                    aria-label="Add scenario"
                  >
                    {actions.creatingDocument ||
                    actions.importingDocument ||
                    openScenarioImport.busy ? (
                      <CloudActivityIndicator />
                    ) : (
                      <Plus className="size-3.5" aria-hidden="true" />
                    )}
                    Add Scenario
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[210px]">
                  <DropdownMenuItem
                    disabled={actions.creatingDocument || maps.length === 0}
                    onSelect={() => actions.setMapPickerOpen(true)}
                  >
                    New Scenario
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={actions.importingDocument}
                    onSelect={() => actions.importInputRef.current?.click()}
                  >
                    Import Scenario JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={openScenarioImport.busy}
                    onSelect={openScenarioImport.openDialog}
                  >
                    Open OpenSCENARIO as reference
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </header>
        ) : null}
        {combinedError || notice ? (
          <div className="space-y-2 border-b border-border px-4 py-2">
            {combinedError ? (
              <div className="flex items-center gap-2">
                <CopyableErrorMessage
                  message={combinedError}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    list.clearError();
                    tagManager.clearTagError();
                    void list.loadFirstPage();
                  }}
                >
                  Refresh
                </Button>
              </div>
            ) : null}
            {notice ? (
              <p
                className="font-meta text-micro uppercase tracking-meta-wider text-muted-foreground"
                role="status"
              >
                {notice}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={cn("min-h-0 flex-1 overflow-hidden")}>
          <ScenarioDocumentCreator
            datasetId={datasetId}
            datasetEditable={datasetEditable}
            documents={visibleDocuments}
            totalDocumentCount={list.documents.length}
            documentsLoading={!list.loaded || list.loading}
            documentsLoadingMore={list.loadingMore}
            hasMoreDocuments={list.hasMore}
            onLoadMoreDocuments={() => void list.loadMore()}
            availableMaps={maps}
            advancedMode
            tagEditorMode={tagEditorOpen}
            tags={tagManager.tags}
            ratingAggregates={tagManager.ratingAggregates}
            ratingsLoading={tagManager.ratingsLoading}
            ratingError={tagManager.ratingError}
            ratingSavingIds={tagManager.ratingSavingIds}
            selectedTagFilter={activeTagFilter}
            newTagName={tagManager.newTagName}
            newTagColor={tagManager.newTagColor}
            onNewTagNameChange={tagManager.setNewTagName}
            onNewTagColorChange={tagManager.setNewTagColor}
            onCreateTag={() => void tagManager.createTag()}
            onRenameTag={(tagId, label) =>
              void tagManager.renameTag(tagId, label)
            }
            onSetTagColor={(tagId, color) =>
              void tagManager.setTagColor(tagId, color)
            }
            onDeleteTag={(tagId) => void tagManager.deleteTag(tagId)}
            onSelectTagFilter={tagManager.selectTagFilter}
            onAssignTag={(documentId, tagId) =>
              void tagManager.assignDocumentTag(documentId, tagId)
            }
            onSetRating={(documentId, rating) =>
              void tagManager.setDocumentRating(documentId, rating)
            }
            onPersistViewState={persistScenarioViewState}
            activeDocumentId={
              scenarioListCache.selectedDocumentIdByDataset[datasetId] ??
              null
            }
            renderActiveDocumentId={renderActiveDocumentId ?? null}
            busyDocumentId={actions.busyDocumentId}
            renamingDocumentId={actions.renamingDocumentId}
            renameDraft={actions.renameDraft}
            renderInProgress={renderInProgress}
            onClearDraggingTag={() => {}}
            onRenameDraftChange={actions.setRenameDraft}
            onSetRenamingDocumentId={actions.setRenamingDocumentId}
            onCommitRename={(document, draft) =>
              void actions.commitRename(document, draft)
            }
            onOpenDocument={onPreviewDocument ? selectDocument : openDocument}
            onEditDocument={onEditDocument ?? openDocument}
            onExitEdit={onExitEdit}
            onRenderDocument={onRenderDocument ?? openDocument}
            editActiveDocumentId={editActiveDocumentId}
            onDownloadDocument={(document) =>
              void actions.downloadDocument(document)
            }
            onDuplicateDocument={(document) =>
              void actions.duplicateDocument(document)
            }
            onEditDetails={actions.startEditDetails}
            onDeleteDocument={(document) =>
              void actions.deleteDocument(document)
            }
            onError={reportError}
            onNotice={setNotice}
          />
        </div>

        <input
          ref={actions.importInputRef}
          aria-label="Import scenario JSON file"
          className="hidden"
          type="file"
          accept=".json,application/json"
          onChange={actions.handleImportFile}
        />
        <ScenarioMapPickerDialog
          maps={maps}
          currentMapVersionId={null}
          open={actions.mapPickerOpen}
          onOpenChange={actions.setMapPickerOpen}
          onSelectMap={(map) => void actions.createDocumentOnMap(map)}
        />
        {openScenarioImport.dialog}
        <MetadataDetailsDialog
          open={Boolean(actions.detailsDraft)}
          title="Edit scenario details"
          intro="Update the name and description shown in the dataset scenario list."
          name={actions.detailsDraft?.name ?? ""}
          description={actions.detailsDraft?.description ?? ""}
          busy={Boolean(
            actions.detailsDraft &&
            actions.busyDocumentId === actions.detailsDraft.id,
          )}
          error={actions.detailsError}
          namePlaceholder="Scenario name"
          descriptionPlaceholder="Scenario description"
          submitLabel="Save scenario"
          onNameChange={(name) =>
            actions.setDetailsDraft((current) =>
              current ? { ...current, name } : current,
            )
          }
          onDescriptionChange={(description) =>
            actions.setDetailsDraft((current) =>
              current ? { ...current, description } : current,
            )
          }
          onClose={actions.closeDetailsDialog}
          onSubmit={() => void actions.saveDetails()}
        />
      </section>
    </>
  );
}
