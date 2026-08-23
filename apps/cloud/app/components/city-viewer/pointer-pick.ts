/**
 * Telling a PLACE-A-POINT click apart from the end of an orbit drag.
 *
 * The twin's camera controller owns pointer events on the canvas: press-drag
 * orbits, wheel zooms. Authoring wants a third meaning for the same button —
 * "put a path point here" — and the naive wiring (place on `pointerup`) puts a
 * point down every time the author finishes looking around. That is not a
 * cosmetic bug: the whole gesture of framing a junction before drawing through
 * it would litter the path with points nobody asked for.
 *
 * So a pick is a TAP: pressed and released in nearly the same place, quickly.
 * Both bounds are needed. Distance alone would fire on a slow, careful press
 * that the author meant as a nudge of the camera; duration alone would fire on
 * a fast flick-orbit.
 *
 * Pure and separate from the component so the thresholds are testable without a
 * WebGPU canvas — this file is the whole of the interaction's decision-making.
 */

/** Slop for a "same place" release, in CSS pixels. Covers hand tremor and trackpad drift. */
export const TAP_MAX_MOVE_PX = 5;

/**
 * A press longer than this reads as deliberate camera work even if it did not
 * move far. Generous enough not to punish a considered click.
 */
export const TAP_MAX_DURATION_MS = 400;

export interface PointerSample {
  clientX: number;
  clientY: number;
  /** `event.timeStamp` — monotonic and already on the event. */
  timeStamp: number;
}

/** Did this press/release pair mean "here", rather than "let me look around"? */
export function isTap(down: PointerSample, up: PointerSample): boolean {
  const dx = up.clientX - down.clientX;
  const dy = up.clientY - down.clientY;
  if (Math.hypot(dx, dy) > TAP_MAX_MOVE_PX) return false;
  // Guard against a non-monotonic or missing timestamp reporting a negative
  // duration, which would otherwise pass the bound and place a stray point.
  const elapsed = up.timeStamp - down.timeStamp;
  return elapsed >= 0 && elapsed <= TAP_MAX_DURATION_MS;
}

/**
 * Canvas-relative client coordinates to normalised device coordinates.
 *
 * NDC is x right, y UP, both in [-1, 1] — the y flip against CSS pixel space is
 * the part that is silently wrong if you skip it, because a click in the top
 * half of the canvas picks the bottom half of the scene and the error looks
 * like a projection bug rather than a sign error.
 */
export function toNdc(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { ndcX: number; ndcY: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    ndcX: ((clientX - rect.left) / rect.width) * 2 - 1,
    ndcY: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}
