"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Square, X } from "lucide-react";

import { usePanelEdgeResize } from "../usePanelEdgeResize";

/** The width this panel had before it could be resized, and so the widest it may be. */
export const DETAILS_MAX_WIDTH = 192;
/** A quarter slimmer, which is where it opens until the author drags it. */
export const DETAILS_DEFAULT_WIDTH = Math.round(DETAILS_MAX_WIDTH * 0.75);

const EditorConfigurationBlockedContext = createContext(false);

export function EditorConfigurationBlockProvider({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}) {
  return (
    <EditorConfigurationBlockedContext.Provider value={blocked}>
      {children}
    </EditorConfigurationBlockedContext.Provider>
  );
}

/** Shared right-side details surface for every selectable editor entity. */
export function EditorDetailsPanel({
  ariaLabel,
  children,
  closeLabel = "Close details",
  closeTestId = "editor-details-close",
  headerFooter,
  height,
  id,
  maxHeight = "min(460px, calc(100vh - 128px))",
  onClose,
  onDelete,
  preview,
  previewClassName = "h-24 px-10 py-3",
  testId,
}: {
  ariaLabel: string;
  children: ReactNode;
  closeLabel?: string;
  closeTestId?: string;
  headerFooter?: ReactNode;
  /** Optional fixed panel height. Content scrolls inside this frame. */
  height?: string;
  id?: string;
  maxHeight?: string;
  onClose: () => void;
  /** Delete the entity represented by this panel when Delete or Backspace is pressed. */
  onDelete?: () => void;
  preview: ReactNode;
  previewClassName?: string;
  testId: string;
}) {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const configurationBlocked = useContext(EditorConfigurationBlockedContext);
  const { width, panelRef, separatorProps } = usePanelEdgeResize({
    storageKey: "uniscenario.editor.details-width",
    // 192 was this panel's only width, so it stays the ceiling. The default is a quarter slimmer:
    // the panel overlays the scene, and most of what it holds reads fine narrower.
    defaultWidth: DETAILS_DEFAULT_WIDTH,
    minWidth: 132,
    maxWidth: DETAILS_MAX_WIDTH,
    edge: "left",
    viewportReserve: 96,
    label: "Resize the details panel",
  });

  useEffect(() => setPortalRoot(window.document.body), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (configurationBlocked) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (
        !onDelete ||
        (event.key !== "Delete" && event.key !== "Backspace") ||
        isTextEditingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDelete();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [configurationBlocked, onClose, onDelete]);

  if (!portalRoot) return null;

  return createPortal(
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      aria-label={ariaLabel}
      className="editor-actor-details-enter fixed right-[calc(100%-100vw)] top-1/2 z-[82] flex min-w-0 -translate-y-1/2 flex-col overflow-hidden rounded-l-xl border border-r-0 border-white/15 bg-[linear-gradient(155deg,rgba(24,24,22,0.98),rgba(9,9,9,0.98))] text-white shadow-[-12px_20px_60px_rgba(0,0,0,0.62),0_0_0_1px_rgba(232,224,68,0.1)] backdrop-blur-2xl"
      data-placement="right-centered"
      data-size="compact"
      data-testid={testId}
      id={id}
      role="dialog"
      aria-disabled={configurationBlocked}
      style={{ height, maxHeight, width }}
    >
      {/*
        The panel is docked to the right edge, so its left edge is the only one the author can
        reach. Sits just inside the border, over the scroll area rather than beside it, because
        there is no room to spare at this width.
      */}
      <div
        {...separatorProps}
        className="absolute bottom-0 left-0 top-0 z-[60] w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[#E8E044]/40 focus-visible:bg-[#E8E044]/60 focus-visible:outline-none"
        data-testid="editor-details-resize-handle"
      />
      <header className="relative shrink-0 overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_75%_15%,rgba(232,224,68,0.14),transparent_42%),linear-gradient(145deg,#191a18,#0d0e0d)]">
        <div className={`grid place-items-center bg-black/15 ${previewClassName}`}>
          {preview}
        </div>
        {headerFooter}
        <button
          aria-label={closeLabel}
          className="absolute right-2.5 top-2.5 grid size-6 place-items-center rounded-md text-white/45 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
          data-testid={closeTestId}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-3 text-[11px] [scrollbar-width:thin]">
        {children}
      </div>
      {configurationBlocked ? (
        <div
          className="absolute inset-0 z-50 grid place-items-center bg-black/70 px-5 text-center backdrop-blur-md"
          data-testid="editor-details-simulation-blocker"
          role="status"
        >
          <div className="flex flex-col items-center gap-2">
            <Square aria-hidden="true" className="size-5 fill-[#E8E044] text-[#E8E044]" />
            <strong className="text-xs leading-snug text-white">
              Cancel simulation first to configure
            </strong>
            <span className="text-[10px] text-white/55">Press Esc to cancel simulation.</span>
          </div>
        </div>
      ) : null}
    </aside>,
    portalRoot,
  );
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target instanceof HTMLElement && target.isContentEditable ||
    Boolean(target.closest('[contenteditable]:not([contenteditable="false"])'))
  );
}
