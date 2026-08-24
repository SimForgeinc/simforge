"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EditorDocument,
  UniScenarioMapEntry,
} from "@simforge/editor";
import type { CityViewer } from "@simforge/viewer";
import type { ActorRenderer } from "@simforge/viewer";
import { contentHash } from "@simforge/engine";
import {
  createUniScenarioDocument,
  listUniScenarioDocuments,
  listUniScenarioMaps,
  saveUniScenarioDocument,
  UNISCENARIO_SCHEMA_VERSION,
  UniScenarioVersionConflict,
  type UniScenarioDocumentRecord,
} from "@/app/lib/uniscenario/editor/api";
import { primeGalleryEntriesForDocument } from "@/app/lib/asset-gallery/editor-bridge";
import { UniScenarioEditorSurface } from "./UniScenarioEditorSurface";
import type {
  UniScenarioAuthoringQuality,
} from "@/app/lib/uniscenario/contracts";
import {
  EditorEmptyState,
  MapChooser,
} from "./states/EditorStatePanels";
import { defaultAuthoringQuality } from "./authoring-quality";
import {
  notifyUniScenario,
  useUniScenarioWorkspaceStatus,
} from "./status";
import type { UniScenarioWorldTarget } from "../scene/UniScenarioWorldHost";
import type { UniScenarioMapOption } from "../list/document-map-groups";
import { mapSupportsScenarioPreview } from "../scene/previewPolicy";
import type { UniScenarioSharedPlayback } from "../scene/useUniScenarioSession";

type SaveState = "saved" | "saving" | "dirty" | "conflict";

export function UniScenarioEditorClient({
  datasetId,
  initialDocumentId = null,
  onExitToList,
  injectedViewer,
  loadedMapVersionId,
  onWorldTargetChange,
  onWorkspaceReady,
  initialDocument,
  initialMaps,
  sharedPlayback,
  onSessionDocumentChange,
  sharedActorRenderer,
  active = true,
}: {
  datasetId: string | null;
  initialDocumentId?: string | null;
  /** Leave the editor for the scenario list, when mounted on the datasets surface. */
  onExitToList?: () => void;
  /** Already-mounted world supplied by the integrated datasets surface. */
  injectedViewer?: CityViewer | null;
  loadedMapVersionId?: string | null;
  onWorldTargetChange?: (target: UniScenarioWorldTarget) => void;
  /** Reveal editor chrome after its record and map are resolved. */
  onWorkspaceReady?: () => void;
  /** Workspace-owned record; supplying it prevents an editor-entry refetch. */
  initialDocument?: UniScenarioDocumentRecord;
  /** Workspace-owned map catalog; supplying it prevents an editor-entry refetch. */
  initialMaps?: UniScenarioMapOption[];
  sharedPlayback?: UniScenarioSharedPlayback;
  onSessionDocumentChange?: (document: UniScenarioDocumentRecord) => void;
  sharedActorRenderer?: ActorRenderer | null;
  active?: boolean;
}) {
  // No `UniScenarioWorkspaceStatusProvider` here. It is mounted once at
  // `dashboard/uniscenario/layout.tsx` so the dataset index and the review queue get the notification
  // dock and boot gate too. Re-adding it here would stack a second set of `fixed` overlays at the same
  // coordinates, painting every notification twice — see the layout's docblock.
  return (
    <UniScenarioEditorWorkspace
      datasetId={datasetId}
      initialDocumentId={initialDocumentId}
      onExitToList={onExitToList}
      injectedViewer={injectedViewer}
      loadedMapVersionId={loadedMapVersionId}
      onWorldTargetChange={onWorldTargetChange}
      onWorkspaceReady={onWorkspaceReady}
      initialDocument={initialDocument}
      initialMaps={initialMaps}
      sharedPlayback={sharedPlayback}
      onSessionDocumentChange={onSessionDocumentChange}
      sharedActorRenderer={sharedActorRenderer}
      active={active}
    />
  );
}

/**
 * The editor workspace: data loading, autosave, and the revision→export→job
 * chain.
 *
 * Boot conditions do **not** early-return a full-page panel here. They publish
 * blocking statuses, which `UniScenarioBootGate` paints as an overlay over
 * whatever is mounted. That is the whole point: every transition between
 * "loading maps", "loading documents" and "ready" used to swap the rendered tree
 * wholesale, which threw away the WebGL context, the streamed map tiles and the
 * lane index, and rebuilt all three.
 */
