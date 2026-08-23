"use client";

import type {
  EditorController,
  EditorDocument,
} from "@simforge/editor";

/**
 * HOST SLOT — assistant / copilot. Manifest section 11.
 *
 * Port into this file the assistant surface from
 * the retired editor implementation.
 *
 * The assistant edits the scenario, so it must go through `controller` and
 * `document` — the same mutation path a human click takes. Anything that writes
 * scenario state by another route escapes undo, gesture grouping and validation,
 * and will silently diverge from what gets exported.
 *
 * Rendered as a `fixed` right-hand overlay at the surface level. Rendering and
 * recording stay in the scenario list, so this is the editor's only right-edge
 * product slot.
 */
export function AssistantChatSlot(_props: {
  controller: EditorController | null;
  document: EditorDocument | null;
}) {
  return null;
}
