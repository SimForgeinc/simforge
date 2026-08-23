/**
 * The editor's one status/notification stream — pure model half.
 *
 * Everything here is a plain function over plain data so the policy that
 * decides what an author actually sees (ordering, the visible cap, content
 * collapse, expiry, redaction) can be tested without a DOM, a store, or a
 * React tree. `notificationStore.ts` owns the mutable half and calls into this.
 *
 * The rule this file exists to enforce: the editor used to resolve N competing
 * statuses down to exactly ONE visible slot, so a simulation progress bar, a
 * render failure and a map-boot spinner would silently suppress each other.
 * Nothing here ever returns a single winner — it returns a bounded, ordered
 * stack plus an honest count of what did not fit.
 */

export type NotificationSeverity =
  | "error"
  | "warning"
  | "success"
  | "info"
  | "progress";

export type NotificationSource =
  | "scenario"
  | "preview"
  | "render"
  | "cosmos"
  | "postprocess"
  | "artifacts"
  | "dataset"
  | "export"
  | "sensor"
  | "map"
  | "authoring";

export type NotificationAction = {
  label: string;
  run: () => void;
};

export type EditorNotificationInput = {
  /** Stable identity. Re-publishing the same key updates in place; never stacks. */
  key: string;
  severity: NotificationSeverity;
  source: NotificationSource;
  /** One line, sentence case, no API paths or ids. */
  message: string;
  detail?: string | null;
  /** 0-100; only meaningful for severity "progress". */
  progress?: number | null;
  action?: NotificationAction | null;
  /** ms; null = sticky until dismissed. Omit to take the per-severity default. */
  ttlMs?: number | null;
  /**
   * Marks a distinct *occurrence* of an otherwise identical notification.
   *
   * Re-publishing unchanged content is deliberately inert — a parent
   * re-rendering must not restart a TTL or resurrect a dismissed card. But some
   * feeds legitimately say the same sentence twice, and the second time is
   * news: the page-log alert stream keys on the message itself, so "the render
   * command failed" happening again is indistinguishable from a re-render
   * without this. Pass the source event's id and the card re-arms.
   */
  dedupeToken?: string | null;
  /**
   * The editor is unusable until this resolves (boot, route errors, a missing
   * map). Blocking entries never reach the corner dock — a 380px card that can
   * be dismissed is the wrong affordance for "the whole page is not ready" —
   * they are rendered by `EditorBootGate` instead. Same stream, second renderer.
   */
  blocking?: boolean;
};

export type EditorNotification = EditorNotificationInput & {
  detail: string | null;
  progress: number | null;
  action: NotificationAction | null;
  ttlMs: number | null;
  blocking: boolean;
  createdAt: number;
  updatedAt: number;
  /** Wall-clock expiry, or null for sticky. Shifted forward while paused. */
  expiresAt: number | null;
  /** Display order tiebreak. Stable across in-place updates so cards don't jump. */
  seq: number;
  /**
   * Monotonic content revision. Dismissal records the revision it dismissed, so
   * a later publish carrying genuinely new content re-arms the card while a
   * re-render of the same content stays dismissed. A timestamp cannot do this:
   * two publishes inside one millisecond are indistinguishable.
   */
  revision: number;
};

/**
 * A render-time grouping of notifications that say the same thing. Distinct
 * keys with identical severity + source + message collapse into one card with
 * a ×N badge, which is what keeps a chatty emitter from eating the whole stack.
 */
export type NotificationGroup = {
  /** The most recently updated member — the one whose content is rendered. */
  notification: EditorNotification;
  count: number;
  /** Every key in the group, so dismissing the card dismisses all of them. */
  keys: string[];
};

/** Only error and warning are privileged for the visible slots; the rest tie and sort by recency. */
const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  error: 4,
  warning: 3,
  success: 1,
  info: 1,
  progress: 1,
};

const DEFAULT_TTL_MS: Record<NotificationSeverity, number | null> = {
  // Progress has no timer at all: it ends when the publisher unpublishes it.
  // A progress card that expires on its own would claim an operation finished.
  progress: null,
  success: 3_000,
  info: 4_000,
  warning: 8_000,
  // Errors that vanish on their own are how the previous system lost
  // information. They stay until the author dismisses them.
  error: null,
};

export const NOTIFICATION_STACK_CAP = 4;

export function clampStatusProgress(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function userSafeErrorDetail(
  value: string | null | undefined,
  fallback = "The editor operation failed.",
) {
  const detail = value?.trim();
  if (!detail) return fallback;
  return detail
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s)\]}]+/gi, "the editor service")
    .replace(/\/api\/[^\s)\]}]+/gi, "the editor service");
}

