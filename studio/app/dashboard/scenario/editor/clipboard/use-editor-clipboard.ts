"use client";

/** Ctrl/Command+C and Ctrl/Command+V actor clipboard integration. */

import { useEffect } from "react";
import type { EditorController, EditorDocument } from "@simforge-oss/editor";
import {
  buildClipboardPayload,
  executePaste,
  parseClipboardPayload,
  pastePlacementActors,
} from "./actor-clipboard";
import { EditorShortcutRegistry } from "../editor-shortcuts";

export function useEditorClipboard({
  controller,
  editorDocument,
  sourceMapId,
  documentId,
  active,
  onNotice,
}: {
  controller: EditorController | null;
  editorDocument: EditorDocument | null;
  sourceMapId: string;
  documentId: string | null;
  active: boolean;
  onNotice: (notice: string) => void;
}): void {
  useEffect(() => {
    if (!controller || !editorDocument || !active) return;
    const registry = new EditorShortcutRegistry();

    registry.register({
      combo: "mod+c",
      handler: () => {
        if (!controller.canAuthor) return false;
        if ((window.getSelection()?.toString().length ?? 0) > 0) return false;
        const actors = controller.state.selection
          .map((id) => editorDocument.actor(id))
          .filter((actor): actor is NonNullable<typeof actor> => actor !== undefined);
        if (actors.length === 0) return false;
        const payload = buildClipboardPayload({
          actors,
          interactions: editorDocument.data.choreography.interactions,
          sourceMapId,
          sourceDocumentId: documentId,
        });
        if (!payload) return false;
        void navigator.clipboard
          .writeText(JSON.stringify(payload))
          .then(() => onNotice(`Copied ${actors.length} actor${actors.length === 1 ? "" : "s"}`))
          .catch(() => onNotice("Clipboard unavailable — copy blocked by the browser"));
        return true;
      },
    });

    registry.register({
      combo: "mod+v",
      handler: () => {
        if (!controller.canAuthor) return false;
        void navigator.clipboard
          .readText()
          .then((text) => {
            const payload = parseClipboardPayload(text);
            if (!payload) {
              onNotice("Clipboard has no scenario actors");
              return;
            }
            const armed = controller.beginGroupPlacement(
              pastePlacementActors(payload),
              (placements) => {
                const result = executePaste({
                  controller,
                  document: editorDocument,
                  payload,
                  placements,
                });
                const parts = [`Pasted ${result.ids.length} actor${result.ids.length === 1 ? "" : "s"}`];
                if (result.unanchored > 0) parts.push(`${result.unanchored} unanchored`);
                onNotice(parts.join(" — "));
              },
            );
            if (armed) {
              onNotice(`Move ${payload.actors.length === 1 ? "actor" : `${payload.actors.length} actors`} · click to place · Esc cancel`);
            }
          })
          .catch(() => onNotice("Clipboard unavailable — allow clipboard access to paste"));
        return true;
      },
    });

    return registry.attach(window);
  }, [active, controller, documentId, editorDocument, onNotice, sourceMapId]);
}
