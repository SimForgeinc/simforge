"use client";

/**
 * HOST SLOT — in-editor dataset navigation. Manifest items 43-50.
 *
 * **The filler exists and is one line away.** `feat/scenario-list` provides
 * `app/dashboard/scenario/rail/ScenarioRailHost.tsx`, which fetches everything
 * it needs and takes exactly the props below. It is imported by nothing on that
 * branch, so until this slot renders it, the rail, its autoplay and the dataset
 * status panel are all dead code and the editor looks unchanged.
 *
 * FILLED at the merge of `feat/scenario-editor-shell` and
 * `feat/scenario-list`. The import could not be written on either branch
 * alone: the host module exists only on the list branch, so adding it to the
 * shell would have made `tsc` fail and the branch unmergeable. Joining the two
 * is an integration step by construction, which is why the shell left the
 * verified snippet here rather than the code.
 *
 * `onSelect` is the one that matters. It switches the active document *in place*;
 * the host's fallback is `router.push`, and under its six-second autoplay dwell
 * that remounts the surface, dropping the WebGL context and re-streaming the
 * whole map once every six seconds of a review run. `documentLoading` is the
 * editor's truthful scene-ready signal, so autoplay waits for the map rather than
 * advancing through half-built scenes.
 */
import { ScenarioRailHost } from "../../../rail/ScenarioRailHost";

export function ScenarioRailSlot({
  datasetId,
  activeDocumentId,
  documentLoading,
  onSelect,
  onBack,
}: {
  datasetId: string | null;
  activeDocumentId: string | null;
  /** True while the map, lane topology or document are still loading. */
  documentLoading?: boolean;
  onSelect?: (documentId: string) => void;
  /**
   * Leave the editor for the scenario list, in place.
   *
   * Only supplied when the editor is mounted on the datasets surface. There the list is unmounted while
   * the editor is open, so the row's own "Exit editor" toggle is gone — without this there is no way back
   * short of browser navigation. Absent on the standalone `/editor` route, where the rail's dataset label
   * is already a link out.
   */
  onBack?: () => void;
}) {
  return (
    <ScenarioRailHost
      datasetId={datasetId}
      activeDocumentId={activeDocumentId}
      documentLoading={documentLoading}
      onSelect={onSelect}
      onBack={onBack}
    />
  );
}
