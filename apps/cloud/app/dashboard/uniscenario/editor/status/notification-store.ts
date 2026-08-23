import { create } from "zustand";
import {
  clampStatusProgress,
  expiredNotificationKeys,
  notificationTtlMs,
  userSafeErrorDetail,
  type UniScenarioNotification,
  type UniScenarioNotificationInput,
} from "./notification-model";

/**
 * The v2 editor's single status/notification stream — mutable half.
 *
 * A store rather than threaded props because the publishers are everywhere (the
 * client shell, the runtime, each region, and every panel a sibling agent is
 * about to add) and the renderers are exactly two:
 * `UniScenarioNotificationDock` in the corner and `UniScenarioBootGate` for the
 * blocking few. Threading status from a common ancestor of all of that is how
 * v1 ended up with five parallel display mechanisms.
 *
 * Dismissal state lives here, not in the dock: keeping it in component state
 * means unmounting the dock — which happens whenever its list empties —
 * silently un-dismisses everything the author already read.
 */
interface NotificationState {
  entries: Record<string, UniScenarioNotification>;
  /** key → the `revision` that was dismissed. A newer revision re-arms the card. */
  dismissedRevisionByKey: Record<string, number>;
  /** Set while the pointer is over the stack; expiry is frozen until it leaves. */
  pausedAt: number | null;
  publish: (input: UniScenarioNotificationInput, now?: number) => void;
  unpublish: (key: string) => void;
  dismiss: (keys: string | readonly string[]) => void;
  dismissAll: () => void;
  setPaused: (paused: boolean, now?: number) => void;
  /** Drops everything whose TTL has elapsed. No-op while paused. */
  sweep: (now?: number) => void;
  reset: () => void;
}

let sequence = 0;
let revision = 0;

function nextSequence() {
  sequence += 1;
  return sequence;
}

function nextRevision() {
  revision += 1;
  return revision;
}

/** Whether a re-publish changed anything an author could see. */
function sameContent(
  previous: UniScenarioNotification,
  next: UniScenarioNotificationInput & {
    detail: string | null;
    progress: number | null;
  },
) {
  return (
    previous.severity === next.severity &&
    previous.source === next.source &&
    previous.message === next.message &&
    previous.detail === next.detail &&
    previous.progress === next.progress &&
    previous.blocking === Boolean(next.blocking) &&
    (previous.dedupeToken ?? null) === (next.dedupeToken ?? null) &&
    Boolean(previous.action) === Boolean(next.action) &&
    previous.action?.label === next.action?.label
  );
}

export const useUniScenarioNotificationStore = create<NotificationState>()(
  (set) => ({
    entries: {},
    dismissedRevisionByKey: {},
    pausedAt: null,

    publish: (input, now = Date.now()) =>
      set((state) => {
        const detail =
          input.severity === "error"
            ? userSafeErrorDetail(input.detail)
            : (input.detail ?? null);
        const progress = clampStatusProgress(input.progress);
        const previous = state.entries[input.key];

        // An unchanged re-publish must not restart the TTL or bump the
        // revision: a parent re-rendering every frame would otherwise pin a 3s
        // card open forever and resurrect cards already dismissed.
        if (previous && sameContent(previous, { ...input, detail, progress })) {
          return state;
        }

        const ttlMs = notificationTtlMs(input);
        const entry: UniScenarioNotification = {
          ...input,
          detail,
          progress,
          action: input.action ?? null,
          ttlMs,
          blocking: Boolean(input.blocking),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          expiresAt: ttlMs == null ? null : now + ttlMs,
          // Keep the slot the card already occupies so updating a message in
          // place doesn't make it jump over its neighbours.
          seq: previous?.seq ?? nextSequence(),
          revision: nextRevision(),
        };
        return { ...state, entries: { ...state.entries, [input.key]: entry } };
      }),

    unpublish: (key) =>
      set((state) => {
        if (!(key in state.entries)) return state;
        const entries = { ...state.entries };
        delete entries[key];
        // Drop the dismissal with the entry: the next publish of this key is a
        // new occurrence, not the one that was dismissed.
        const dismissedRevisionByKey = { ...state.dismissedRevisionByKey };
        delete dismissedRevisionByKey[key];
        return { ...state, entries, dismissedRevisionByKey };
      }),

    dismiss: (keys) =>
      set((state) => {
        const list = typeof keys === "string" ? [keys] : keys;
        const dismissedRevisionByKey = { ...state.dismissedRevisionByKey };
        let changed = false;
        for (const key of list) {
          const entry = state.entries[key];
          if (!entry) continue;
          if (dismissedRevisionByKey[key] === entry.revision) continue;
          dismissedRevisionByKey[key] = entry.revision;
          changed = true;
        }
        return changed ? { ...state, dismissedRevisionByKey } : state;
      }),

    dismissAll: () =>
      set((state) => {
        const dismissedRevisionByKey = { ...state.dismissedRevisionByKey };
        for (const entry of Object.values(state.entries)) {
          dismissedRevisionByKey[entry.key] = entry.revision;
        }
        return { ...state, dismissedRevisionByKey };
      }),

    setPaused: (paused, now = Date.now()) =>
      set((state) => {
        if (paused) {
          return state.pausedAt == null ? { ...state, pausedAt: now } : state;
        }
        if (state.pausedAt == null) return state;
        // Give back exactly the time spent paused rather than restarting the
        // timers — a card should not get a fresh 8 seconds because it was
        // hovered for one.
        const held = now - state.pausedAt;
        const entries: Record<string, UniScenarioNotification> = {};
        for (const [key, entry] of Object.entries(state.entries)) {
          entries[key] =
            entry.expiresAt == null
              ? entry
              : { ...entry, expiresAt: entry.expiresAt + held };
        }
        return { ...state, entries, pausedAt: null };
      }),

    sweep: (now = Date.now()) =>
      set((state) => {
        if (state.pausedAt != null) return state;
        const expired = expiredNotificationKeys(
          Object.values(state.entries),
          now,
        );
        if (expired.length === 0) return state;
        const entries = { ...state.entries };
        const dismissedRevisionByKey = { ...state.dismissedRevisionByKey };
        for (const key of expired) {
          delete entries[key];
          delete dismissedRevisionByKey[key];
        }
        return { ...state, entries, dismissedRevisionByKey };
      }),

    reset: () =>
      set({ entries: {}, dismissedRevisionByKey: {}, pausedAt: null }),
  }),
);

/** Entries the author has not already dismissed at their current revision. */
export function undismissedNotifications(
  entries: Record<string, UniScenarioNotification>,
  dismissedRevisionByKey: Record<string, number>,
): UniScenarioNotification[] {
  return Object.values(entries).filter((entry) => {
    const dismissed = dismissedRevisionByKey[entry.key];
    return dismissed == null || entry.revision > dismissed;
  });
}
