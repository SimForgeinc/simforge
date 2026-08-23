"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { UniScenarioDocumentSummaryDto } from "@/app/lib/uniscenario/contracts";
import { documentEditedAtMs, documentMapLabel } from "../list/document-list-utils";
import { rememberUniScenarioSelection } from "../list/uniScenarioViewState";

/**
 * Whether a keyboard event came from somewhere that owns its own keys.
 *
 * The editor canvas and the rail share a window, and the rail's arrow keys must not steal a caret from
 * a rename input or an actor name field.
 */
function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export type UniScenarioRailNavigation = {
  /** Rail order: grouped by map, newest-edited first inside each group. */
  orderedDocuments: UniScenarioDocumentSummaryDto[];
  activeIndex: number;
  previousDocument: UniScenarioDocumentSummaryDto | null;
  nextDocument: UniScenarioDocumentSummaryDto | null;
  selectDocument: (documentId: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
};

/**
 * Rail selection, ordering, and keyboard navigation.
 *
 * `onSelect` switches the active document *in place* and is the mode the editor uses. It must not be
 * paired with a navigation: the editor surface is keyed on the document id, so a route change tears down
 * the WebGL context and re-streams the map for every scenario the reviewer steps through — once every
 * six seconds under autoplay. When `onSelect` is given, this hook never touches the router.
 *
 * The URL fallback (`?datasetId=…&documentId=…`) is for hosts mounted outside the editor, where a rail
 * click has to arrive at the editor in the first place. There selection is linkable and survives a
 * reload. `router.replace` rather than `push` when `replaceHistory` is set — an autoplay run would
 * otherwise bury the page the reviewer arrived from under one history entry per scenario.
 */
export function useUniScenarioRailNavigation({
  datasetId,
  documents,
  activeDocumentId,
  enableKeyboard = true,
  replaceHistory = false,
  onSelect,
}: {
  datasetId: string | null;
  documents: UniScenarioDocumentSummaryDto[];
  activeDocumentId: string | null;
  enableKeyboard?: boolean;
  replaceHistory?: boolean;
  onSelect?: (documentId: string) => void;
}): UniScenarioRailNavigation {
  const router = useRouter();

  const orderedDocuments = useMemo(
    () =>
      [...documents].sort(
        (a, b) =>
          documentMapLabel(a).localeCompare(documentMapLabel(b)) ||
          documentEditedAtMs(b) - documentEditedAtMs(a) ||
          a.id.localeCompare(b.id),
      ),
    [documents],
  );

  const activeIndex = orderedDocuments.findIndex((document) => document.id === activeDocumentId);

  const selectDocument = useCallback(
    (documentId: string) => {
      if (!datasetId || documentId === activeDocumentId) return;
      rememberUniScenarioSelection(datasetId, documentId);
      if (onSelect) {
        onSelect(documentId);
        return;
      }
      const query = new URLSearchParams({ dataset: datasetId, document: documentId });
      const href = `/dashboard/uniscenario?${query}`;
      if (replaceHistory) router.replace(href);
      else router.push(href);
    },
    [activeDocumentId, datasetId, onSelect, replaceHistory, router],
  );

  const previousDocument = activeIndex > 0 ? (orderedDocuments[activeIndex - 1] ?? null) : null;
  const nextDocument =
    activeIndex >= 0 && activeIndex < orderedDocuments.length - 1
      ? (orderedDocuments[activeIndex + 1] ?? null)
      : null;

  const selectPrevious = useCallback(() => {
    if (previousDocument) selectDocument(previousDocument.id);
  }, [previousDocument, selectDocument]);

  const selectNext = useCallback(() => {
    // With nothing selected, "next" means the first scenario — which is what pressing it on a fresh
    // editor mount plainly asks for.
    const target = nextDocument ?? (activeIndex < 0 ? orderedDocuments[0] : null);
    if (target) selectDocument(target.id);
  }, [activeIndex, nextDocument, orderedDocuments, selectDocument]);

  useEffect(() => {
    if (!enableKeyboard) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) return;
      // Alt-scoped so the bare arrows stay available to the canvas, which uses them for nudging.
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        selectPrevious();
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        selectNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enableKeyboard, selectNext, selectPrevious]);

  return {
    orderedDocuments,
    activeIndex,
    previousDocument,
    nextDocument,
    selectDocument,
    selectPrevious,
    selectNext,
  };
}
