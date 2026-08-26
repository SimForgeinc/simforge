"use client";

/**
 * Bulk operations for a multi-selection.
 *
 * The single-actor inspector deliberately stays closed while more than one
 * actor is selected — its numeric pose fields have no meaning for a set — so
 * this compact panel carries the set-level facts (count, unanchored count)
 * and the bulk verbs: duplicate, delete, clear.
 */

import { Copy, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/app/components/ui/button";
import {
  isRoadBoundMotorVehicle,
  type EditorController,
  type EditorState,
} from "@simforge-oss/editor";

export function MultiSelectionPanel({
  controller,
  state,
}: {
  controller: EditorController | null;
  state: EditorState;
}) {
  const count = state.selection.length;
  const unanchored = useMemo(() => {
    const selected = new Set(state.selection);
    return state.actors.filter(
      (actor) => selected.has(actor.id) && !actor.static && !actor.laneRef
        && isRoadBoundMotorVehicle(actor.catalogId),
    );
  }, [state.actors, state.selection]);

  if (count < 2) return null;
  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border/70 bg-black/85 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-md"
      data-testid="multi-selection-panel"
    >
      <span className="font-semibold" data-testid="multi-selection-count">
        {count} selected
      </span>
      {unanchored.length > 0 ? (
        <Button
          className="h-7 border-amber-300/70 text-amber-200 hover:text-amber-100"
          data-testid="multi-selection-resnap"
          onClick={() => controller?.resnapToLane(unanchored.map((actor) => actor.id))}
          size="sm"
          variant="outline"
        >
          Re-snap {unanchored.length} unanchored
        </Button>
      ) : null}
      <Button
        className="h-7"
        data-testid="multi-selection-duplicate"
        onClick={() => controller?.duplicateSelection()}
        size="sm"
        variant="outline"
      >
        <Copy aria-hidden="true" />
        Duplicate
      </Button>
      <Button
        className="h-7"
        data-testid="multi-selection-delete"
        onClick={() => controller?.deleteSelection()}
        size="sm"
        variant="outline"
      >
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
      <Button
        aria-label="Clear selection"
        className="h-7 w-7 p-0"
        data-testid="multi-selection-clear"
        onClick={() => controller?.setSelection([])}
        size="sm"
        variant="ghost"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
