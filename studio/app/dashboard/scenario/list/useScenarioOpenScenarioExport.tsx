"use client";

import { useCallback, useState } from "react";
import { Archive } from "lucide-react";
import { DropdownMenuItem } from "@/app/components/ui/dropdown-menu";
import {
  createScenarioRevision,
  downloadExportArtifact,
  waitForRevisionExport,
} from "@/app/lib/scenario/editor/api";
import * as api from "./api";
import { useOptionalScenarioSession } from "../scene/ScenarioSessionContext";

/**
 * "Export OpenSCENARIO 1.4" on a list row.
 *
 * Export is core in v2, not optional: the emitted `.xosc` is simultaneously the user-facing download
 * AND the sole execution contract the render worker replays, so this button hands back exactly the
 * artifact a render would run. Only *import* is dropped (§0.5 D1), and esmini replay with it (D4) —
 * so v1's replay menu item has no counterpart here.
 *
 * v1 POSTed to a one-shot `/export/openscenario` route that could return a 422 offering an
 * "approximated" export with per-actor fidelity diagnostics. v2 has no approximation tier: the writer
 * is XSD-validated against a digest-pinned schema, and an unrepresentable document fails the export
 * rather than silently degrading. The 422 dialog therefore has nothing to ask, and is gone.
 *
 * The three steps are the pipeline, not a wrapper: `createScenarioRevision` freezes an immutable
 * revision, `waitForRevisionExport` polls until the compiler has produced an execution package, and
 * `downloadExportArtifact` presigns the artifact per request.
 */
export function useScenarioOpenScenarioExport({
  documentId,
  onError,
  onNotice,
}: {
  documentId: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice?: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const scenarioSession = useOptionalScenarioSession();

  const exportOpenScenario = useCallback(async () => {
    setBusy(true);
    onNotice?.("Compiling OpenSCENARIO 1.4…");
    try {
      // The revision has to be taken from the document as the server currently holds it: the summary
      // row carries no `draftVersion`, and `createScenarioRevision` needs one.
      const document = await api.getDocument(documentId);
      if (!scenarioSession) {
        throw new Error("Open this scenario in its dataset before exporting it.");
      }
      const evidence = await scenarioSession.prepareRevisionEvidence(documentId);
      const created = await createScenarioRevision(document, crypto.randomUUID(), evidence);
      const exported = await waitForRevisionExport(created.revisionId, created.exportId);
      if (!exported.artifactId) {
        throw new Error("The OpenSCENARIO export finished without an artifact.");
      }
      await downloadExportArtifact(exported.artifactId);
      onNotice?.(`OpenSCENARIO 1.4 export ${exported.artifactId} is ready.`);
    } catch (exportError) {
      onNotice?.(null);
      onError(exportError, "OpenSCENARIO export failed.");
    } finally {
      setBusy(false);
    }
  }, [documentId, onError, onNotice, scenarioSession]);

  const menuItem = (
    <DropdownMenuItem disabled={busy} onSelect={() => void exportOpenScenario()}>
      <Archive className="mr-2 size-3.5" aria-hidden="true" />
      Export OpenSCENARIO
    </DropdownMenuItem>
  );

  return { busy, menuItem, exportOpenScenario };
}
