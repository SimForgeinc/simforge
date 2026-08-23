"use client";

import {
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";

import type {
  EditorController,
  EditorDocument,
} from "@uniscenarios/editor-core";
import { ActorDetailsPanel } from "./ActorDetailsPanel";
import { InteractionActionPopover } from "./InteractionActionPopover";
import { useEditorOverlay } from "./editor-overlay-selection";

/**
 * Resolves the semantic selection against the live EditorDocument and mounts
 * exactly one floating editor. Deletion cleanup is driven by the document's
 * existing subscription; no shadow entity state is retained here.
 */
export function EditorOverlayHost({
  controller,
  document,
  onConfigureCustomRoute,
  showActorMotionControls = true,
}: {
  controller: EditorController | null;
  document: EditorDocument | null;
  onConfigureCustomRoute?: (interactionId: string) => void;
  showActorMotionControls?: boolean;
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

  if (selection.kind === "actor" && actor) {
    return (
      <ActorDetailsPanel
        actor={actor}
        controller={controller}
        document={document}
        onClose={actions.clear}
        showMotionControls={showActorMotionControls}
      />
    );
  }

  if (selection.kind === "interaction" && interaction) {
    return (
      <InteractionActionPopover
        document={document}
        interaction={interaction}
        onConfigureCustomRoute={onConfigureCustomRoute}
        onClose={actions.clear}
      />
    );
  }
  return null;
}
