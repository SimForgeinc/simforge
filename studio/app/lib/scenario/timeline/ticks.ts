/**
 * Tick spacing for the time axis.
 *
 * The step comes from a fixed ladder of human-readable intervals rather than `span / n`, because a
 * computed step produces labels like `2.7s` and an author reading a rail is matching what they typed
 * against what they see. A 20 s clip gets 2 s ticks; a 3 s clip gets 0.5 s ticks; a 120 s clip gets
 * 15 s ticks. Nobody has to read `13.3s`.
 *
 * The tick at t=0 is emitted unconditionally, even when the step would skip it. It is the boundary
 * between the unrecorded warm-up and the recorded clip — the single most load-bearing instant on the
 * rail — and a window like `[-5, 20]` stepped by 3 would otherwise label 0 nowhere.
 */

import type { TimelineMark, TimelineRange } from "./geometry";

/** Steps in seconds. Every entry divides cleanly into a label with at most one decimal. */
const STEP_LADDER_S: readonly number[] = [
  0.1, 0.2, 0.5, 1, 2, 2.5, 5, 10, 15, 20, 30, 60, 120,
];

/**
 * The smallest ladder step that keeps the tick count at or under `maxTicks`.
 *
 * Falls back to the largest step rather than throwing on an absurd window: a rail with too many ticks
 * is unreadable, but a rail that throws takes the dock down with it.
 */
export function tickStepSeconds(spanSeconds: number, maxTicks = 12): number {
  const lastStep = STEP_LADDER_S[STEP_LADDER_S.length - 1] ?? 120;
  if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return lastStep;
  const limit = Math.max(2, maxTicks);
  for (const step of STEP_LADDER_S) {
    if (spanSeconds / step <= limit) return step;
  }
  return lastStep;
}

/**
 * Ticks across `window`, at ladder multiples plus the recorded origin.
 *
 * Marks are ordered by time and carry ids stable across re-renders for the same window, so React keys
 * do not churn while an author drags something else.
 */
export function timelineTicks(window: TimelineRange, maxTicks = 12): TimelineMark[] {
  const startS = window.startMs / 1000;
  const endS = window.endMs / 1000;
  if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) return [];

  const step = tickStepSeconds(endS - startS, maxTicks);
  const seen = new Set<number>();
  const times: number[] = [];
  const push = (seconds: number) => {
    // One decimal is the grid's resolution, so it is also the identity of a tick: without rounding,
    // `-0` and `0` are two ticks at the same place and float drift makes 6 and 6.000000000000001 two
    // more.
    const rounded = Number(seconds.toFixed(1)) || 0;
    if (rounded < startS || rounded > endS || seen.has(rounded)) return;
    seen.add(rounded);
    times.push(rounded);
  };

  const first = Math.ceil(startS / step) * step;
  for (let t = first; t <= endS + step / 2; t += step) push(t);
  if (startS <= 0 && endS >= 0) push(0);
  times.sort((a, b) => a - b);

  return times.map((seconds) => ({
    id: `tick_${seconds.toFixed(1)}`,
    timeMs: seconds * 1000,
    title: `${seconds.toFixed(1)}s`,
  }));
}
