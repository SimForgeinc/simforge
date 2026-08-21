"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** The only detail selection that the v2 editor UI may present. */
export type EditorOverlaySelection =
  | { kind: "actor"; actorId: string }
  | { kind: "interaction"; interactionId: string; actorId: string }
  | { kind: null };

export interface EditorOverlayActions {
  selectActor: (actorId: string) => void;
  selectInteraction: (interactionId: string, actorId: string) => void;
  clear: () => void;
}

export interface EditorOverlayController {
  selection: EditorOverlaySelection;
  actions: EditorOverlayActions;
}

const EMPTY_SELECTION: EditorOverlaySelection = { kind: null };
const EditorOverlayContext = createContext<EditorOverlayController | null>(null);

/**
 * Adapts the controller-owned actor focus to a mutually-exclusive UI selection.
 *
 * Interaction picks are presentation state only. They clear the controller's
 * actor selection so global actor shortcuts cannot act on an interaction's owner.
 * The adapter never imports or mirrors the controller/document stores.
 */
export function EditorOverlayProvider({
  children,
  documentKey,
  selectedActorId,
  suppressActorDetails = false,
  onSelectActor,
}: {
  children: ReactNode;
  /** Stable identity of the open EditorDocument. A new identity closes the card. */
  documentKey: object | string | null;
  selectedActorId: string | null;
  suppressActorDetails?: boolean;
  onSelectActor: (actorId: string | null) => void;
}) {
  const [selection, setSelection] = useState<EditorOverlaySelection>(() =>
    selectedActorId && !suppressActorDetails
      ? { kind: "actor", actorId: selectedActorId }
      : EMPTY_SELECTION,
  );
  const previousDocumentKey = useRef(documentKey);
  const routeAuthoringActorId = useRef<string | null>(null);

  useEffect(() => {
    if (previousDocumentKey.current === documentKey) return;
    previousDocumentKey.current = documentKey;
    setSelection(EMPTY_SELECTION);
    onSelectActor(null);
  }, [documentKey, onSelectActor]);

  useEffect(() => {
    setSelection((current) => {
      if (suppressActorDetails) {
        routeAuthoringActorId.current = selectedActorId;
        return EMPTY_SELECTION;
      }
      if (selectedActorId === null) {
        routeAuthoringActorId.current = null;
        return current.kind === "interaction" ? current : EMPTY_SELECTION;
      }
      if (routeAuthoringActorId.current === selectedActorId) {
        return EMPTY_SELECTION;
      }
      routeAuthoringActorId.current = null;
      // Interaction details deliberately clear controller-owned actor selection.
      // Keep the interaction card while that clear is acknowledged; an explicit
      // later actor selection still replaces it below.
      if (current.kind === "interaction" && selectedActorId === null) {
        return current;
      }
      if (
        current.kind === "actor" &&
        current.actorId === selectedActorId
      ) {
        return current;
      }
      return { kind: "actor", actorId: selectedActorId };
    });
  }, [selectedActorId, suppressActorDetails]);

  const selectActor = useCallback(
    (actorId: string) => {
      setSelection({ kind: "actor", actorId });
      onSelectActor(actorId);
    },
    [onSelectActor],
  );
  const selectInteraction = useCallback(
    (interactionId: string, actorId: string) => {
      setSelection({ kind: "interaction", interactionId, actorId });
      onSelectActor(null);
    },
    [onSelectActor],
  );
  const clear = useCallback(() => {
    setSelection(EMPTY_SELECTION);
    onSelectActor(null);
  }, [onSelectActor]);

  const value = useMemo<EditorOverlayController>(
    () => ({
      selection,
      actions: { selectActor, selectInteraction, clear },
    }),
    [clear, selectActor, selectInteraction, selection],
  );

  return (
    <EditorOverlayContext.Provider value={value}>
      {children}
    </EditorOverlayContext.Provider>
  );
}

export function useEditorOverlay(): EditorOverlayController {
  const value = useContext(EditorOverlayContext);
  if (!value) {
    throw new Error("useEditorOverlay must be used inside EditorOverlayProvider");
  }
  return value;
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function interactionTimelineAnchorSelector(interactionId: string): string {
  return `[data-timeline-interaction-id="${escapeAttributeValue(interactionId)}"]`;
}
