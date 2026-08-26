import type { MapSignalPlan } from "@simforge-oss/scenario";

import type {
  TimelineLaneSource,
  TimelineLaneSpan,
  TimelineRange,
} from "@/app/lib/scenario/timeline";
import {
  buildSignalTimelineRows,
  buildStageTimelineRows,
  type EditorSignalIndex,
  type SignalTimelineBand,
  type StageTimelineRow,
} from "@/app/lib/scenario/signals";

import { timelineMsToSeconds, secondsToTimelineMs } from "./signal-lane-seconds";

/**
 * The signals lane's registration into the timeline dock.
 *
 * ## One lane per junction
 *
 * `laneId` is `signal:junction:<junctionId>`, and there is exactly one plan per
 * junction — `compileMapSignalPlans` replaces a junction's programs wholesale per
 * plan, and `upsertMapSignalPlan` keys on the junction for that reason. So a
 * duplicate registration is a real bug and `createTimelineLaneRegistry`'s throw
 * is the correct response, not something to defend against.
 *
 * Per-stage detail goes **inside `datum`** via `buildStageTimelineRows`, not as
 * extra lanes. Eight rows for an ordinary four-way would bury the actor lanes,
 * and the expanded view is a disclosure on one lane rather than eight lanes that
 * are usually collapsed.
 *
 * ## `spans` is a pull, and that is what keeps the direction one-way
 *
 * The dock asks "what is in this window"; it never subscribes to signal
 * internals and never reimplements phase evaluation. Signals import the registry;
 * the registry imports nothing from signals.
 */

/** The signals band of the `order` scale. 1000-1999 is reserved for signals. */
export const SIGNAL_LANE_ORDER_BASE = 1000;
export const SIGNAL_LANE_ORDER_CEILING = 1999;

/** What a signal span carries for the lane's own renderer. */
export type SignalLaneDatum = {
  readonly junctionId: string;
  readonly band: SignalTimelineBand;
  /** Whether a plan governs this junction at all. */
  readonly planned: boolean;
  /**
   * The per-stage expansion, same window, computed once per build.
   *
   * On the datum rather than on extra lanes: it is detail behind a disclosure, and
   * the timeline must not have to know that a junction has stages to lay one out.
   */
  readonly stageRows: readonly StageTimelineRow[];
};

export function signalLaneId(junctionId: string): string {
  return `signal:junction:${junctionId}`;
}

/**
 * `order` for a junction's lane, inside the reserved band.
 *
 * Derived from the junction id's position in the sorted junction list rather than
 * from a hash: a hash can collide inside 1000 slots, and two lanes with the same
 * `order` fall back to a `laneId` tie-break that reorders them the moment a
 * junction id changes length. A junction beyond the thousandth pins to the
 * ceiling rather than escaping the band and outranking a different lane kind.
 */
export function signalLaneOrder(junctionIndex: number): number {
  return Math.min(SIGNAL_LANE_ORDER_CEILING, SIGNAL_LANE_ORDER_BASE + Math.max(0, junctionIndex));
}

export type SignalLaneSourcesInput = {
  readonly index: EditorSignalIndex;
  readonly plans: readonly MapSignalPlan[];
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
};

/**
 * A `TimelineLaneSource` per junction explicitly authored by this scenario.
 *
 * The rows are built once here rather than inside `spans`, because `spans` is
 * called on every scroll and zoom while the rows depend only on the plans and the
 * clip. `spans` then filters — which is cheap — and converts to milliseconds.
 *
 * Map baselines fill gaps inside an authored plan, but they do not create lanes
 * by themselves. Otherwise a brand-new scenario looks as though every physical
 * junction on the map was configured by the author.
 */
export function buildSignalLaneSources(
  input: SignalLaneSourcesInput,
): TimelineLaneSource<SignalLaneDatum>[] {
  const rows = buildSignalTimelineRows({
    index: input.index,
    plans: input.plans,
    junctionIds: input.plans.map((plan) => plan.binding.junctionId),
    clipSeconds: input.clipSeconds,
    warmupSeconds: input.warmupSeconds,
  });

  return rows.map((row, at) => {
    const stageRows = buildStageTimelineRows({
      index: input.index,
      plans: input.plans,
      clipSeconds: input.clipSeconds,
      warmupSeconds: input.warmupSeconds,
      junctionId: row.junctionId,
    });
    const spans: TimelineLaneSpan<SignalLaneDatum>[] = row.bands.map((band) => ({
      // Stable across rebuilds: the band's own start is its identity on the lane,
      // so a retime moves a span rather than replacing it.
      id: `${signalLaneId(row.junctionId)}:${secondsToTimelineMs(band.startS)}`,
      startMs: secondsToTimelineMs(band.startS),
      endMs: secondsToTimelineMs(band.endS),
      datum: { junctionId: row.junctionId, band, planned: row.planned, stageRows },
    }));

    return {
      laneId: signalLaneId(row.junctionId),
      kind: "signal",
      label: `Junction ${row.junctionId}`,
      order: signalLaneOrder(at),
      spans(window: TimelineRange) {
        // Touching does not overlap: a band ending exactly at the window's left
        // edge is not in the window, which is the same rule `rangesOverlap` uses
        // and what makes back-to-back bands unambiguous.
        return spans.filter((span) => span.startMs < window.endMs && span.endMs > window.startMs);
      },
      marks(window: TimelineRange) {
        // Interior boundaries only. A band's outer edges are the clip's own
        // bounds, and a mark there would draw a tick on the rail's end cap.
        return spans
          .filter((span) => span.startMs > window.startMs && span.startMs < window.endMs)
          .map((span) => ({
            id: `${span.id}:edge`,
            timeMs: span.startMs,
            title: `${span.datum.band.indication} at ${timelineMsToSeconds(span.startMs)}s`,
          }));
      },
    } satisfies TimelineLaneSource<SignalLaneDatum>;
  });
}
