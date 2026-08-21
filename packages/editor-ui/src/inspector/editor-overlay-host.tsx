"use client";

import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type {
  EditorController,
  EditorDocument,
} from "@uniscenarios/editor-core";
import { useEditorOverlay } from "./editor-overlay-selection";

/** Everything a product's actor details card needs to render itself. */
export interface EditorOverlayActorContext {
  controller: EditorController | null;
  document: EditorDocument;
  actorId: string;
}

/** Everything a product's interaction popover needs to render itself. */
export interface EditorOverlayInteractionContext {
  document: EditorDocument;
  interactionId: string;
  actorId: string;
}

/**
 * Resolves the semantic selection against the live EditorDocument and mounts
 * exactly one floating editor. Deletion cleanup is driven by the document's
 * existing subscription; no shadow entity state is retained here.
 *
 * The cards themselves are product surfaces (the SimCloud actor panel carries
 * sensors, appearance, placement sections), so they arrive as render props; the
 * host owns the selection lifecycle, the revision subscription, and the
 * missing-entity cleanup that both cards share.
 */
export function EditorOverlayHost({
  controller,
  document,
  renderActorPanel,
  renderInteractionPopover,
}: {
  controller: EditorController | null;
  document: EditorDocument | null;
  renderActorPanel?: (context: EditorOverlayActorContext) => ReactNode;
  renderInteractionPopover?: (context: EditorOverlayInteractionContext) => ReactNode;
}) {
  const { selection, actions } = useEditorOverlay();
  const subscribe = useCallback(
    (listener: () => void) => document?.subscribe(listener) ?? (() => undefined),
    [document],
  );
  const getSnapshot = useCallback(() => document?.revision ?? 0, [document]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const actor =
    selection.kind === "actor" ? (document?.actor(selection.actorId) ?? null) : null;
  const interaction =
    selection.kind === "interaction"
      ? (document?.data.choreography.interactions.find(
          (candidate) => candidate.id === selection.interactionId,
        ) ?? null)
      : null;
  const missing = selection.kind === "actor"
    ? !actor
    : selection.kind === "interaction"
      ? !interaction
      : false;

  useEffect(() => {
    if (missing) actions.clear();
  }, [actions, missing]);

  if (!document || selection.kind === null || missing) return null;

  if (selection.kind === "actor" && actor && renderActorPanel) {
    return (
      <>
        {renderActorPanel({
          controller,
          document,
          actorId: selection.actorId,
        })}
      </>
    );
  }

  if (selection.kind === "interaction" && interaction && renderInteractionPopover) {
    return (
      <>
        {renderInteractionPopover({
          document,
          interactionId: selection.interactionId,
          actorId: selection.actorId,
        })}
      </>
    );
  }
  return null;
}