/**
 * How long this notification should stay up.
 *
 * A warning carrying an action is sticky: it is asking the author to do
 * something, and a prompt that times out before it is read is worse than none.
 */
export function notificationTtlMs(
  input: Pick<EditorNotificationInput, "severity" | "ttlMs" | "action">,
): number | null {
  if (input.ttlMs !== undefined) return input.ttlMs;
  if (input.severity === "warning" && input.action) return null;
  return DEFAULT_TTL_MS[input.severity];
}

/** Identity for content collapse: same words from the same place at the same level. */
export function notificationContentKey(
  notification: Pick<
    EditorNotification,
    "severity" | "source" | "message"
  >,
) {
  return `${notification.severity}|${notification.source}|${notification.message}`;
}

/** Most important first, then most recently updated, then newest published. */
export function orderNotifications(
  notifications: Iterable<EditorNotification>,
): EditorNotification[] {
  return [...notifications].sort((left, right) => {
    const rank = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    if (rank !== 0) return rank;
    const updated = right.updatedAt - left.updatedAt;
    if (updated !== 0) return updated;
    return right.seq - left.seq;
  });
}

/**
 * Collapse duplicate content, preserving the order of first appearance so a
 * card never jumps when a second emitter joins its group.
 */
export function collapseNotifications(
  ordered: readonly EditorNotification[],
): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const indexByContent = new Map<string, number>();
  for (const notification of ordered) {
    const content = notificationContentKey(notification);
    const existing =
      indexByContent.get(content) != null
        ? groups[indexByContent.get(content) as number]
        : undefined;
    if (!existing) {
      indexByContent.set(content, groups.length);
      groups.push({ notification, count: 1, keys: [notification.key] });
      continue;
    }
    existing.count += 1;
    existing.keys.push(notification.key);
  }
  return groups;
}

/**
 * The bounded stack the dock renders, plus how many groups did not fit.
 *
 * `overflowCount` counts *groups*, not notifications: "+2 more" should mean two
 * more things to read, not two more copies of a line already on screen.
 */
export function visibleNotificationGroups(
  notifications: Iterable<EditorNotification>,
  cap = NOTIFICATION_STACK_CAP,
): { groups: NotificationGroup[]; overflowCount: number } {
  const collapsed = collapseNotifications(orderNotifications(notifications));
  if (collapsed.length <= cap) return { groups: collapsed, overflowCount: 0 };
  return {
    groups: collapsed.slice(0, cap),
    overflowCount: collapsed.length - cap,
  };
}

/** The blocking entry `EditorBootGate` should show, or null. */
export function resolveBlockingNotification(
  notifications: Iterable<EditorNotification>,
): EditorNotification | null {
  return orderNotifications([...notifications].filter((n) => n.blocking))[0] ?? null;
}

export function expiredNotificationKeys(
  notifications: Iterable<EditorNotification>,
  now: number,
): string[] {
  return [...notifications]
    .filter((n) => n.expiresAt != null && n.expiresAt <= now)
    .map((n) => n.key);
}

const SOURCE_BY_EXACT_KEY: Record<string, NotificationSource> = {
  "scenario-map-error": "map",
  "semantic-binding-revalidation": "map",
  "scenario-snapshot-operation": "authoring",
  "scenario-timed-points": "authoring",
  "scenario-placement-clamp": "authoring",
  "scenario-schedule-lag": "authoring",
  "scenario-json-operation": "export",
  "scenario-import-operation": "export",
  "advanced-account-operation": "scenario",
  "cross-map-variations-operation": "scenario",
};

const SOURCE_BY_KEY_PREFIX: [string, NotificationSource][] = [
  ["camera-preview", "preview"],
  ["sensor-preview", "sensor"],
  ["scenario-preview", "preview"],
  ["scenario-local-preview", "preview"],
  ["scenario-simulation", "preview"],
  ["dataset", "dataset"],
  ["render", "render"],
  ["cosmos", "cosmos"],
  ["postprocess", "postprocess"],
  ["artifacts", "artifacts"],
  ["layer-style", "map"],
];

/**
 * Source for a legacy `useEditorWorkspaceStatus` key.
 *
 * The 30 panel publishers still call the legacy hook, which has no `source`
 * field; rather than editing every one of them in a tree with concurrent work
 * in flight, the shim derives it from the key those sites already pass.
 */
export function inferNotificationSource(key: string): NotificationSource {
  const exact = SOURCE_BY_EXACT_KEY[key];
  if (exact) return exact;
  for (const [prefix, source] of SOURCE_BY_KEY_PREFIX) {
    if (key.startsWith(prefix)) return source;
  }
  return "scenario";
}
