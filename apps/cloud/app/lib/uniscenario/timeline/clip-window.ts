/** The editor's visible recording window. Authoring and playback both begin at t=0. */

import type { Choreography } from "@uniscenarios/scenario-model";

import type { TimelineRange } from "./geometry";

/** The first authored and recorded instant. */
export const RECORDED_ORIGIN_MS = 0;

/** The editor's single visible playback window, in milliseconds. */
export function choreographyWindow(choreography: Choreography): TimelineRange {
  return {
    startMs: RECORDED_ORIGIN_MS,
    endMs: choreography.clipSeconds * 1000,
  };
}

/** The recorded portion — identical to the authoring window. */
export function recordedWindow(choreography: Choreography): TimelineRange {
  return { startMs: RECORDED_ORIGIN_MS, endMs: choreography.clipSeconds * 1000 };
}

/**
 * How long a freshly added interaction occupies before the author narrows it.
 *
 * Bounded on purpose, inherited from v1. In v2 the seeded `until` is a trigger rather than a duration,
 * so this is the `at` time a new interaction's `until` is seeded to, relative to its start. An absent
 * `until` would be legal and would swallow the rest of the clip, leaving the next `+` nowhere to go.
 */
export const NEW_INTERACTION_SECONDS = 3;
