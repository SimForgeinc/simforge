"use client";

import { Button } from "@/app/components/ui/button";
import type { EditorController, EditorState } from "@uniscenarios/editor-core";
import { Check, Move3d, PenLine, Trash2, X } from "lucide-react";

/**
 * OWNS: the modal-mode strip.
 *
 * Direct manipulation in this editor is modal — grab, rotate and placement each
 * capture the pointer until committed or cancelled. The banner is the only thing
 * telling the author that the next click means something different from usual,
 * so it takes the brand surface and sits in flow rather than floating: pushing
 * the canvas down is the point, not a side effect.
 */
export function EditorModeBanner({
  state,
  controller,
}: {
  state: EditorState | null;
  controller: EditorController | null;
}) {
  if (!state) return null;
  // A flash is the controller's answer to something the author just did — a refused drag,
  // a cleared anchor — so it belongs on the strip in whatever mode provoked it. Showing it
  // only when idle meant the modes that flash most were the ones that said nothing, and a
  // gesture that quietly does nothing reads as a broken editor. The standing hint comes
  // back when the message expires.
  const message = state.message;
  if (state.mode === "idle" && !message) return null;
  const warning = message?.startsWith("Warning:") ?? false;

  return (
    <div
      className={warning
        ? "flex min-h-11 shrink-0 items-center bg-amber-400 px-5 py-2 text-sm font-semibold text-black"
        : "flex min-h-11 shrink-0 items-center bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={warning ? "editor-pulse mr-2 size-2 bg-black" : "editor-pulse mr-2 size-2 bg-primary-foreground"}
      />
      {message ?? state.hint}
      {state.mode === "drawingRoute" ? (
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md bg-black/15 p-0.5">
            <Button
              aria-pressed={state.customRouteTool === "add"}
              className={state.customRouteTool === "add" ? "bg-black text-white hover:bg-black/85" : "text-primary-foreground hover:bg-primary-foreground/10"}
              onClick={() => controller?.setCustomRouteTool("add")}
              size="sm"
              variant="ghost"
            >
              <PenLine className="size-3.5" /> Add points
            </Button>
            <Button
              aria-pressed={state.customRouteTool === "move"}
              className={state.customRouteTool === "move" ? "bg-black text-white hover:bg-black/85" : "text-primary-foreground hover:bg-primary-foreground/10"}
              onClick={() => controller?.setCustomRouteTool("move")}
              size="sm"
              variant="ghost"
            >
              <Move3d className="size-3.5" /> Move points
            </Button>
          </div>
          {state.customRouteTool === "add" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={state.customRoutePointCount < 2}
              onClick={() => controller?.finishCustomRouteAuthoring()}
              className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <Check className="size-3.5" /> Finish
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={state.customRouteSelectedPointIndex === null}
              onClick={() => controller?.deleteSelectedCustomRoutePoint()}
              className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <Trash2 className="size-3.5" /> Delete point
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => controller?.cancel()}
            className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
          >
            <X className="size-3.5" /> Close
          </Button>
        </div>
      ) : null}
      {state.mode !== "idle" && state.mode !== "drawingRoute" ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => controller?.cancel()}
          className="ml-auto text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
        >
          Esc · Cancel
        </Button>
      ) : null}
    </div>
  );
}
