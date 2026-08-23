"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A resizable width for a panel docked against one side of the viewport.
 *
 * A docked panel has exactly one free edge — the one facing the scene — and that
 * is the edge the author can drag. Which direction grows it therefore depends on
 * which side the panel is docked to: dragging right grows a left-docked panel and
 * shrinks a right-docked one.
 *
 * The gesture writes to a ref and straight to the node's style, committing to
 * React state only on release. Setting state per `pointermove` would re-render
 * the panel's whole subtree — every catalog tile, every details section — on
 * every frame of a drag, next to a live WebGL canvas. This mirrors
 * `ResizablePanel`, which learned the same lesson on the scenario list.
 */

export type PanelEdge = "left" | "right";

export function clampPanelWidth(
  value: number,
  { minWidth, maxWidth }: { minWidth: number; maxWidth: number },
): number {
  if (!Number.isFinite(value)) return maxWidth;
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

export function loadPanelWidth(
  storageKey: string,
  bounds: { minWidth: number; maxWidth: number; defaultWidth: number },
): number {
  if (typeof window === "undefined") return bounds.defaultWidth;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return bounds.defaultWidth;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return bounds.defaultWidth;
    return clampPanelWidth(parsed, bounds);
  } catch {
    return bounds.defaultWidth;
  }
}

function savePanelWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Storage blocked or full. The width still applies for this session.
  }
}

export function usePanelEdgeResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
  viewportReserve = 0,
  label,
}: {
  /** `localStorage` key for the width. Distinct keys let each panel remember its own. */
  storageKey: string;
  /** Width before the author has ever dragged this panel. */
  defaultWidth: number;
  minWidth: number;
  /** The widest the panel may get — its pre-resize width, which was its only width. */
  maxWidth: number;
  /** Which edge carries the handle: the panel's free side. */
  edge: PanelEdge;
  /** Keep this much viewport beside the panel, so it can never cover the scene entirely. */
  viewportReserve?: number;
  /** Accessible name for the drag handle, e.g. "Resize the actor details panel". */
  label: string;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const panelRef = useRef<HTMLElement | null>(null);
  const widthRef = useRef(defaultWidth);

  /**
   * The ceiling, narrowed by the viewport.
   *
   * A hard 540px panel on a 480px-wide window would be wider than the screen, so
   * the reserve wins whenever it is the tighter of the two.
   */
  const bounds = useCallback(() => {
    const room =
      typeof window === "undefined"
        ? maxWidth
        : Math.max(minWidth, window.innerWidth - viewportReserve);
    return { minWidth, maxWidth: Math.min(maxWidth, room) };
  }, [maxWidth, minWidth, viewportReserve]);

  // Read the stored width after mount, not during render: `localStorage` is unavailable on the
  // server, and seeding from it during render would make the server and client markup disagree.
  useEffect(() => {
    const stored = loadPanelWidth(storageKey, { ...bounds(), defaultWidth });
    widthRef.current = stored;
    setWidth(stored);
  }, [bounds, defaultWidth, storageKey]);

  const applyLiveWidth = useCallback((next: number) => {
    widthRef.current = next;
    const node = panelRef.current;
    if (node) node.style.width = `${next}px`;
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const handle = event.currentTarget;
      // Pointer capture keeps the drag alive when the cursor outruns the handle, which it always
      // does. Without it the gesture dies the moment the pointer crosses onto the canvas.
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        // A left-docked panel grows as the pointer moves right; a right-docked one grows as it
        // moves left, because its own edge is travelling away from the dock.
        const travel = moveEvent.clientX - startX;
        const delta = edge === "right" ? travel : -travel;
        applyLiveWidth(clampPanelWidth(startWidth + delta, bounds()));
      };
      const onEnd = () => {
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        // Commit once, on release.
        setWidth(widthRef.current);
        savePanelWidth(storageKey, widthRef.current);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [applyLiveWidth, bounds, edge, storageKey],
  );

  // Arrow keys on the separator. A pointer-only resize is unreachable without a mouse, and a
  // separator that takes focus but does nothing is worse than one that is not focusable at all.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 48 : 12;
      const limits = bounds();
      let next: number | null = null;
      const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
      const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
      if (event.key === grow) next = widthRef.current + step;
      else if (event.key === shrink) next = widthRef.current - step;
      else if (event.key === "Home") next = limits.minWidth;
      else if (event.key === "End") next = limits.maxWidth;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      const clamped = clampPanelWidth(next, limits);
      applyLiveWidth(clamped);
      setWidth(clamped);
      savePanelWidth(storageKey, clamped);
    },
    [applyLiveWidth, bounds, edge, storageKey],
  );

  return {
    width,
    panelRef,
    /** Spread onto the handle element; each panel styles its own to match its chrome. */
    separatorProps: {
      role: "separator" as const,
      "aria-label": label,
      "aria-orientation": "vertical" as const,
      "aria-valuenow": width,
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      tabIndex: 0,
      onPointerDown: startDrag,
      onKeyDown,
    },
  };
}
