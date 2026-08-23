"use client";

import { useCallback } from "react";
import {
  ensureUniScenarioRevision,
  saveUniScenarioDocument,
} from "@/app/lib/uniscenario/editor/api";
import { getBrowserRecordingRevisionInputClient } from "@/app/lib/uniscenario/recording-client";
import { RenderWorkspace } from "./RenderWorkspace";
import { useOptionalUniScenarioSession } from "../../scene/UniScenarioSessionContext";

/**
 * The one entry point into the render workspace, for every route that opens it.
 *
 * There is no freeze step. Opening this pane is a read: it lists the document's renders across every
 * snapshot and configures the next one against the draft the author is looking at. The snapshot is
 * taken by the render itself, at submit time, through `ensureSnapshot` — which is the only moment
 * the scenario actually needs to be immutable, because that is what the worker executes and what the
 * author later reverts to.
 *
 * This used to gate the whole pane behind a "Freeze revision for recording" button. That existed
 * because freezing needs deterministic traffic evidence (`prepareRevisionEvidence`) which only a
 * live browser session can produce — a real precondition, but one that belongs to submitting a
 * render, not to looking at the ones that already exist.
 *
 * `initialRevisionId` still pins the pane to one immutable snapshot when history is opened directly.
 */
export function DocumentRenderWorkspace({
  documentId,
  documentTitle,
  expectedDraftVersion,
  initialRevisionId = null,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  documentId: string | null;
  documentTitle: string | null;
  expectedDraftVersion?: number | null;
  /** Known immutable history target. When present, the pane shows that snapshot's renders. */
  initialRevisionId?: string | null;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while one render or the create form is open, which claim the pane's full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const scenarioSession = useOptionalUniScenarioSession();

  /**
   * Freeze the open draft into an immutable snapshot and return its id.
   *
   * Idempotent per draft version: `ensureUniScenarioRevision` reuses the snapshot already frozen
   * from this draft, so two renders of an unedited scenario share one snapshot instead of minting a
   * duplicate. Rendering, editing a single actor, and rendering again produces two.
   */
  const ensureSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!documentId) {
        throw new Error("Open a saved scenario before creating a render.");
      }
      if (!scenarioSession) {
        throw new Error("Open this scenario from its dataset before creating a render.");
      }
      const evidence = await scenarioSession.prepareRevisionEvidence(documentId);
      const result = await ensureUniScenarioRevision({
        documentId,
        expectedDraftVersion,
        ...evidence,
        signal,
      });
      return result.revisionId;
    },
    [documentId, expectedDraftVersion, scenarioSession],
  );

  /**
   * Restore a render's snapshot over the open draft.
   *
   * Deliberately an ordinary document write rather than a bespoke endpoint: the snapshot's content
   * is saved as the draft's content under the draft's own optimistic version, so a revert is an
   * edit like any other — it bumps the draft version, it can be rendered again, and it can itself
   * be reverted by restoring a different render. Handing the result to `updateDocument` is what
   * moves the open editor and the world onto the restored scenario.
   */
  const restoreSnapshot = useCallback(
    async (revisionId: string) => {
      const current = scenarioSession?.document;
      if (!current) {
        throw new Error("Open this scenario in its editor before restoring a render's setup.");
      }
      const snapshot = await getBrowserRecordingRevisionInputClient(revisionId);
      const updated = await saveUniScenarioDocument(current, snapshot.content);
      scenarioSession.updateDocument(updated);
    },
    [scenarioSession],
  );

  if (!documentId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a saved scenario to open its render workspace.
      </div>
    );
  }
  return (
    <RenderWorkspace
      revisionId={initialRevisionId}
      documentId={documentId}
      documentTitle={documentTitle}
      currentContent={scenarioSession?.document?.content ?? null}
      currentContentSha256={scenarioSession?.document?.contentSha256 ?? null}
      onRestoreSnapshot={restoreSnapshot}
      ensureSnapshot={ensureSnapshot}
      onClose={onClose}
      onRenderActivityChange={onRenderActivityChange}
      onImmersiveChange={onImmersiveChange}
    />
  );
}
