import type { ControlIndication } from "@uniscenarios/sim-engine";

export type { ControlIndication };

/** Grid the lane snaps drag and paint gestures to. Matches v1's 0.1 s. */
export const TIMELINE_TIME_GRID_S = 0.1;

/** Below this a band is not drawable and not worth emitting. */
export const TIMELINE_MIN_BAND_S = 0.2;

export function snapTimelineSeconds(seconds: number): number {
  const snapped = Math.round(seconds / TIMELINE_TIME_GRID_S) * TIMELINE_TIME_GRID_S;
  // The multiply-then-divide leaves values like 3.3000000000000003; one more
  // rounding pass makes band edges exactly representable, which is what keeps
  // `endS === next.startS` true after a drag.
  return Math.round(snapped * 10) / 10;
}

/**
 * Where a band's indication came from.
 *
 * `"authored"` is a clip. `"baseline"` is the map's own program showing through
 * an uncovered interval. The distinction is not cosmetic: an author can retime
 * the first and cannot retime the second.
 */
export type SignalBandSource = "authored" | "baseline";

/**
 * What the timeline dock's signal lane draws, and what painting on it produces.
 *
 * The lane shows two tiers: **authored** bands from the plan's clips, and
 * **baseline** bands from the map's own looping program wherever no clip
 * covers — which makes the lane an accurate picture of the compiled result.
 * Baseline bands carry their provenance in {@link SignalTimelineBand.source} so
 * the UI renders them as provisional rather than surveyed timing.
 */
export type SignalTimelineBand = {
  readonly startS: number;
  readonly endS: number;
  readonly indication: ControlIndication;
  readonly source: SignalBandSource;
  /** The clip this band came from, for hit-testing a drag. Null for baseline. */
  readonly clipId: string | null;
};

export type SignalTimelineRow = {
  readonly junctionId: string;
  /** Whether a plan governs this junction at all. */
  readonly planned: boolean;
  readonly bands: readonly SignalTimelineBand[];
};
