import { flushSync } from "react-dom";

import {
  observeViewTransitionCompletion,
  type ViewTransitionResult,
} from "@/app/lib/browser/view-transition";

/**
 * Helpers for the dataset index → document list View Transitions morph. The morph names a row and
 * its post-transition header with the same `view-transition-name` (`dataset-tile-{id}`) and lets the
 * browser cross-fade-and-translate between the two snapshots.
 */

const DATASET_TRANSITION_NAME_PREFIX = "dataset-tile-";
const DOCUMENT_TRANSITION_NAME_PREFIX = "document-card-";

/**
 * Sanitise an id into a CSS `<custom-ident>` so it is legal inside a `view-transition-name`.
 * `scenarioId()` tokens round-trip cleanly; anything unexpected collapses to `_`.
 */
function sanitiseIdent(value: string): string {
  let out = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (/^[0-9-]/.test(out)) out = `_${out}`;
  return out || "_";
}

export function datasetTileTransitionName(datasetId: string): string {
  return `${DATASET_TRANSITION_NAME_PREFIX}${sanitiseIdent(datasetId)}`;
}

export function documentCardTransitionName(documentId: string): string {
  return `${DOCUMENT_TRANSITION_NAME_PREFIX}${sanitiseIdent(documentId)}`;
}

export function supportsViewTransitions(): boolean {
  if (typeof document === "undefined") return false;
  return (
    typeof (
      document as Document & {
        startViewTransition?: (cb: () => void | Promise<void>) => unknown;
      }
    ).startViewTransition === "function"
  );
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Run `mutate` inside a View Transition where the browser supports one and the user has not asked
 * for reduced motion; run it immediately everywhere else, so callers can rely on the state having
 * flipped by the time this returns either way.
 */
export function runDatasetMorph(mutate: () => void): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    mutate();
    return;
  }
  const doc = document as Document & {
    startViewTransition: (cb: () => void | Promise<void>) => ViewTransitionResult;
  };
  // `flushSync` forces React to commit synchronously so the new DOM is in place before the browser
  // captures the post-transition snapshot. Without it, batched updates race the snapshot and the
  // morph never pairs the two named elements.
  const transition = doc.startViewTransition(() => {
    flushSync(() => {
      mutate();
    });
  });
  observeViewTransitionCompletion(transition, "Scenario dataset");
}
