"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useAnchoredPopoverPosition } from "@/app/lib/scenario/editor/anchored-popover";

const FORM_CARD_WIDTH = 420;
const FORM_CARD_MAX_HEIGHT = 560;

/** V1 floating-card chrome shared by v2 interaction and signal editors. */
export function AnchoredEditorPopover({
  anchorSelector,
  children,
  kind,
  kicker,
  title,
  onClose,
  id,
}: {
  anchorSelector: string;
  children: ReactNode;
  kind: "interaction" | "signal";
  kicker: string;
  title: string;
  onClose: () => void;
  id?: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const pointerRef = useRef<HTMLSpanElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  useEffect(() => setPortalRoot(window.document.body), []);

  const { anchorVisible, placement } = useAnchoredPopoverPosition({
    anchorSelector,
    panelRef,
    pointerRef,
    preferredWidth: FORM_CARD_WIDTH,
    maxPreferredHeight: FORM_CARD_MAX_HEIGHT,
    minimumUsefulHeight: 220,
    heightMode: "content",
    onClippedAnchor: "pin",
    placeWithinSelector: '[data-testid="scenario-editor-canvas-region"]',
    observe: { mutations: true, resize: true },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (panelRef.current?.contains(target)) return;
      // Timeline anchors own switching/toggling. Portalled controls spawned by
      // the card are part of the card even though they are not descendants.
      if (
        target.closest(
          [
            "[data-timeline-interaction-id]",
            "[data-timeline-signal-cycle]",
            "[data-radix-popper-content-wrapper]",
            "[role='menu']",
            "[role='listbox']",
            "[role='dialog']",
          ].join(","),
        )
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  if (!portalRoot) return null;

  return createPortal(
    <aside
      ref={panelRef}
      aria-label={`${title} editor`}
      className={`pointer-events-auto fixed z-[81] flex max-h-[560px] flex-col overflow-visible rounded-xl border border-[#E8E044]/80 bg-[linear-gradient(155deg,#111111_0%,#090909_58%,#0d0d0d_100%)] text-white shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_0_1px_rgba(232,224,68,0.12)] ${
        placement?.side === "right"
          ? "editor-actor-popover-enter-right"
          : placement?.side === "below"
            ? "editor-actor-popover-enter-below"
            : "editor-actor-popover-enter-above"
      }`}
      data-anchor-visible={String(anchorVisible)}
      data-detail-layout={`${kind}-popover`}
      data-detail-width="popover"
      data-testid={`scenario-${kind}-popover`}
      data-scenario-editor-popover={kind}
      id={id}
      role="dialog"
      style={
        placement
          ? {
              left: 0,
              maxHeight: placement.maxHeight,
              top: 0,
              transformOrigin:
                placement.side === "right"
                  ? `left ${placement.pointerTop}px`
                  : `${placement.pointerLeft}px ${placement.side === "above" ? "bottom" : "top"}`,
              translate: `${placement.left}px ${placement.top}px`,
              width: placement.width,
            }
          : {
              left: "50%",
              maxHeight: "min(560px, calc(100vh - 32px))",
              top: 16,
              transform: "translateX(-50%)",
              width: "min(420px, calc(100vw - 32px))",
            }
      }
    >
      <span
        ref={pointerRef}
        aria-hidden="true"
        className={`pointer-events-none absolute z-20 size-5 rotate-45 bg-[#0d0d0d] ${anchorVisible ? "" : "hidden"}`}
        data-testid="editor-popover-pointer"
      />
      <header className="flex min-h-[52px] shrink-0 items-center gap-3 overflow-hidden rounded-t-[10px] border-b border-white/10 bg-[linear-gradient(180deg,#171717_0%,#111111_100%)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase leading-none tracking-[0.18em] text-[#E8E044]">
            {kicker}
          </p>
          <p className="mt-1 truncate text-sm font-semibold leading-none text-white">
            {title}
          </p>
        </div>
        <button
          aria-label={`Close ${kind} editor`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          data-testid={`${kind}-popover-close`}
          type="button"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-b-[11px] bg-[#0d0d0d] p-4 [scrollbar-width:thin]">
        {children}
      </div>
    </aside>,
    portalRoot,
  );
}
