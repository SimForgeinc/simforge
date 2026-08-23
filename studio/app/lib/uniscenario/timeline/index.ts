/**
 * The v2 timeline domain model: temporal geometry, the clip window, the authoring grid, interaction
 * layout, and the lane-registration seam.
 *
 * Framework-free by rule — no React, no imports from `app/components/**`. The timeline UI imports from
 * here; nothing here imports from the UI.
 *
 * The behaviour taxonomy (triggers, the verb palette, blockers, execution backend) is NOT here. It
 * lives in `lib/uniscenario/behavior/**`, because the inspector and the action palette need it for
 * reasons that have nothing to do with a timeline, and a path that implies otherwise misleads every
 * future reader.
 */

export {
  clampRange,
  rangeContains,
  rangePercent,
  rangesOverlap,
  timelinePercent,
  type TimelineMark,
  type TimelineRange,
} from "./geometry";

export {
  NEW_INTERACTION_SECONDS,
  RECORDED_ORIGIN_MS,
  choreographyWindow,
  recordedWindow,
} from "./clip-window";

export {
  TIMELINE_TIME_QUANTUM_S,
  formatSeconds,
  isOnTimeGrid,
  snapToTimeGrid,
} from "./grid";

export { interactionIdsThatWouldCycle, wouldCycle } from "./chains";

export { tickStepSeconds, timelineTicks } from "./ticks";

export {
  authoredContentEndSeconds,
  resolveInteractionLayout,
  timingContextFor,
  type ResolvedInteraction,
} from "./resolve";

export {
  createTimelineLaneRegistry,
  type TimelineLaneKind,
  type TimelineLaneRegistry,
  type TimelineLaneSource,
  type TimelineLaneSpan,
} from "./lane-registry";
