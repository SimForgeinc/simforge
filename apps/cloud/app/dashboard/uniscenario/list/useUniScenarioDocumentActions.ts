"use client";

import { useCallback, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { TemplateDocument } from "@uniscenarios/scenario-model";
import {
  DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID,
  UNISCENARIO_SCHEMA_VERSION,
  type UniScenarioDocumentSummaryDto,
} from "@/app/lib/uniscenario/contracts";
import * as api from "./api";
import { UniScenarioVersionConflict } from "./api";
import {
  buildDocumentTransferFile,
  documentJsonFilename,
  downloadDocumentJson,
  readDocumentTransferFile,
  UniScenarioImportError,
} from "./document-json-transfer";
import { documentName, documentSummaryFromDocument } from "./document-list-utils";
import type { UniScenarioMapOption } from "./document-map-groups";
import { uniScenarioListCache } from "./uniScenarioListCache";
import { rememberUniScenarioSelection } from "./uniScenarioViewState";
import { reconcileTemplateMapIdentity } from "@/app/lib/uniscenario/map-identity";
import {
  localSceneMinutes,
  withSceneMinutes,
} from "@/app/dashboard/uniscenario/editor/scene-time";

const APP_VERSION = "0.1.0-editor";

type DetailsDraft = { id: string; name: string; description: string };

export type UniScenarioDocumentActionsResult = {
  busyDocumentId: string | null;
  renamingDocumentId: string | null;
  renameDraft: string;
  creatingDocument: boolean;
  importingDocument: boolean;
  mapPickerOpen: boolean;
  detailsDraft: DetailsDraft | null;
  detailsError: string | null;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  setRenamingDocumentId: (id: string | null) => void;
  setRenameDraft: (next: string) => void;
  setMapPickerOpen: (open: boolean) => void;
  setDetailsDraft: React.Dispatch<React.SetStateAction<DetailsDraft | null>>;
  createDocumentOnMap: (map: UniScenarioMapOption) => Promise<void>;
  commitRename: (
    document: UniScenarioDocumentSummaryDto,
    nextTitle: string,
  ) => Promise<void>;
  duplicateDocument: (document: UniScenarioDocumentSummaryDto) => Promise<void>;
  deleteDocument: (document: UniScenarioDocumentSummaryDto) => Promise<void>;
  downloadDocument: (document: UniScenarioDocumentSummaryDto) => Promise<void>;
  handleImportFile: (event: ChangeEvent<HTMLInputElement>) => void;
  startEditDetails: (document: UniScenarioDocumentSummaryDto) => void;
  closeDetailsDialog: () => void;
  saveDetails: () => Promise<void>;
};

/**
 * Document create, rename, duplicate, delete, and JSON in/out.
 *
 * Everything here applies its result to the list locally through `spliceDocument`/`removeDocument`
 * and never refetches (§5.6). On a failed mutation the caller's list is untouched — the splice
 * happens on success, so there is nothing to roll back — except in `commitRename`, which splices
 * ahead of the response and therefore restores the previous title itself.
 *
 * OpenSCENARIO import is not here: it is an explicit drop (§0.5 D1). "Import Scenario JSON" reads
 * `ScenarioTemplateV2` only.
 */
export function useUniScenarioDocumentActions({
  datasetId,
  maps,
  reportError,
  spliceDocument,
  removeDocument,
  onOpenDocument,
}: {
  datasetId: string | null;
  maps: ReadonlyArray<UniScenarioMapOption>;
  reportError: (error: unknown, fallback: string) => void;
  spliceDocument: (next: UniScenarioDocumentSummaryDto) => void;
  removeDocument: (documentId: string) => void;
  /** Navigate into the editor for a document — `?datasetId=…&documentId=…`. */
  onOpenDocument: (
    datasetId: string,
    documentId: string,
    document?: UniScenarioDocumentSummaryDto,
  ) => void;
}): UniScenarioDocumentActionsResult {
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [importingDocument, setImportingDocument] = useState(false);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const trackPending = useCallback((id: string, summary: UniScenarioDocumentSummaryDto) => {
    uniScenarioListCache.pendingDocumentsByDataset = {
      ...uniScenarioListCache.pendingDocumentsByDataset,
      [id]: [summary, ...(uniScenarioListCache.pendingDocumentsByDataset[id] ?? [])],
    };
  }, []);

  /**
   * Create a document from a blank template bound to the chosen map.
   *
   * `TemplateDocument.create` is the same constructor the editor uses for a fresh scenario, and the
   * `setClip` that follows is the same one, so a document created from the list and one created in
   * the editor are byte-identical at t=0 — which matters because `content_sha256` is computed over
   * exactly this. Without it they were not: the schema default warmup is 5 seconds and the editor
   * zeroes it, so a scenario made from the list simulated 25 seconds to record 20 while the same
   * scenario made in the editor ran 20, and the two hashed differently.
   *
   * Clip length is left at the schema's 20 seconds. Warmup is the settling time before recording
   * starts, and an author who asked for a 20-second scenario means 20 seconds.
   */
  const createDocumentOnMap = useCallback(
    async (map: UniScenarioMapOption) => {
      if (!datasetId) return;
      setMapPickerOpen(false);
      setCreatingDocument(true);
      try {
        const template = TemplateDocument.create({
          name: `${map.label} scenario`,
          sourceMap: { mapId: map.sourceMapId, mapName: map.label },
          anchor: { features: [], pin: { mapId: map.sourceMapId } },
          appVersion: APP_VERSION,
        });
        template.setClip(undefined, 0);
        const content = {
          ...template.data,
          environment: withSceneMinutes(template.data.environment, localSceneMinutes()),
        };
        const created = await api.createDocument({
          title: template.data.meta.name,
          schemaVersion: UNISCENARIO_SCHEMA_VERSION,
          content,
          mapVersionId: map.mapVersionId,
          datasetId,
          authoringQualityId: DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID,
        });
        const summary = documentSummaryFromDocument(created);
        trackPending(datasetId, summary);
        spliceDocument(summary);
        rememberUniScenarioSelection(datasetId, created.id);
        onOpenDocument(datasetId, created.id, summary);
      } catch (createError) {
        reportError(createError, "Failed to create scenario.");
      } finally {
        setCreatingDocument(false);
      }
    },
    [datasetId, onOpenDocument, reportError, spliceDocument, trackPending],
  );

  /**
   * Inline rename.
   *
   * Sends `expectedVersion`, which the route requires. On a 409 the server's current document comes
   * back in the error, so the row is rebased onto it rather than being left showing a title the
   * server rejected — no lock, no TTL, and it works across tabs (§6.7.2).
   */
  const commitRename = useCallback(
    async (document: UniScenarioDocumentSummaryDto, nextTitle: string) => {
      const trimmed = nextTitle.trim();
      const current = documentName(document);
      if (!trimmed || trimmed === current) return;
      setBusyDocumentId(document.id);
      // Splice ahead of the response: a rename is the one action where the round trip is long enough
      // for the old title to read as "it didn't work".
      spliceDocument({ ...document, title: trimmed });
      try {
        const latest = await api.getDocument(document.id);
        const updated = await api.updateDocument(document.id, {
          expectedVersion: latest.draftVersion,
          title: trimmed,
        });
        spliceDocument({ ...document, title: updated.title, updatedAt: updated.updatedAt });
      } catch (renameError) {
        if (renameError instanceof UniScenarioVersionConflict) {
          spliceDocument({
            ...document,
            title: renameError.current.title,
            updatedAt: renameError.current.updatedAt,
          });
          reportError(renameError, "This scenario changed in another tab.");
        } else {
          spliceDocument(document);
          reportError(renameError, "Failed to rename scenario.");
        }
      } finally {
        setBusyDocumentId(null);
      }
    },
    [reportError, spliceDocument],
  );

  /**
   * Duplicate.
   *
   * The copy is its own document with `derivation_kind='copy'` and a parent pointer, never a revision
   * of the original (§6.4). The title suffix is "Copy", which the route caps at 200 chars — v1's
   * "Name (copy)" flow had no unique constraint to collide with; documents still have none, so no
   * collision handling is needed here, unlike datasets.
   */
  const duplicateDocument = useCallback(
    async (document: UniScenarioDocumentSummaryDto) => {
      setBusyDocumentId(document.id);
      try {
        const created = await api.duplicateDocument(document.id);
        const summary = {
          ...documentSummaryFromDocument(created),
          derivationKind: "copy" as const,
          derivedFromDocumentId: document.id,
        };
        trackPending(created.datasetId, summary);
        spliceDocument(summary);
        rememberUniScenarioSelection(created.datasetId, created.id);
      } catch (duplicateError) {
        reportError(duplicateError, "Failed to duplicate scenario.");
      } finally {
        setBusyDocumentId(null);
      }
    },
    [reportError, spliceDocument, trackPending],
  );

  const deleteDocument = useCallback(
    async (document: UniScenarioDocumentSummaryDto) => {
      if (!window.confirm(`Delete "${documentName(document)}"?`)) return;
      setBusyDocumentId(document.id);
      try {
        await api.deleteDocument(document.id);
        removeDocument(document.id);
      } catch (deleteError) {
        reportError(deleteError, "Failed to delete scenario.");
      } finally {
        setBusyDocumentId(null);
      }
    },
    [removeDocument, reportError],
  );

  /**
   * Download the document as JSON.
   *
   * This is the one row action that needs the full document: the summary projection deliberately
   * carries no `content`, so the file has to come from `GET /documents/[id]`.
   */
  const downloadDocument = useCallback(
    async (document: UniScenarioDocumentSummaryDto) => {
      setBusyDocumentId(document.id);
      try {
        const full = await api.getDocument(document.id);
        downloadDocumentJson(
          buildDocumentTransferFile({
            title: full.title,
            mapVersionId: full.mapVersionId,
            content: full.content,
          }),
          documentJsonFilename(full.title),
        );
      } catch (downloadError) {
        reportError(downloadError, "Failed to download scenario JSON.");
      } finally {
        setBusyDocumentId(null);
      }
    },
    [reportError],
  );

  const importDocument = useCallback(
    async (file: File) => {
      if (!datasetId) return;
      setImportingDocument(true);
      try {
        const parsed = readDocumentTransferFile(JSON.parse(await file.text()));
        // The file's own map id is advisory: it is workspace-scoped, so a document imported into a
        // workspace that cannot see it would be bound to a map it can never load.
        // A canonical source asset may have multiple immutable derivative map
        // versions. Only the wrapper's exact mapVersionId can select one; a
        // bare template's sourceMap.mapId is intentionally never guessed.
        const map = maps.find((entry) => entry.mapVersionId === parsed.mapVersionId) ?? null;
        if (!map) {
          throw new UniScenarioImportError(
            "Scenario JSON must identify an exact published map version. Re-export it with mapVersionId or choose a map explicitly; a source map with multiple derivatives is ambiguous.",
          );
        }
        const content = reconcileTemplateMapIdentity(parsed.content, map);
        if (content.sourceMap?.mapId !== map.sourceMapId || content.anchor.pin?.mapId !== map.sourceMapId) {
          throw new UniScenarioImportError(
            "Scenario JSON is bound to a different canonical source map and cannot be silently retargeted.",
          );
        }
        const created = await api.createDocument({
          title: parsed.title,
          schemaVersion: UNISCENARIO_SCHEMA_VERSION,
          content,
          mapVersionId: map.mapVersionId,
          datasetId,
          authoringQualityId: DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID,
        });
        const summary = {
          ...documentSummaryFromDocument(created),
          derivationKind: "import" as const,
        };
        trackPending(datasetId, summary);
        spliceDocument(summary);
        rememberUniScenarioSelection(datasetId, created.id);
        onOpenDocument(datasetId, created.id, summary);
      } catch (importError) {
        reportError(importError, "Failed to import scenario JSON.");
      } finally {
        setImportingDocument(false);
      }
    },
    [datasetId, maps, onOpenDocument, reportError, spliceDocument, trackPending],
  );

  const handleImportFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0] ?? null;
      if (!file) return;
      // Clear the input either way, or picking the same file twice fires no change event.
      void importDocument(file).finally(() => {
        input.value = "";
      });
    },
    [importDocument],
  );

  const startEditDetails = useCallback((document: UniScenarioDocumentSummaryDto) => {
    setDetailsError(null);
    setDetailsDraft({
      id: document.id,
      name: documentName(document),
      description: document.description ?? "",
    });
  }, []);

  const closeDetailsDialog = useCallback(() => {
    setDetailsDraft(null);
    setDetailsError(null);
  }, []);

  /**
   * Save title and description.
   *
   * `description` is a STORED GENERATED projection of `canonical_content.meta.description` (§6.1), so
   * the route writes it through the content — there is no column to set. That is why this cannot be a
   * plain column patch and why the write must carry `expectedVersion`.
   */
  const saveDetails = useCallback(async () => {
    if (!detailsDraft) return;
    const name = detailsDraft.name.trim();
    if (!name) return;
    const description = detailsDraft.description.trim();
    setBusyDocumentId(detailsDraft.id);
    setDetailsError(null);
    try {
      const latest = await api.getDocument(detailsDraft.id);
      const updated = await api.updateDocument(detailsDraft.id, {
        expectedVersion: latest.draftVersion,
        title: name,
        description,
      });
      const existing = (
        uniScenarioListCache.documentsByDataset[updated.datasetId] ?? []
      ).find((document) => document.id === updated.id);
      spliceDocument({
        ...(existing ?? documentSummaryFromDocument(updated)),
        title: updated.title,
        description: description || null,
        updatedAt: updated.updatedAt,
      });
      setDetailsDraft(null);
    } catch (detailsSaveError) {
      setDetailsError(
        detailsSaveError instanceof Error
          ? detailsSaveError.message
          : "Failed to update scenario details.",
      );
    } finally {
      setBusyDocumentId(null);
    }
  }, [detailsDraft, spliceDocument]);

  return {
    busyDocumentId,
    renamingDocumentId,
    renameDraft,
    creatingDocument,
    importingDocument,
    mapPickerOpen,
    detailsDraft,
    detailsError,
    importInputRef,
    setRenamingDocumentId,
    setRenameDraft,
    setMapPickerOpen,
    setDetailsDraft,
    createDocumentOnMap,
    commitRename,
    duplicateDocument,
    deleteDocument,
    downloadDocument,
    handleImportFile,
    startEditDetails,
    closeDetailsDialog,
    saveDetails,
  };
}
