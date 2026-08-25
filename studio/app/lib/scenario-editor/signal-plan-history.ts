/**
 * Undo/redo for traffic-signal authoring.
 *
 * ## Why this is a second stack rather than a wider envelope
 *
 * `editorDocumentStore`'s history is an ACTORS-ONLY envelope with a persisted
 * checksum (`actor-setup-history.ts`): every saved history in the fleet carries
 * `checksum === actorSetupDocumentChecksum(actors)`, and a snapshot whose
 * checksum does not reproduce is discarded on load. Adding signal plans to the
 * snapshot shape changes what that checksum covers, which would silently
 * invalidate every author's saved history — a fleet-wide migration nobody asked
 * for, to undo a colour drag.
 *
 * So signal plans get their own stack, living beside `signalPlans` in
 * `actorsStore`, and the two stacks share ⌘Z through a dispatcher that routes
 * to whichever one owns the most recent edit (`useEditorHotkeys`). Nothing here
 * is persisted, which is also why it needs no checksum: an in-memory stack
 * cannot be handed a snapshot that disagrees with its own document.
 *
 * Depth mirrors the actors stack (`DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES`) so
 * "how far back can I go" does not depend on which kind of edit you made.
 */

import type { JunctionSignalPlan } from "@simforge/studio-shared";
import { DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES } from "./actor-setup-history";

export const SIGNAL_PLAN_HISTORY_MAX_ENTRIES =
  DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES;

export type SignalPlanHistorySnapshot = {
  /** What the entry undoes, for the dispatcher's label and future UI. */
  label: string;
  /** Epoch ms of the edit, which is what decides who owns ⌘Z. */
  at: number;
  plans: JunctionSignalPlan[];
};

export type SignalPlanHistoryState = {
  past: SignalPlanHistorySnapshot[];
  future: SignalPlanHistorySnapshot[];
};

export const EMPTY_SIGNAL_PLAN_HISTORY: SignalPlanHistoryState = {
  past: [],
  future: [],
};

/**
 * Epoch ms, forced strictly increasing.
 *
 * The dispatcher compares this against the actors stack's `createdAt`, and two
 * edits inside one millisecond are ordinary under `Date.now()`'s resolution —
 * a run of fast keystrokes, or any test that does not fake time. Ties would
 * make ⌘Z pick a stack arbitrarily, so they are not allowed to happen.
 */
let lastStamp = 0;
export function nextSignalEditStamp(now = Date.now()): number {
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

function snapshot(
  label: string,
  plans: readonly JunctionSignalPlan[],
): SignalPlanHistorySnapshot {
  return { label, at: nextSignalEditStamp(), plans: [...plans] };
}

/**
 * Record `before` as undoable and return the trimmed stacks.
 *
 * Callers pass the state as it was BEFORE the change; a change that turned out
 * to be a no-op must not reach here, or ⌘Z would appear to do nothing.
 */
export function pushSignalPlanHistory({
  history,
  label,
  before,
}: {
  history: SignalPlanHistoryState;
  label: string;
  before: readonly JunctionSignalPlan[];
}): SignalPlanHistoryState {
  return {
    past: [...history.past, snapshot(label, before)].slice(
      -SIGNAL_PLAN_HISTORY_MAX_ENTRIES,
    ),
    future: [],
  };
}

export function undoSignalPlanHistory({
  history,
  present,
}: {
  history: SignalPlanHistoryState;
  present: readonly JunctionSignalPlan[];
}): { plans: JunctionSignalPlan[]; history: SignalPlanHistoryState; changed: boolean } {
  const previous = history.past[history.past.length - 1];
  if (!previous) {
    return { plans: [...present], history, changed: false };
  }
  return {
    plans: [...previous.plans],
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, snapshot(previous.label, present)].slice(
        -SIGNAL_PLAN_HISTORY_MAX_ENTRIES,
      ),
    },
    changed: true,
  };
}

export function redoSignalPlanHistory({
  history,
  present,
}: {
  history: SignalPlanHistoryState;
  present: readonly JunctionSignalPlan[];
}): { plans: JunctionSignalPlan[]; history: SignalPlanHistoryState; changed: boolean } {
  const next = history.future[history.future.length - 1];
  if (!next) {
    return { plans: [...present], history, changed: false };
  }
  return {
    plans: [...next.plans],
    history: {
      past: [...history.past, snapshot(next.label, present)].slice(
        -SIGNAL_PLAN_HISTORY_MAX_ENTRIES,
      ),
      future: history.future.slice(0, -1),
    },
    changed: true,
  };
}

/** When the stack last recorded an edit, or `null` when it has none. */
export function lastSignalEditAt(history: SignalPlanHistoryState): number | null {
  return history.past[history.past.length - 1]?.at ?? null;
}

/** When the stack last UNDID an edit, or `null` when there is nothing to redo. */
export function lastSignalUndoAt(history: SignalPlanHistoryState): number | null {
  return history.future[history.future.length - 1]?.at ?? null;
}
