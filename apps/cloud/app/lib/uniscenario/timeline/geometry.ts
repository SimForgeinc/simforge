/**
 * Timeline geometry: the pure time↔pixel maths, with no React and no v1 imports.
 *
 * These types are duplicated in `app/components/timeline/types.ts` today, which is where the shared
 * primitives (manifest #83) still live. When #83 moves into v2, that file should re-export from here
 * rather than keep its own copies — geometry is domain, not presentation. The direction matters:
 * `lib/` must never import from `components/`, so the definitions live here and the UI follows.
 */

/** A half-open-ish time range on a timeline, in milliseconds from t=0. */
export type TimelineRange = { startMs: number; endMs: number };

/** A point-in-time tick drawn on a scrubber rail. */
export type TimelineMark = {
  id: string;
  timeMs: number;
  className?: string;
  title?: string;
};

/**
 * Position as a percentage of the rail, clamped to 100.
 *
 * A zero or negative duration yields 0 rather than `Infinity`/`NaN`: an empty timeline still renders,
 * and a `NaN` here becomes a `left: NaN%` that silently drops the element from the layout.
 */
export function timelinePercent(timestampMs: number, durationMs: number): number {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(durationMs)) return 0;
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (timestampMs / durationMs) * 100));
}

/**
 * Position as a percentage of an arbitrary window, clamped to 0..100.
 *
 * The form v2 needs. {@link timelinePercent} measures from an implicit origin at zero, which is right
 * for a `[0, duration]` rail and wrong for a v2 clip window, whose left edge is `-warmupSeconds`.
 * Passing a warm-up instant to `timelinePercent` clamps it to 0% — visually identical to `at(0)`, and
 * those two are not the same scenario.
 */
export function rangePercent(timeMs: number, window: TimelineRange): number {
  if (!Number.isFinite(timeMs)) return 0;
  const span = window.endMs - window.startMs;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.min(100, Math.max(0, ((timeMs - window.startMs) / span) * 100));
}

/** Whether `timeMs` falls inside `range`, start-inclusive and end-exclusive. */
export function rangeContains(range: TimelineRange, timeMs: number): boolean {
  return timeMs >= range.startMs && timeMs < range.endMs;
}

/**
 * Whether two ranges overlap at all, start-inclusive and end-exclusive.
 *
 * Ranges that merely touch — one ending exactly where the next begins — do NOT overlap. That is what
 * makes back-to-back clips legal, and it is the predicate a lane uses to reject a drop.
 *
 * A zero-length range overlaps nothing, including a range that strictly contains its instant. That
 * follows from the same rule: an empty range is all boundary and no interior, and this predicate
 * compares interiors. Without the guard the bare inequality reports `true` for a degenerate range
 * inside another, which would let a zero-length clip block a drop it does not occupy.
 */
export function rangesOverlap(a: TimelineRange, b: TimelineRange): boolean {
  if (a.endMs <= a.startMs || b.endMs <= b.startMs) return false;
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** Clamp a range inside `bounds`, preserving its duration where the bounds allow. */
export function clampRange(range: TimelineRange, bounds: TimelineRange): TimelineRange {
  const duration = Math.max(0, range.endMs - range.startMs);
  const available = Math.max(0, bounds.endMs - bounds.startMs);
  if (duration >= available) return { startMs: bounds.startMs, endMs: bounds.endMs };
  const startMs = Math.min(Math.max(range.startMs, bounds.startMs), bounds.endMs - duration);
  return { startMs, endMs: startMs + duration };
}
