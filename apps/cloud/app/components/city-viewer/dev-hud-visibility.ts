'use client';

import { useEffect, useState } from 'react';

/**
 * Global show/hide state for every dev HUD in the city viewer. `Shift+H`
 * toggles the singleton; each HUD subscribes via `useDevHudHidden()` and
 * conditionally renders. Independent of per-HUD collapsed state — the user
 * can still have HUDs collapsed individually and reveal/hide them all at
 * once with the chord.
 *
 * Listener registration is lazy: the global `keydown` handler installs only
 * after the first subscription so there's no DOM side effect at import
 * time (which would also break SSR / unit tests that exercise the module
 * without a real `window`).
 */

type Listener = (hidden: boolean) => void;

const listeners = new Set<Listener>();
let hidden = false;
let installed = false;

function notify(): void {
  for (const fn of Array.from(listeners)) fn(hidden);
}

function setHidden(next: boolean): void {
  if (hidden === next) return;
  hidden = next;
  notify();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!event.shiftKey) return;
  if (event.key !== 'H' && event.key !== 'h') return;
  // Ignore typing into form fields so the chord doesn't hijack text entry.
  const target = event.target as HTMLElement | null;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target && target.isContentEditable)
  ) {
    return;
  }
  event.preventDefault();
  setHidden(!hidden);
}

function ensureInstalled(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown);
  installed = true;
}

export function subscribeDevHudVisibility(listener: Listener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDevHudHidden(): boolean {
  return hidden;
}

/** Test/dev affordance — directly drive the hidden state. */
export function setDevHudHidden(next: boolean): void {
  setHidden(next);
}

/**
 * React hook each dev HUD calls to subscribe to the global hide-toggle.
 * Returns the current `hidden` flag so the caller can `if (hidden) return null`.
 */
export function useDevHudHidden(): boolean {
  const [value, setValue] = useState<boolean>(() => hidden);
  useEffect(() => {
    setValue(hidden);
    return subscribeDevHudVisibility(setValue);
  }, []);
  return value;
}
