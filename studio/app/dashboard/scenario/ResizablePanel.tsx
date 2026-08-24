"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/app/lib/utils";

/**
 * A resizable left panel with a persisted width.
 *
 * The compact 375px default leaves more of the world visible than the original 500px panel. The 300-480
 * bounds still accommodate scenario metadata while keeping the list subordinate to the scene.
 *
 * The drag writes to a ref and to a CSS variable during the gesture and only commits to React state on
 * release. Setting state per `pointermove` would re-render the panel's whole subtree — the scenario list,
 * every row — on every frame of a drag, next to a live WebGL canvas.
 */

const DEFAULT_WIDTH = 375;
const MIN_WIDTH = 300;
const MAX_WIDTH = 480;

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

export function loadPanelWidth(storageKey: string): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DEFAULT_WIDTH;
    // A stored value outside the bounds is clamped rather than discarded: the bounds may have narrowed
    // since it was written, and the nearest legal width is closer to intent than the default is.
    return clampWidth(Number(stored));
  } catch {
    return DEFAULT_WIDTH;
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

export { DEFAULT_WIDTH as DEFAULT_PANEL_WIDTH, MAX_WIDTH as MAX_PANEL_WIDTH, MIN_WIDTH as MIN_PANEL_WIDTH };

export function ResizablePanel({
  storageKey,
  label,
  variant = "solid",
  collapsed = false,
  className,
  children,
}: {
  /** `localStorage` key for the width. Distinct keys let two panels remember separate widths. */
  storageKey: string;
  /** Accessible name for the drag handle, e.g. "Resize the scenario list". */
  label: string;
  /** Visual treatment for the panel background. */
  variant?: "solid" | "blur-gradient";
  /**
   * Slide the panel out to the left, yielding its width to whatever sits beside it.
   *
   * Negative margin rather than `width: 0`: the children keep their measured width and travel as a
   * block, where collapsing the width would reflow the whole scenario list on every frame of the
   * animation and reflow it back on the way in.
   */
  collapsed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(DEFAULT_WIDTH);

  // Read stored width after mount, not during render: `localStorage` is unavailable on the server, and
  // seeding from it during render would make the server and client markup disagree.
  useEffect(() => {
    const stored = loadPanelWidth(storageKey);
    widthRef.current = stored;
    setWidth(stored);
  }, [storageKey]);

  const applyLiveWidth = useCallback((next: number) => {
    widthRef.current = next;
    const node = panelRef.current;
    if (node) node.style.width = `${next}px`;
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const handle = event.currentTarget;
      // Pointer capture keeps the drag alive when the cursor outruns the 6px handle, which it always
      // does. Without it the gesture dies the moment the pointer crosses onto the canvas.
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        applyLiveWidth(clampWidth(startWidth + (moveEvent.clientX - startX)));
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
    [applyLiveWidth, storageKey],
  );

  // Arrow keys on the separator. A pointer-only resize is unreachable without a mouse, and a separator
  // that takes focus but does nothing is worse than one that is not focusable at all.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 50 : 10;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = widthRef.current - step;
      else if (event.key === "ArrowRight") next = widthRef.current + step;
      else if (event.key === "Home") next = MIN_WIDTH;
      else if (event.key === "End") next = MAX_WIDTH;
      if (next === null) return;
      event.preventDefault();
      const clamped = clampWidth(next);
      applyLiveWidth(clamped);
      setWidth(clamped);
      savePanelWidth(storageKey, clamped);
    },
    [applyLiveWidth, storageKey],
  );

  return (
    <div
      ref={panelRef}
      className={cn(
        "render-surface-motion relative flex h-full shrink-0 flex-col",
        variant === "blur-gradient"
          ? "isolate overflow-visible border-0 bg-transparent before:pointer-events-none before:absolute before:inset-y-0 before:-left-[25vw] before:w-screen before:-z-10 before:bg-[linear-gradient(75deg,rgba(5,6,8,0.76)_0%,rgba(5,6,8,0.64)_34%,rgba(5,6,8,0.32)_56%,rgba(5,6,8,0.1)_70%,transparent_82%)] before:backdrop-blur-[64px] before:[mask-image:linear-gradient(75deg,#000_0%,#000_45%,rgba(0,0,0,0.82)_60%,rgba(0,0,0,0.3)_76%,transparent_90%)] before:[-webkit-mask-image:linear-gradient(75deg,#000_0%,#000_45%,rgba(0,0,0,0.82)_60%,rgba(0,0,0,0.3)_76%,transparent_90%)] before:content-['']"
          : "border-r border-border bg-background",
        // Off-screen and inert. Focus must not survive in here, or tabbing would land the author on
        // a scenario row they cannot see.
        collapsed ? "pointer-events-none -translate-x-4 opacity-0" : null,
        className,
      )}
      style={{ width, marginLeft: collapsed ? -width : 0 }}
      data-testid="scenario-resizable-panel"
      data-panel-visual={variant}
      data-panel-collapsed={collapsed ? "true" : undefined}
      inert={collapsed ? true : undefined}
    >
      {children}
      <div
        role="separator"
        aria-label={label}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        // Sits just outside the border so it does not overlap the list's own scrollbar.
        className="absolute -right-[3px] bottom-0 top-0 z-10 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
        data-testid="scenario-panel-resize-handle"
      />
    </div>
  );
}
