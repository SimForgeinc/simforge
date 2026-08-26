"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  ScenarioDatasetDto,
  ScenarioDocumentSummaryDto,
} from "@/app/lib/scenario/contracts";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ActorRenderer } from "@simforge-oss/viewer";
import { useSetPageTitle } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import { CopyableErrorMessage } from "./list/CopyableErrorMessage";
import { MetadataDetailsDialog } from "./list/MetadataDetailsDialog";
import { NewDatasetDialog } from "./list/NewDatasetDialog";
import { ResizablePanel } from "./ResizablePanel";
import { ScenarioDatasetDetailClient } from "./[datasetId]/ScenarioDatasetDetailClient";
import { ScenarioEditorClient } from "./editor/ScenarioEditorClient";
import { DatasetRenderPane } from "./render/DatasetRenderPane";
import { ScenarioDatasetRail } from "./rail/ScenarioDatasetRail";
import { ScenarioIdleScene } from "./scene/ScenarioIdleScene";
import { useScenarioSession } from "./scene/useScenarioSession";
import { ScenarioSessionProvider } from "./scene/ScenarioSessionContext";
import {
  ScenarioWorldHost,
  type ScenarioWorldState,
  type ScenarioWorldTarget,
} from "./scene/ScenarioWorldHost";
import * as api from "./list/api";
import { ScenarioNameConflict } from "./list/api";
import { scenarioListCache } from "./list/scenarioListCache";
import {
  hydrateScenarioViewStateFromStorage,
  persistScenarioViewState,
} from "./list/scenarioViewState";
import { runDatasetMorph } from "./list/datasetMorph";

/** Shared width key for the floating dataset/scenario sidebar. */
const SCENARIO_LIST_WIDTH_KEY = "uniscenario.scenario-list-width.v2";

type EditDraft = { id: string; name: string; description: string };
type FailedOperation = "load" | "create" | "save" | "delete";
type DatasetRightPaneMode = "map" | "render";
type RenderTarget = Pick<
  ScenarioDocumentSummaryDto,
  "id" | "title" | "latestRevisionId"
>;

