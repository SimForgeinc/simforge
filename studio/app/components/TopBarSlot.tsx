"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * TopBarSlot — lets individual dashboard pages inject content into the
 * shared AppTopBar without prop-drilling.
 *
 * - `useSetPageTitle(title)` replaces the default page label in the top-left chip.
 * - `<TopBarActionsPortal>` mounts React children into the top bar's center/right slot.
 *
 * Both mechanisms are opt-in. If a page uses neither, the top bar falls back
 * to the active nav item's label (e.g. "Overview", "Datasets") and an empty slot.
 */

type TopBarSlotContextValue = {
  customTitle: string | null;
  setCustomTitle: (title: string | null) => void;
  actionsAlignment: "start" | "end";
  setActionsAlignment: (alignment: "start" | "end") => void;
  actionsSlot: HTMLElement | null;
  registerActionsSlot: (el: HTMLElement | null) => void;
  trailingSlot: HTMLElement | null;
  registerTrailingSlot: (el: HTMLElement | null) => void;
};

const TopBarSlotContext = createContext<TopBarSlotContextValue | null>(null);

export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [customTitle, setCustomTitleState] = useState<string | null>(null);
  const [actionsAlignment, setActionsAlignment] = useState<"start" | "end">("end");
  const [actionsSlot, setActionsSlotState] = useState<HTMLElement | null>(null);
  const [trailingSlot, setTrailingSlotState] = useState<HTMLElement | null>(null);

  const setCustomTitle = useCallback((title: string | null) => {
    setCustomTitleState(title);
  }, []);

  const registerActionsSlot = useCallback((el: HTMLElement | null) => {
    setActionsSlotState(el);
  }, []);

  const registerTrailingSlot = useCallback((el: HTMLElement | null) => {
    setTrailingSlotState(el);
  }, []);

  return (
    <TopBarSlotContext.Provider
      value={{
        customTitle,
        setCustomTitle,
        actionsAlignment,
        setActionsAlignment,
        actionsSlot,
        registerActionsSlot,
        trailingSlot,
        registerTrailingSlot,
      }}
    >
      {children}
    </TopBarSlotContext.Provider>
  );
}

export function useTopBarSlotContext() {
  return useContext(TopBarSlotContext);
}

/** Sets a custom title for the top bar while this component is mounted. */
export function useSetPageTitle(title: string | null | undefined) {
  const ctx = useContext(TopBarSlotContext);
  // setCustomTitle is wrapped in useCallback inside the Provider so it is
  // stable across renders. Depending on `ctx` directly would re-run the
  // effect on every parent re-render (since the Provider value is a fresh
  // object literal) and the cleanup would clobber the title.
  const setCustomTitle = ctx?.setCustomTitle;
  useEffect(() => {
    if (!setCustomTitle) return;
    const next = title?.trim() ? title : null;
    setCustomTitle(next);
    return () => {
      setCustomTitle(null);
    };
  }, [setCustomTitle, title]);
}

/** Controls whether a page's action group begins beside its title or stays pinned right. */
export function useSetTopBarActionsAlignment(alignment: "start" | "end") {
  const setActionsAlignment = useContext(TopBarSlotContext)?.setActionsAlignment;
  useEffect(() => {
    if (!setActionsAlignment) return;
    setActionsAlignment(alignment);
    return () => setActionsAlignment("end");
  }, [alignment, setActionsAlignment]);
}

/** Renders its children into the top bar's action slot via a React portal. */
export function TopBarActionsPortal({ children }: { children: ReactNode }) {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx?.actionsSlot) return null;
  return createPortal(children, ctx.actionsSlot);
}

/**
 * Renders its children into the top bar's trailing slot — pinned to the far
 * right edge of the header, after the main action slot. Use for single-button
 * page-level affordances like a settings icon.
 */
export function TopBarTrailingPortal({ children }: { children: ReactNode }) {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx?.trailingSlot) return null;
  return createPortal(children, ctx.trailingSlot);
}