function UniScenarioEditorWorkspace({
  datasetId,
  initialDocumentId,
  onExitToList,
  injectedViewer,
  loadedMapVersionId,
  onWorldTargetChange,
  onWorkspaceReady,
  initialDocument,
  initialMaps,
  sharedPlayback,
  onSessionDocumentChange,
  sharedActorRenderer,
  active,
}: {
  datasetId: string | null;
  initialDocumentId: string | null;
  onExitToList?: () => void;
  injectedViewer?: CityViewer | null;
  loadedMapVersionId?: string | null;
  onWorldTargetChange?: (target: UniScenarioWorldTarget) => void;
  onWorkspaceReady?: () => void;
  initialDocument?: UniScenarioDocumentRecord;
  initialMaps?: UniScenarioMapOption[];
  sharedPlayback?: UniScenarioSharedPlayback;
  onSessionDocumentChange?: (document: UniScenarioDocumentRecord) => void;
  sharedActorRenderer?: ActorRenderer | null;
  active: boolean;
}) {
  const persistentWorkspace = injectedViewer !== undefined;
  const [maps, setMaps] = useState<UniScenarioMapEntry[] | null>(() =>
    initialMaps?.filter(mapSupportsScenarioPreview) ?? null,
  );
  const [record, setRecord] = useState<UniScenarioDocumentRecord | null>(initialDocument ?? null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<UniScenarioAuthoringQuality | null>(
    defaultAuthoringQuality,
  );
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [primedRecordId, setPrimedRecordId] = useState<string | null>(null);
  const recordRef = useRef<UniScenarioDocumentRecord | null>(null);
  const qualityRef = useRef<UniScenarioAuthoringQuality | null>(null);
  const mapRef = useRef<UniScenarioMapEntry | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDocumentRef = useRef<EditorDocument | null>(null);
  const mutationVersionRef = useRef(0);
  const documentSessionRef = useRef(0);
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const serverRecordBySessionRef = useRef(new Map<number, UniScenarioDocumentRecord | null>());
  const sharedBootRef = useRef(
    initialDocument && initialMaps ? { document: initialDocument, maps: initialMaps } : null,
  );

  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  useEffect(() => {
    if (!record?.id || primedRecordId === record.id) return;
    let current = true;
    void primeGalleryEntriesForDocument(record.content).then((unresolvedIds) => {
      if (!current) return;
      setPrimedRecordId(record.id);
      if (unresolvedIds.length) {
        notifyUniScenario({
          key: `gallery-assets-unresolved:${record.id}`,
          severity: "warning",
          source: "authoring",
          message: "Some gallery assets could not be loaded",
          detail: `The editor opened with placeholders for: ${unresolvedIds.join(", ")}`,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [primedRecordId, record]);

  useEffect(() => {
    const abort = new AbortController();
    if (!datasetId) {
      setMaps([]);
      return () => abort.abort();
    }
    const sharedBoot = sharedBootRef.current;
    if (sharedBoot) {
      const nextMaps = sharedBoot.maps.filter(mapSupportsScenarioPreview);
      setMaps(nextMaps);
      setRecord(sharedBoot.document);
      recordRef.current = sharedBoot.document;
      const session = ++documentSessionRef.current;
      serverRecordBySessionRef.current.set(session, sharedBoot.document);
      const selectedQuality = sharedBoot.document.authoringQualityId ?? defaultAuthoringQuality();
      qualityRef.current = selectedQuality;
      setQuality(selectedQuality);
      setSelectedMapId(sharedBoot.document.mapVersionId);
      return () => abort.abort();
    }
    Promise.all([
      listUniScenarioMaps(abort.signal),
      listUniScenarioDocuments(datasetId, abort.signal),
    ])
      .then(([nextMaps, nextDocuments]) => {
        setMaps(nextMaps);
        // A deep-linked `?documentId=` wins over authoring order. Falling back to
        // the first document rather than to null matters: the rail highlights
        // whatever the editor has open, and opening nothing when the dataset
        // plainly has scenarios reads as a load failure.
        const selected =
          (initialDocumentId
            ? nextDocuments.find((entry) => entry.id === initialDocumentId)
            : null) ??
          nextDocuments[0] ??
          null;
        setRecord(selected);
        recordRef.current = selected;
        const session = ++documentSessionRef.current;
        serverRecordBySessionRef.current.set(session, selected);
        const selectedQuality = selected?.authoringQualityId ?? defaultAuthoringQuality();
        qualityRef.current = selectedQuality;
        setQuality(selectedQuality);
        setSelectedMapId(selected?.mapVersionId ?? null);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string } | null)?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => abort.abort();
  }, [datasetId, initialDocumentId]);

  const pinnedMapId = record?.content?.anchor?.pin?.mapId ?? null;
  const map = maps
    ? maps.find(
        (entry) => entry.versionId === (record?.mapVersionId ?? selectedMapId),
      ) ?? (
        !record?.mapVersionId && pinnedMapId
          ? maps.find((entry) => mapIdentityMatches(entry, pinnedMapId)) ?? null
          : null
      )
    : null;
  useEffect(() => {
    mapRef.current = map;
  }, [map]);

  useEffect(() => {
    if (!map || !onWorldTargetChange) return;
    onWorldTargetChange({
      mapVersionId: map.versionId,
      manifestUrl: map.manifestUrl,
      label: map.label,
    });
  }, [map, onWorldTargetChange]);

  useEffect(() => {
    // Reveal terminal boot UI too. Requiring a resolved map here hides the map
    // chooser (and the no-compatible-maps state) behind the scenario list,
    // creating a handoff that can never complete without interacting with UI
    // the user cannot see.
    if (!datasetId || !maps || !quality) return;
    onWorkspaceReady?.();
  }, [datasetId, maps, onWorkspaceReady, quality]);

  const persist = useCallback(
    ({
      keepalive = false,
      authoringQualityId,
    }: {
      keepalive?: boolean;
      authoringQualityId?: UniScenarioAuthoringQuality;
    } = {}) => {
      const document = pendingDocumentRef.current;
      const activeMap = mapRef.current;
      const activeRecord = recordRef.current;
      const content = document?.data ?? activeRecord?.content;
      const title = document?.name ?? activeRecord?.title;
      if (!content || !title || !activeMap) return Promise.resolve();
      const session = documentSessionRef.current;
      const mutationVersion = mutationVersionRef.current;
      const selectedQuality = authoringQualityId ?? qualityRef.current ?? activeRecord?.authoringQualityId ?? quality;
      if (!selectedQuality) return Promise.resolve();
      setSaveState("saving");
      const run = async () => {
        try {
          const current = serverRecordBySessionRef.current.get(session) ?? activeRecord;
          const saved = current
            ? await saveUniScenarioDocument(
                current,
                content,
                title,
                selectedQuality,
                { keepalive },
              )
            : await createUniScenarioDocument(
                {
                  title,
                  schemaVersion: UNISCENARIO_SCHEMA_VERSION,
                  mapVersionId: activeMap.versionId,
                  datasetId: datasetId!,
                  authoringQualityId: selectedQuality,
                  content,
                },
                { keepalive },
              );
          serverRecordBySessionRef.current.set(session, saved);
          if (session !== documentSessionRef.current || mutationVersion !== mutationVersionRef.current) return;
          recordRef.current = saved;
          qualityRef.current = saved.authoringQualityId;
          setRecord(saved);
          setPrimedRecordId(saved.id);
          onSessionDocumentChange?.(saved);
          setSaveState("saved");
          setError(null);
        } catch (reason) {
          if (session !== documentSessionRef.current || mutationVersion !== mutationVersionRef.current) return;
          setSaveState(reason instanceof UniScenarioVersionConflict ? "conflict" : "dirty");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      };
      const queued = saveTailRef.current.then(run, run);
      saveTailRef.current = queued.then(() => undefined, () => undefined);
      return queued;
    },
    [datasetId, onSessionDocumentChange, quality],
  );

  const changed = useCallback(
    (document: EditorDocument) => {
      pendingDocumentRef.current = document;
      const activeRecord = recordRef.current;
      if (
        activeRecord &&
        activeRecord.title === document.name &&
        contentHash(activeRecord.content) === contentHash(document.data)
      ) {
        pendingDocumentRef.current = null;
        return;
      }
      if (activeRecord) {
        onSessionDocumentChange?.({
          ...activeRecord,
          title: document.name,
          content: document.data,
        });
      }
      mutationVersionRef.current += 1;
      setSaveState("dirty");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void persist(), 700);
    },
    [onSessionDocumentChange, persist],
  );

  /**
   * Send the debounced save now instead of waiting out the 700 ms.
   *
   * Returns whether there was anything to send, so `beforeunload` can decide
   * between prompting and staying silent.
   */
  const flush = useCallback(
    ({ keepalive = false }: { keepalive?: boolean } = {}) => {
      if (!timerRef.current) return false;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      void persist({ keepalive });
      return true;
    },
    [persist],
  );

  // `flush`'s identity changes with `datasetId`/`quality`; the unload listeners
  // and the unmount cleanup must not re-subscribe (or worse, fire) when it does.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    /**
     * Three exits, three mechanisms, because no single one covers them all:
     *
     * - `beforeunload` catches reload and tab close, and is the only place a
     *   confirmation prompt is possible. The keepalive request is already in
     *   flight by then; the prompt exists because a hard close can still win
     *   the race, and losing an author's last edits silently is the bug being
     *   fixed here.
     * - `visibilitychange` → hidden is the reliable path on mobile Safari and
     *   for tab discards, where `beforeunload` is never dispatched.
     * - unmount covers client-side navigation, where the page survives, so a
     *   plain (non-keepalive) save is enough.
     */
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!flushRef.current({ keepalive: true })) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onVisibilityChange = () => {
      if (window.document.visibilityState === "hidden") {
        flushRef.current({ keepalive: true });
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.document.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    };
  }, []);

  useEffect(() => () => void flushRef.current(), []);

  const changeQuality = useCallback(async (next: UniScenarioAuthoringQuality) => {
    setQuality(next);
    const current = recordRef.current;
    if (!current) return;
    qualityRef.current = next;
    recordRef.current = { ...current, authoringQualityId: next };
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    mutationVersionRef.current += 1;
    setSaveState("dirty");
    await persist({ authoringQualityId: next });
  }, [persist]);

  // Boot and failure conditions, published rather than rendered. Only one can be
  // blocking at a time and the gate resolves severity itself, so the order here
  // is just precedence of message, not of display.
  useUniScenarioWorkspaceStatus(
    "uniscenario-gallery-prime",
    record && primedRecordId !== record.id
      ? {
          kind: "loading",
          label: "Preparing gallery assets",
          detail: "Resolving the models referenced by this scenario…",
          blocking: true,
        }
      : null,
  );
  useUniScenarioWorkspaceStatus(
    "uniscenario-map-boot",
    !persistentWorkspace && !maps
      ? {
          kind: "loading",
          label: "Loading UniScenario Editor v2",
          detail: "Loading immutable maps and proprietary scenario documents…",
          blocking: true,
        }
      : null,
  );
  useUniScenarioWorkspaceStatus(
    "uniscenario-document-load",
    error && !maps
      ? {
          kind: "error",
          label: "UniScenario editor unavailable",
          detail: error,
          blocking: !persistentWorkspace,
          actionLabel: "Reload",
          action: () => window.location.reload(),
        }
      : null,
  );
  // A failure *after* boot is not blocking: the editor still works, and an
  // author who just lost one save must be able to keep the document they are
  // looking at rather than being locked out of it.
  useUniScenarioWorkspaceStatus(
    "uniscenario-document-save",
    error && maps
      ? {
          kind: "error",
          label:
            saveState === "conflict"
              ? "This document changed elsewhere"
              : "The last editor operation failed",
          detail: error,
          actionLabel: "Dismiss",
          action: () => setError(null),
        }
      : null,
  );
  const shell = (children: React.ReactNode) => (
    <div className="relative h-full min-h-0">{children}</div>
  );

  if (!maps) return shell(<EditorPlaceholder transparent={persistentWorkspace} />);
  if (!datasetId) {
    return shell(
      <EditorEmptyState
        title="Choose a UniScenario dataset"
        detail="Editor v2 documents always belong to the permanent UniScenario dataset domain."
        href="/dashboard/uniscenario"
        action="Open datasets"
      />,
    );
  }
  if (maps.length === 0) {
    return shell(
      <EditorEmptyState
        title="No compatible maps yet"
        detail="Publish an immutable UniScenario map version with a city manifest and topology index before authoring."
      />,
    );
  }
  if (!quality) return shell(<EditorPlaceholder />);
  if (!map)
    return shell(<MapChooser maps={maps} onChoose={setSelectedMapId} />);

  if (record && primedRecordId !== record.id) {
    return shell(<EditorPlaceholder transparent={persistentWorkspace} />);
  }
  return shell(
    <>
      <UniScenarioEditorSurface
        key={`${record?.id ?? "new"}:${map.versionId}`}
        map={map}
        record={record}
        datasetId={datasetId}
        onExitToList={onExitToList}
        injectedViewer={injectedViewer}
        loadedMapVersionId={loadedMapVersionId}
        onChanged={changed}
        quality={quality}
        onQualityChange={(next) => void changeQuality(next)}
        sharedPlayback={sharedPlayback}
        sharedActorRenderer={sharedActorRenderer}
        active={active}
      />
    </>,
  );
}

/**
 * What sits under the boot gate while the workspace has nothing to show.
 *
 * Deliberately empty and `aria-hidden`: the gate above it carries the message
 * and the live region, and a second copy would make a screen reader read the
 * boot state twice.
 */
function EditorPlaceholder({ transparent = false }: { transparent?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={
        transparent
          ? "h-full min-h-editor-shell bg-transparent"
          : "h-full min-h-editor-shell bg-background"
      }
    />
  );
}

function mapIdentityMatches(map: UniScenarioMapEntry, identity: string): boolean {
  const key = normalizedMapIdentity(identity);
  return [map.id, map.versionId, map.sourceMapId, map.label]
    .some((candidate) => normalizedMapIdentity(candidate) === key);
}

function normalizedMapIdentity(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