function datasetHref(datasetId: string) {
  return `/dashboard/scenario/${encodeURIComponent(datasetId)}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The dataset index.
 *
 * Replaces the 45-line grid that fetched in a bare `useEffect` with no `AbortController`, refetched
 * the whole list after every create, and showed `itemCount` — the count of pinned revision×render-job
 * pairs, which reads 0 for every dataset until someone pins one.
 *
 * `initialDatasets` is the house pattern (§5.6): the server component reads and seeds, the client
 * splices its own mutations locally, and nothing refetches after a mutation. The prop is optional
 * only because `dashboard/scenario/page.tsx` does not pass it yet — when it is absent this falls
 * back to an aborted client fetch, which is strictly worse and is meant to go away.
 */
export function ScenarioDatasetsClient({
  initialDatasets,
}: {
  initialDatasets?: ScenarioDatasetDto[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeQuery = searchParams.toString();
  const internallyWrittenQueryRef = useRef<string | null>(null);
  const [datasets, setDatasets] = useState<ScenarioDatasetDto[] | null>(
    () =>
      initialDatasets ??
      (scenarioListCache.datasetsLoaded
        ? scenarioListCache.datasets
        : null),
  );
  const [newDatasetOpen, setNewDatasetOpen] = useState(false);
  const [newDatasetName, setNewDatasetName] = useState("");
  const [newDatasetError, setNewDatasetError] = useState<string | null>(null);
  const [creatingDataset, setCreatingDataset] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busyDatasetId, setBusyDatasetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedOperation, setFailedOperation] =
    useState<FailedOperation | null>(null);
  const failedDatasetIdRef = useRef<string | null>(null);
  const viewStateHydratedRef = useRef(false);

  // The scenario list reads its highlighted row from this same cache. Hydrate
  // it here as well so the world preview and the row restore one identity.
  if (!viewStateHydratedRef.current) {
    viewStateHydratedRef.current = true;
    hydrateScenarioViewStateFromStorage();
  }

  /**
   * Which dataset the sidebar is showing, if any. `null` is the dataset list.
   *
   * Opening a dataset swaps the rail's contents rather than navigating. The world scene beside it is
   * mounted outside this switch, so it survives: a route change would dispose the WebGL context and
   * re-stream the whole city just to change what the 264px column lists.
   */
  const [openDatasetId, setOpenDatasetId] = useState<string | null>(null);

  /**
   * The document open in the editor, if any — the v2 equivalent of v1's `?pane=editor`.
   *
   * v1 kept the list and the editor as two modes of one mounted surface. Holding this in state rather
   * than routing to `/scenario/editor` is what keeps the pencil a toggle instead of a one-way trip.
   */
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [previewDocumentId, setPreviewDocumentId] = useState<string | null>(
    null,
  );
  const [datasetRightPaneMode, setDatasetRightPaneMode] =
    useState<DatasetRightPaneMode>("map");
  const [renderTarget, setRenderTarget] = useState<RenderTarget | null>(null);
  const [renderWorkLive, setRenderWorkLive] = useState(false);
  const [renderCompletionGeneration, setRenderCompletionGeneration] = useState(0);
  // The render pane asks for the whole width when it opens one render or the create form. The list
  // slides out rather than unmounting, so returning to the gallery restores it without a refetch.
  const [renderImmersive, setRenderImmersive] = useState(false);
  const renderActivityRef = useRef<{ activityKey: string; live: boolean } | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [actorRenderer, setActorRenderer] = useState<ActorRenderer | null>(
    null,
  );
  const [worldTarget, setWorldTarget] = useState<ScenarioWorldTarget | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>({
    target: null,
    loadedMapVersionId: null,
    streaming: false,
    error: null,
  });
  const scenarioSession = useScenarioSession({
    documentId: previewDocumentId,
    listPresentationActive: !openDocumentId,
    viewer,
    actorRenderer,
    loadedMapVersionId: worldState.loadedMapVersionId,
  });
  const pendingInitialWorldTarget = worldTarget === null
    && !scenarioSession.failed
    && (
      scenarioSession.maps === null
      || (
        scenarioSession.map === null
        && scenarioSession.maps.some((candidate) => Boolean(candidate.browserManifestUrl))
        && !scenarioSession.message?.startsWith("Preview unavailable")
      )
    );
  const setPlaybackInspecting = scenarioSession.playback.setInspecting;
  const openDatasetName = datasets?.find((dataset) => dataset.id === openDatasetId)?.name;
  useSetPageTitle(openDocumentId ? "Editor" : openDatasetId ? openDatasetName ?? "Dataset" : "Dataset");

  // Idle preview and editor chrome are two controllers for one permanently mounted world. They publish
  // only resolved map targets; mode changes themselves never clear or swap the target. Returning the
  // existing object for the same immutable map version also keeps downstream transition effects
  // completely quiet. Preview and authoring APIs can expose different URL forms for that same version.
  const retainWorldTarget = useCallback((next: ScenarioWorldTarget) => {
    setWorldTarget((current) =>
      current?.mapVersionId === next.mapVersionId
        ? current
        : next,
    );
  }, []);
  const handleRenderActivityChange = useCallback(
    (activityKey: string, live: boolean) => {
      const previous = renderActivityRef.current;
      if (!live && previous?.live && previous.activityKey !== activityKey) {
        // The previous render target is still live but its pane no longer owns
        // progress. Keep readiness polling rather than allowing stale badges.
        return;
      }
      if (previous?.live && previous.activityKey === activityKey && !live) {
        setRenderCompletionGeneration((generation) => generation + 1);
      }
      renderActivityRef.current = { activityKey, live };
      setRenderWorkLive(live);
    },
    [],
  );

  const replaceWorkspaceUrl = useCallback((url: URL) => {
    internallyWrittenQueryRef.current = url.searchParams.toString();
    window.history.replaceState(null, "", url);
  }, []);

  const openDocument = useCallback(
    (documentId: string | null) => {
      runDatasetMorph(() => {
        setOpenDocumentId(documentId);
        setPlaybackInspecting(false);
        if (documentId) {
          // Keep the row preview warm while the editor owns the viewer. On exit it can
          // reattach immediately without refetching the document or changing maps.
          setPreviewDocumentId(documentId);
          setDatasetRightPaneMode("map");
          setRenderTarget(null);
        }
        const url = new URL(window.location.href);
        if (documentId) {
          url.searchParams.set("document", documentId);
          url.searchParams.delete("preview");
          url.searchParams.delete("pane");
        } else url.searchParams.delete("document");
        replaceWorkspaceUrl(url);
      });
    },
    [replaceWorkspaceUrl, setPlaybackInspecting],
  );

  const previewDocument = useCallback((documentId: string | null) => {
    setPreviewDocumentId((current) => {
      if (current !== documentId) setEditorReady(false);
      return documentId;
    });
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    const url = new URL(window.location.href);
    if (documentId) {
      url.searchParams.set("preview", documentId);
      url.searchParams.delete("document");
    } else url.searchParams.delete("preview");
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  const revealEditor = useCallback(() => {
    runDatasetMorph(() => setEditorReady(true));
  }, []);

  const toggleRenderPane = useCallback(
    (document: RenderTarget) => {
      const closing =
        datasetRightPaneMode === "render" && renderTarget?.id === document.id;
      const nextMode: DatasetRightPaneMode = closing ? "map" : "render";
      setDatasetRightPaneMode(nextMode);
      setRenderTarget(closing ? null : document);
      // A different scenario starts at its own gallery, never inside the previous one's theater.
      setRenderImmersive(false);
      setPreviewDocumentId(document.id);
      setOpenDocumentId(null);

      const url = new URL(window.location.href);
      url.searchParams.set("preview", document.id);
      url.searchParams.delete("document");
      if (nextMode === "render") url.searchParams.set("pane", "render");
      else url.searchParams.delete("pane");
      replaceWorkspaceUrl(url);
    },
    [datasetRightPaneMode, renderTarget?.id, replaceWorkspaceUrl],
  );

  const closeRenderPane = useCallback(() => {
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    setRenderImmersive(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  const openDataset = useCallback((datasetId: string | null) => {
    const rememberedDocumentId = datasetId
      ? (scenarioListCache.selectedDocumentIdByDataset[datasetId] ?? null)
      : null;
    setOpenDatasetId(datasetId);
    setEditorReady(false);
    setPreviewDocumentId(rememberedDocumentId);
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    setRenderImmersive(false);
    renderActivityRef.current = null;
    setRenderWorkLive(false);
    // Keep the URL honest without handing the navigation to the router: `router.push` would re-run the
    // server component and remount the scene, which is the thing this whole arrangement avoids. A
    // `replaceState` leaves a reloadable, copyable URL and no history entry per dataset browsed.
    const url = new URL(window.location.href);
    if (datasetId) url.searchParams.set("dataset", datasetId);
    else url.searchParams.delete("dataset");
    if (rememberedDocumentId) url.searchParams.set("preview", rememberedDocumentId);
    else url.searchParams.delete("preview");
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  // Keep mounted workspace state aligned with soft navigation. The app switcher
  // links back to the clean datasets URL without remounting this client, so a
  // one-time read leaves a stale editor or map chooser covering the list.
  useEffect(() => {
    if (internallyWrittenQueryRef.current === routeQuery) {
      internallyWrittenQueryRef.current = null;
      return;
    }
    internallyWrittenQueryRef.current = null;
    const params = new URLSearchParams(routeQuery);
    const dataset = params.get("dataset");
    setOpenDatasetId(dataset);
    // Only meaningful with a dataset: the editor needs both to resolve a document.
    const renderPaneRequested = params.get("pane") === "render";
    const requestedDocument = dataset ? params.get("document") : null;
    const document = renderPaneRequested ? null : requestedDocument;
    setOpenDocumentId(document);
    const preview = dataset
      ? params.get("preview")
        ?? (renderPaneRequested ? requestedDocument : null)
        ?? scenarioListCache.selectedDocumentIdByDataset[dataset]
        ?? null
      : null;
    setPreviewDocumentId(document ?? preview);
    if (dataset && !document && preview && renderPaneRequested) {
      setDatasetRightPaneMode("render");
      const cachedDocument = scenarioListCache.documentsByDataset[dataset]?.find(
        (candidate) => candidate.id === preview,
      );
      // A warm list cache carries the immutable revision identity, so reopening render history is
      // read-free. A cold reload carries only identity and lets `DatasetRenderPane` resolve it.
      // `?revision=` pins one immutable revision explicitly: the browser-render worker arrives with
      // the queued job's revision and must never record the document's newer head.
      setRenderTarget({
        id: preview,
        title: cachedDocument?.title ?? "",
        latestRevisionId: params.get("revision") ?? cachedDocument?.latestRevisionId ?? null,
      });
    } else {
      setDatasetRightPaneMode("map");
      setRenderTarget(null);
    }
  }, [routeQuery]);

  const publish = useCallback((next: ScenarioDatasetDto[]) => {
    scenarioListCache.datasets = next;
    scenarioListCache.datasetsLoaded = true;
    setDatasets(next);
  }, []);

  useEffect(() => {
    if (!initialDatasets) return;
    scenarioListCache.datasets = initialDatasets;
    scenarioListCache.datasetsLoaded = true;
  }, [initialDatasets]);

  const loadDatasets = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api.listDatasets(signal);
        if (signal?.aborted) return;
        publish(next);
        setError(null);
        setFailedOperation(null);
      } catch (loadError) {
        if (
          signal?.aborted ||
          (loadError as { name?: string } | null)?.name === "AbortError"
        ) {
          return;
        }
        setError(errorMessage(loadError, "Failed to load datasets."));
        setFailedOperation("load");
      }
    },
    [publish],
  );

  useEffect(() => {
    if (initialDatasets || scenarioListCache.datasetsLoaded) return;
    const abort = new AbortController();
    void loadDatasets(abort.signal);
    return () => abort.abort();
  }, [initialDatasets, loadDatasets]);

  const orderedDatasets = useMemo(() => {
    // Workspace-owned datasets first, shared and system datasets after — so the default view is the
    // user's own work, not the templates.
    const rank = (dataset: ScenarioDatasetDto) =>
      dataset.visibility === "workspace" && !dataset.isSystemManaged ? 0 : 1;
    return [...(datasets ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [datasets]);

  const createDataset = useCallback(async () => {
    const name = newDatasetName.trim();
    if (!name) return;
    setCreatingDataset(true);
    setNewDatasetError(null);
    setError(null);
    setFailedOperation(null);
    try {
      const created = await api.createDataset({ name });
      publish([created, ...(datasets ?? [])]);
      setNewDatasetName("");
      setNewDatasetOpen(false);
    } catch (createError) {
      // A name collision belongs in the dialog, beside the field the user has to change; the
      // constraint is not partial, so a soft-deleted dataset still holds its name. Anything else is a
      // page-level failure with a retry.
      if (createError instanceof ScenarioNameConflict) {
        setNewDatasetError(createError.message);
      } else {
        setError(errorMessage(createError, "Failed to create dataset."));
        setFailedOperation("create");
      }
    } finally {
      setCreatingDataset(false);
    }
  }, [datasets, newDatasetName, publish]);

  const saveDatasetDetails = useCallback(async () => {
    if (!editDraft) return;
    const name = editDraft.name.trim();
    if (!name) return;
    const description = editDraft.description.trim();
    setBusyDatasetId(editDraft.id);
    setEditError(null);
    setError(null);
    setFailedOperation(null);
    try {
      const updated = await api.updateDataset(editDraft.id, {
        name,
        description: description || null,
      });
      publish(
        (datasets ?? []).map((dataset) =>
          dataset.id === updated.id ? updated : dataset,
        ),
      );
      setEditDraft(null);
    } catch (updateError) {
      if (updateError instanceof ScenarioNameConflict) {
        setEditError(updateError.message);
      } else {
        setError(
          errorMessage(updateError, "Failed to update dataset details."),
        );
        setFailedOperation("save");
        failedDatasetIdRef.current = editDraft.id;
      }
    } finally {
      setBusyDatasetId(null);
    }
  }, [datasets, editDraft, publish]);

  const deleteDataset = useCallback(
    async (dataset: ScenarioDatasetDto) => {
      if (
        !window.confirm(
          `Delete "${dataset.name}"? This removes the dataset and its scenarios.`,
        )
      ) {
        return;
      }
      setBusyDatasetId(dataset.id);
      setError(null);
      setFailedOperation(null);
      try {
        await api.deleteDataset(dataset.id);
        publish((datasets ?? []).filter((item) => item.id !== dataset.id));
        // The dataset's cached document page would otherwise outlive it and re-seed a list for a
        // dataset that no longer exists.
        delete scenarioListCache.documentsByDataset[dataset.id];
        delete scenarioListCache.pendingDocumentsByDataset[dataset.id];
        scenarioListCache.loadedDatasetIds.delete(dataset.id);
        if (scenarioListCache.selectedDatasetId === dataset.id) {
          scenarioListCache.selectedDatasetId = null;
          persistScenarioViewState();
        }
      } catch (deleteError) {
        setError(errorMessage(deleteError, "Failed to delete dataset."));
        setFailedOperation("delete");
        failedDatasetIdRef.current = dataset.id;
      } finally {
        setBusyDatasetId(null);
      }
    },
    [datasets, publish],
  );

  const retryFailedOperation = useCallback(() => {
    if (failedOperation === "load") void loadDatasets();
    if (failedOperation === "create") void createDataset();
    if (failedOperation === "save") void saveDatasetDetails();
    if (failedOperation === "delete" && failedDatasetIdRef.current) {
      const dataset = (datasets ?? []).find(
        (item) => item.id === failedDatasetIdRef.current,
      );
      if (dataset) void deleteDataset(dataset);
    }
  }, [
    createDataset,
    datasets,
    deleteDataset,
    failedOperation,
    loadDatasets,
    saveDatasetDetails,
  ]);

  // The same condition that mounts `DatasetRenderPane` below, hoisted because the world behind the
  // pane has to react to it too.
  const renderPaneOpen = Boolean(
    openDatasetId && datasetRightPaneMode === "render" && renderTarget,
  );

  return (
    <ScenarioSessionProvider session={scenarioSession}>
    <section
      className="relative h-full min-h-0 overflow-hidden bg-background text-foreground"
      data-testid="scenario-dataset-index"
      data-workspace-mode={openDocumentId ? "editor" : datasetRightPaneMode}
    >
      {/* The render tab is a reading surface: a gallery of finished renders and, over it, the
          decisions that make a new one. The live world behind it is context, not the subject, and at
          full opacity a moving scene competed with the step the author was on. Blurring the host
          itself rather than relying only on the pane's own `backdrop-blur` keeps the scene soft
          across the whole surface — including the region the collapsed scenario list leaves behind —
          and `scale` hides the transparent edge a filter samples in from outside the canvas. */}
      <ScenarioWorldHost
        className={`absolute inset-0 z-0 render-surface-motion ${
          renderPaneOpen ? "scale-[1.02] blur-[14px]" : ""
        }`}
        target={worldTarget}
        pendingTarget={pendingInitialWorldTarget}
        interactive={Boolean(openDatasetId || openDocumentId)}
        onViewerChange={setViewer}
        onActorRendererChange={setActorRenderer}
        onStateChange={setWorldState}
      />

      {/* Keep this complete subtree mounted while editing. It remains visible while the editor prepares
          behind it, then the chrome morph swaps without replacing the persistent world. */}
      <div
        className={`pointer-events-none relative z-10 flex h-full min-h-0 w-full flex-row ${
          openDocumentId ? "invisible pointer-events-none" : ""
        }`}
        aria-hidden={openDocumentId ? "true" : undefined}
        data-testid="scenario-list-session"
      >
        <ResizablePanel
          storageKey={SCENARIO_LIST_WIDTH_KEY}
          label={`Resize the ${openDatasetId ? "scenario" : "dataset"} list`}
          variant="blur-gradient"
          collapsed={renderImmersive}
          className="pointer-events-auto h-full"
        >
          {openDatasetId ? (
            // The same left-side gradient owns both list states, so opening a dataset does not move the
            // panel or remount the world beneath it.
            <ScenarioDatasetDetailClient
              datasetId={openDatasetId}
              onBack={() => openDataset(null)}
              onEditDocument={(document) => openDocument(document.id)}
              onPreviewDocument={(document) => previewDocument(document.id)}
              onExitEdit={() => openDocument(null)}
              onRenderDocument={(document) => toggleRenderPane(document)}
              editActiveDocumentId={openDocumentId}
              renderActiveDocumentId={
                datasetRightPaneMode === "render"
                  ? (renderTarget?.id ?? null)
                  : null
              }
              renderWorkLive={renderWorkLive}
              renderCompletionGeneration={renderCompletionGeneration}
            />
          ) : (
            <ScenarioDatasetRail
              datasets={orderedDatasets}
              loading={datasets === null}
              error={null}
              creating={creatingDataset}
              busyDatasetId={busyDatasetId}
              activeDatasetId={openDatasetId}
              onSelectDataset={openDataset}
              onPrefetchDataset={(datasetId) =>
                router.prefetch(datasetHref(datasetId))
              }
              onOpenNewDatasetDialog={() => {
                setError(null);
                setNewDatasetError(null);
                setNewDatasetOpen(true);
              }}
              onEditDatasetDetails={(dataset) => {
                setError(null);
                setEditError(null);
                setEditDraft({
                  id: dataset.id,
                  name: dataset.name,
                  description: dataset.description ?? "",
                });
              }}
              onDeleteDataset={(dataset) => void deleteDataset(dataset)}
            />
          )}
        </ResizablePanel>

        <div className="pointer-events-none relative min-w-0 flex-1">
          <ScenarioIdleScene
            className="absolute inset-0"
            documentId={previewDocumentId ?? undefined}
            active={!openDocumentId}
            lockedTour={!openDatasetId}
            viewer={viewer}
            actorRenderer={actorRenderer}
            worldState={worldState}
            onWorldTargetChange={retainWorldTarget}
            session={scenarioSession}
          />
          {renderPaneOpen && renderTarget ? (
            <div className="pointer-events-auto">
              <DatasetRenderPane
                documentId={renderTarget.id}
                initialDocumentTitle={renderTarget.title || null}
                initialRevisionId={renderTarget.latestRevisionId}
                resolveDocument={!renderTarget.title}
                onClose={closeRenderPane}
                onRenderActivityChange={handleRenderActivityChange}
                onImmersiveChange={setRenderImmersive}
              />
            </div>
          ) : null}
          {/* Errors float over the scene rather than sitting in the rail: a failed delete belongs next to
            nothing in particular, and the rail is 220px wide — too narrow for a message plus a retry. */}
          {error ? (
            <div className="pointer-events-auto absolute inset-x-4 top-4 flex items-center gap-2 border border-border bg-card/95 p-2 shadow-xl backdrop-blur">
              <CopyableErrorMessage
                message={error}
                className="min-w-0 flex-1"
              />
              {failedOperation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={retryFailedOperation}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <NewDatasetDialog
          open={newDatasetOpen}
          name={newDatasetName}
          busy={creatingDataset}
          error={newDatasetError}
          onNameChange={setNewDatasetName}
          onClose={() => {
            if (creatingDataset) return;
            setNewDatasetOpen(false);
            setNewDatasetName("");
            setNewDatasetError(null);
          }}
          onSubmit={() => void createDataset()}
        />
        <MetadataDetailsDialog
          open={Boolean(editDraft)}
          title="Edit dataset details"
          intro="Update the name and description shown to scenario operators."
          name={editDraft?.name ?? ""}
          description={editDraft?.description ?? ""}
          busy={Boolean(editDraft && busyDatasetId === editDraft.id)}
          error={editError}
          namePlaceholder="Dataset name"
          descriptionPlaceholder="Dataset description"
          submitLabel="Save dataset"
          onNameChange={(name) =>
            setEditDraft((current) =>
              current ? { ...current, name } : current,
            )
          }
          onDescriptionChange={(description) =>
            setEditDraft((current) =>
              current ? { ...current, description } : current,
            )
          }
          onClose={() => {
            if (busyDatasetId) return;
            setEditDraft(null);
            setEditError(null);
          }}
          onSubmit={() => void saveDatasetDetails()}
        />
      </div>

      {openDatasetId
      && previewDocumentId
      && scenarioSession.document?.id === previewDocumentId
      && scenarioSession.maps ? (
        <div
          aria-busy={openDocumentId && !editorReady ? true : undefined}
          className={`pointer-events-none absolute inset-0 z-20 ${
            openDocumentId
              ? editorReady
                ? "editor-mode-main-enter visible opacity-100"
                : "visible opacity-100"
              : "invisible opacity-0"
          }`}
          data-editor-ready={String(editorReady)}
          data-testid="scenario-editor-session"
        >
          <ScenarioEditorClient
            key={scenarioSession.document.id}
            datasetId={openDatasetId}
            initialDocumentId={scenarioSession.document.id}
            onExitToList={() => openDocument(null)}
            injectedViewer={viewer}
            sharedActorRenderer={actorRenderer}
            active={Boolean(openDocumentId)}
            loadedMapVersionId={worldState.loadedMapVersionId}
            onWorldTargetChange={retainWorldTarget}
            onWorkspaceReady={revealEditor}
            initialDocument={scenarioSession.document}
            initialMaps={scenarioSession.maps}
            sharedPlayback={scenarioSession.playback}
            onSessionDocumentChange={scenarioSession.updateDocument}
          />
        </div>
      ) : null}
    </section>
    </ScenarioSessionProvider>
  );
}
