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

export { tickStepSeconds, timelineTicks } from "./ticks";

export {
  authoredContentEndSeconds,
  resolveInteractionLayout,
  timingContextFor,
  type ResolvedInteraction,
} from "./resolve";
