/**
 * The one seconds↔milliseconds conversion on the signal lane's seam.
 *
 * ## Why exactly one site, both directions
 *
 * `TimelineRange` is **milliseconds, integer-valued by contract** — the shared
 * `TimelineRange`/`TimelineMark` types and `components/timeline/**` are already ms
 * and are used well beyond this subsystem, so rippling a unit change through them
 * to fix one seam would be the wrong trade. The signal domain,
 * `MapSignalPlanClipSchema`, the compiler and `choreography.clipSeconds` are all
 * **seconds**.
 *
 * So this is a real seam, and it is the one place in this subsystem where a
 * rounding error becomes a **schema-rejected overlap** rather than a visual
 * glitch: clips are contiguous and non-overlapping by schema, so a band whose
 * `endS` returns a ten-thousandth above the next band's `startS` is a plan the
 * document refuses on `addMapSignalPlan`. A second conversion site is what makes
 * that unsafe, which is why there is one.
 *
 * ## The exactness argument is CONDITIONAL — read this before widening precision
 *
 * ×1000 lands on an exact integer millisecond **only because clip edges are
 * snapped to tenths of a second** by `snapTimelineSeconds` (`TIMELINE_TIME_GRID_S
 * = 0.1`), and a tenth is exactly 100 ms.
 *
 * **If anything ever authors an edge finer than a tenth, that argument dies.** A
 * hundredth of a second is 10 ms and still integral, but a *thousandth* is 1 ms
 * and the first non-representable value below that silently reintroduces the drift
 * this module exists to prevent. Both functions therefore round **explicitly**
 * rather than relying on the multiplication landing clean — so the failure mode of
 * widening the grid is a visible loss of precision at a known boundary, not a
 * schema rejection three layers away.
 *
 * Concretely: `Math.round`, never truncation. `0.1 * 3 * 1000` is
 * `300.00000000000006` and `Math.trunc` would give 300 by luck, while
 * `(2.9 + 0.1) * 1000` is `2999.9999999999995` and would give 2999 — a
 * millisecond of drift per boundary, in a direction that depends on the float's
 * last bit. That is exactly how a contiguous run becomes an overlapping one.
 *
 * The invariant worth testing is not `1.5s → 1500ms`. It is that a `layOutCycle`
 * result survives the round trip with `endS === next.startS` still holding
 * **exactly** for every adjacent pair, because that is the predicate
 * `MapSignalPlanSchema` enforces. `test/uniscenario/signals/signal-panel.test.tsx`
 * pins it that way.
 */

/** The grid the exactness argument above depends on. Seconds. */
export const TIMELINE_MS_GRID_S = 0.1;

/** Seconds to whole milliseconds. */
export function secondsToTimelineMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000);
}

/**
 * Milliseconds back to seconds, at the tenth the signal grid uses.
 *
 * Rounded to one decimal rather than returned as `ms / 1000`: an arbitrary
 * millisecond from a pointer position would otherwise re-enter the domain as a
 * value `snapTimelineSeconds` still has to fix, and a value snapped twice — once
 * here, once there — can move by half a grid step on a round trip.
 */
export function timelineMsToSeconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return 0;
  // DIVIDE by ten, never multiply by 0.1. `3 / 10` is exactly `0.3`; `3 * 0.1` is
  // `0.30000000000000004`. Multiplying here would reintroduce, in the very last
  // line of the module, the drift the rest of it exists to prevent.
  return Math.round(milliseconds / (TIMELINE_MS_GRID_S * 1000)) / 10;
}
