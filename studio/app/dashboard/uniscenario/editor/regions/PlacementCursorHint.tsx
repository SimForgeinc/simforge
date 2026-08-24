"use client";

import { useEffect, useState, type RefObject } from "react";
import { MousePointer2, TriangleAlert } from "lucide-react";
import type { EditorState } from "@simforge/editor";

interface CursorPoint {
  x: number;
  y: number;
}

/** Quiet, map-local placement guidance. The controller remains placement authority. */
export function PlacementCursorHint({
  state,
  hostRef,
  canvas,
}: {
  state: EditorState | null;
  hostRef: RefObject<HTMLDivElement | null>;
  canvas?: HTMLCanvasElement | null;
}) {
  const [point, setPoint] = useState<CursorPoint | null>(null);

  useEffect(() => {
    const target = canvas ?? hostRef.current?.querySelector("canvas");
    if (!target) return;
    const onPointerMove = (event: PointerEvent) => {
      setPoint({
        x: Math.min(event.clientX + 16, window.innerWidth - 224),
        y: Math.min(event.clientY + 18, window.innerHeight - 74),
      });
    };
    target.addEventListener("pointermove", onPointerMove);
    return () => target.removeEventListener("pointermove", onPointerMove);
  }, [canvas, hostRef]);

  if (!state || state.mode !== "placing") return null;

  const ready = state.valid;
  const warning = state.placementWarning;
  const detail = warning ?? (ready
    ? state.snapped && state.laneLabel
      ? state.laneLabel
      : "Free placement"
    : "Move onto a valid surface");
  const Icon = warning ? TriangleAlert : MousePointer2;

  return (
    <div
      className={`pointer-events-none fixed z-[70] flex min-w-[188px] max-w-[320px] items-center gap-2 border px-3 py-2 backdrop-blur-xl ${
        warning
          ? "border-amber-300/80 bg-amber-400/25 text-amber-50 shadow-[0_10px_36px_rgba(251,191,36,.22)]"
          : "border-white/10 bg-black/70 text-white shadow-[0_10px_32px_rgba(0,0,0,.22)]"
      }`}
      data-placement-valid={String(ready)}
      data-placement-warning={String(Boolean(warning))}
      data-testid="placement-cursor-hint"
      role="status"
      aria-live="polite"
      style={point ? { left: point.x, top: point.y } : { left: 76, bottom: 24 }}
    >
      <Icon
        aria-hidden="true"
        className={warning || !ready ? "size-4 shrink-0 text-amber-300" : "size-4 shrink-0 text-sky-300"}
      />
      <span className="min-w-0">
        <strong className={`block text-[11px] font-medium leading-tight ${warning ? "text-amber-50" : ""}`}>
          {warning ? "Route warning · click to place anyway" : ready ? "Click to place" : "Placement armed"}
        </strong>
        <span className={`block max-w-[280px] text-[9px] leading-snug ${warning ? "text-amber-100/85" : "text-white/65"}`}>
          {detail}{warning ? " Interactions may not work properly on this road." : ""} · Esc cancel
        </span>
      </span>
    </div>
  );
}
