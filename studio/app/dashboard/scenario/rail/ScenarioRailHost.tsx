"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ScenarioDatasetDto } from "@/app/lib/scenario/contracts";
import * as api from "../list/api";
import type { ScenarioMapOption } from "../list/document-map-groups";
import { scenarioListCache } from "../list/scenarioListCache";
import { ScenarioMapPickerDialog } from "../list/ScenarioMapPickerDialog";
import { useScenarioDocumentActions } from "../list/useScenarioDocumentActions";
import { ScenarioDatasetStatusPanel } from "./ScenarioDatasetStatusPanel";
import { ScenarioScenarioRail } from "./ScenarioScenarioRail";
import { useScenarioRailAutoplay } from "./useScenarioRailAutoplay";
import { useScenarioRailDocuments } from "./useScenarioRailDocuments";
import { useScenarioRailNavigation } from "./useScenarioRailNavigation";

/**
 * The one component the editor shell's `ScenarioRailSlot` mounts.
 *
 * Everything the rail needs it fetches itself, so wiring it is one line:
 *
 * ```tsx
 * <ScenarioRailSlot>
 *   <ScenarioRailHost datasetId={datasetId} activeDocumentId={documentId} onSelect={onSelect} />
 * </ScenarioRailSlot>
 * ```
 *
 * `activeDocumentId` is the slot's `activeDocumentId`. It is allowed to be null — the rail then
 * highlights nothing and "next" selects the first scenario — so the slot does not have to wait for the
 * editor to resolve a document before mounting.
 *
 * `onSelect` switches the active document *in place*, per the slot's contract: the editor surface is
 * keyed on the document id, so navigating instead would tear down the WebGL context and re-stream the
 * map for every scenario — once every six seconds under autoplay. Pass it whenever the host is inside
 * the editor. Without it the rail falls back to `?datasetId=&documentId=` navigation, which is correct
 * only for a host mounted outside the editor.
 */
export function ScenarioRailHost({
  datasetId,
  activeDocumentId,
  /** Set while the editor is still loading the selected document, so autoplay waits for it. */
  documentLoading = false,
  onSelect,
  onBack,
}: {
  datasetId: string | null;
  activeDocumentId: string | null;
  documentLoading?: boolean;
  onSelect?: (documentId: string) => void;
  /** Swap the rail back to the dataset list in place. See `ScenarioScenarioRail.onBack`. */
  onBack?: () => void;
}) {
  const router = useRouter();
  const [dataset, setDataset] = useState<ScenarioDatasetDto | null>(
    () => scenarioListCache.datasets.find((entry) => entry.id === datasetId) ?? null,
  );
  const [maps, setMaps] = useState<ScenarioMapOption[]>([]);
  const [statusOpen, setStatusOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rail = useScenarioRailDocuments(datasetId);

  useEffect(() => {
    if (!datasetId || dataset?.id === datasetId) return;
    const abort = new AbortController();
    void api
      .listDatasets(abort.signal)
      .then((datasets) => {
        if (abort.signal.aborted) return;
        scenarioListCache.datasets = datasets;
        scenarioListCache.datasetsLoaded = true;
        setDataset(datasets.find((entry) => entry.id === datasetId) ?? null);
      })
      .catch(() => {
        // The rail is still usable without the dataset row; only the header label and the
        // create affordance depend on it.
      });
    return () => abort.abort();
  }, [dataset?.id, datasetId]);

  useEffect(() => {
    const abort = new AbortController();
    void api
      .listMapOptions(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setMaps(next);
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);

  const navigation = useScenarioRailNavigation({
    datasetId,
    documents: rail.documents,
    activeDocumentId,
    // Only consulted on the navigation fallback. An autoplay run would otherwise leave one history
    // entry per scenario between the reviewer and wherever they came from.
    replaceHistory: !onSelect,
    onSelect,
  });

  const autoplay = useScenarioRailAutoplay({
    canAdvance: Boolean(navigation.nextDocument),
    onAdvance: navigation.selectNext,
    waiting: documentLoading || rail.loading,
    // Each scenario gets its own dwell; nothing else restarts the timer.
    advanceKey: activeDocumentId,
  });

  const actions = useScenarioDocumentActions({
    datasetId,
    maps,
    reportError: useCallback((errorValue: unknown, fallback: string) => {
      setError(errorValue instanceof Error ? errorValue.message : fallback);
    }, []),
    spliceDocument: rail.spliceDocument,
    removeDocument: useCallback(() => {
      // The rail has no delete affordance; deletion happens in the list.
    }, []),
    onOpenDocument: (nextDatasetId, documentId) => {
      // A scenario created from the rail belongs to the dataset already open, so hand it to the editor
      // in place. Only a cross-dataset open has to navigate.
      if (onSelect && nextDatasetId === datasetId) {
        onSelect(documentId);
        return;
      }
      const query = new URLSearchParams({ dataset: nextDatasetId, document: documentId });
      router.push(`/dashboard/scenario?${query}`);
    },
  });

  const datasetEditable = useMemo(
    () => Boolean(dataset && dataset.visibility === "workspace" && !dataset.isSystemManaged),
    [dataset],
  );

  if (!datasetId) return null;

  return (
    <>
      <div className="flex h-full min-h-0">
        <ScenarioScenarioRail
          datasetId={datasetId}
          datasetName={dataset?.name ?? null}
          documents={navigation.orderedDocuments}
          activeDocumentId={activeDocumentId}
          loading={rail.loading}
          error={error ?? rail.error}
          canCreate={datasetEditable && maps.length > 0}
          creating={actions.creatingDocument}
          autoplayPlaying={autoplay.playing}
          autoplayProgress={autoplay.progress}
          statusOpen={statusOpen}
          onSelectDocument={(documentId) => {
            // A manual pick ends the review run: the reviewer has taken over.
            autoplay.stop();
            navigation.selectDocument(documentId);
          }}
          onSelectPrevious={() => {
            autoplay.stop();
            navigation.selectPrevious();
          }}
          onSelectNext={() => {
            autoplay.stop();
            navigation.selectNext();
          }}
          onCreateDocument={() => actions.setMapPickerOpen(true)}
          onToggleAutoplay={autoplay.toggle}
          onToggleStatus={() => setStatusOpen((open) => !open)}
          onBack={onBack}
        />
        {statusOpen ? (
          <div className="w-[240px] shrink-0 overflow-y-auto border-r border-border p-2">
            <ScenarioDatasetStatusPanel
              datasetName={dataset?.name ?? null}
              readiness={scenarioListCache.readinessByDataset[datasetId] ?? null}
              documents={rail.documents}
            />
          </div>
        ) : null}
      </div>
      <ScenarioMapPickerDialog
        maps={maps}
        currentMapVersionId={null}
        open={actions.mapPickerOpen}
        onOpenChange={actions.setMapPickerOpen}
        onSelectMap={(map) => void actions.createDocumentOnMap(map)}
      />
    </>
  );
}
