import type { Interaction } from "@uniscenarios/scenario-model";

import { snapToTimeGrid } from "./grid";
import type { TimelineRange } from "./geometry";

export type TimelineClipEditMode = "move" | "resize-start" | "resize-end";

export type AuthoredTimelineRange = {
  readonly startS: number;
  readonly endS: number;
};

export type TimelineRowItem = {
  readonly range: TimelineRange;
  readonly interaction: { readonly id: string };
};

/**
 * Match UniScenario's compact interaction layout: a timeline starts with one
 * row and only grows another parallel row when two visible action ranges
 * overlap. Adjacent actions share a row because their half-open ranges never
 * occupy the same instant.
 */
export function packTimelineInteractionRows<T extends TimelineRowItem>(
  items: readonly T[],
): readonly (readonly T[])[] {
  const rows: T[][] = [];
  const sorted = [...items].sort((left, right) =>
    left.range.startMs - right.range.startMs ||
    left.range.endMs - right.range.endMs ||
    left.interaction.id.localeCompare(right.interaction.id),
  );
  for (const item of sorted) {
    let row = rows.find((candidate) => candidate.every((other) => !rangesOverlap(item.range, other.range)));
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(item);
  }
  return rows.length > 0 ? rows : [[]];
}

/**
 * Allocate the conventional `<stem>_<ordinal>` id without trusting array length
 * to imply availability. Imported documents and delete/re-add cycles can leave
 * any ordinal occupied. The suffix is preserved when a long stem is truncated,
 * so advancing the ordinal always advances the candidate as well.
 */
export function uniqueTimelineInteractionId(
  stem: string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds);
  const normalizedStem = stem.replace(/[^A-Za-z0-9_-]/g, "_") || "interaction";
  let ordinal = used.size + 1;
  while (true) {
    const suffix = `_${ordinal}`;
    const candidate = `${normalizedStem.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
    ordinal += 1;
  }
}

/**
 * Timeline gestures may only rewrite two literal, authored edges. An open end,
 * expression, chain, arrival, or condition is useful geometry but is not a value
 * a drag can truthfully replace.
 */
export function authoredTimelineRange(interaction: Interaction): AuthoredTimelineRange | null {
  if (
    interaction.trigger.kind !== "at" ||
    typeof interaction.trigger.t !== "number" ||
    !Number.isFinite(interaction.trigger.t) ||
    interaction.until?.kind !== "at" ||
    typeof interaction.until.t !== "number" ||
    !Number.isFinite(interaction.until.t)
  ) {
    return null;
  }
  return {
    startS: interaction.trigger.t,
    endS: Math.max(interaction.trigger.t, interaction.until.t),
  };
}

export function editAuthoredTimelineRange(
  origin: AuthoredTimelineRange,
  mode: TimelineClipEditMode,
  deltaS: number,
  window: TimelineRange,
  minimumS = 0.1,
): AuthoredTimelineRange {
  const floor = window.startMs / 1000;
  const ceiling = window.endMs / 1000;
  const minimum = Math.max(0.1, minimumS);
  const duration = Math.max(minimum, origin.endS - origin.startS);

  if (mode === "move") {
    const startS = clamp(origin.startS + deltaS, floor, Math.max(floor, ceiling - duration));
    return snappedRange(startS, startS + duration);
  }
  if (mode === "resize-start") {
    return snappedRange(clamp(origin.startS + deltaS, floor, origin.endS - minimum), origin.endS);
  }
  return snappedRange(origin.startS, clamp(origin.endS + deltaS, origin.startS + minimum, ceiling));
}

/** Preserve the interaction's actor, verb, target, dynamics and id verbatim. */
export function interactionWithAuthoredTimelineRange(
  interaction: Interaction,
  range: AuthoredTimelineRange,
): Interaction {
  return {
    ...interaction,
    trigger: { kind: "at", t: snapToTimeGrid(range.startS) },
    until: { kind: "at", t: snapToTimeGrid(range.endS) },
  } as Interaction;
}

export function authoredTimelineRangesEqual(
  left: AuthoredTimelineRange,
  right: AuthoredTimelineRange,
): boolean {
  return left.startS === right.startS && left.endS === right.endS;
}

export function timelineTimeFromClientX(
  clientX: number,
  bounds: Pick<DOMRect, "left" | "width">,
  window: TimelineRange,
): number {
  const fraction = clamp((clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
  return snapToTimeGrid((window.startMs + fraction * (window.endMs - window.startMs)) / 1000);
}

function snappedRange(startS: number, endS: number): AuthoredTimelineRange {
  return { startS: snapToTimeGrid(startS), endS: snapToTimeGrid(endS) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rangesOverlap(left: TimelineRange, right: TimelineRange): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}
