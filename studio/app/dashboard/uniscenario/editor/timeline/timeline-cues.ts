import {
  axisTimeline,
  earliestOf,
  latestOf,
  type Axis,
  type ScenarioTemplateV2,
} from "@simforge/scenario";

import { timingContextFor } from "@/app/lib/uniscenario/timeline";

export type TimelineCause = "time" | "event";
export type TimelineConflict = "conflict" | "possible";

export type TimelineCue = {
  cause: TimelineCause;
  deadlineS: number | null;
  conflict: TimelineConflict | null;
  controlLabel: string;
};

/**
 * Compact, plain-language timeline cues derived from the same timing analysis
 * used by validation. This never invents runtime results: it only describes
 * authored triggers and overlaps the static model can prove or cannot rule out.
 */
export function buildTimelineCues(
  template: ScenarioTemplateV2,
): ReadonlyMap<string, TimelineCue> {
  const cues = new Map<string, TimelineCue>();
  const context = timingContextFor(template);

  for (const timeline of axisTimeline(template.choreography.interactions, context)) {
    const controlLabel = timelineControlLabel(timeline.axis);
    for (const slot of timeline.slots) {
      const trigger = slot.interaction.trigger;
      cues.set(slot.interaction.id, {
        cause: trigger.kind === "at" ? "time" : "event",
        deadlineS:
          trigger.kind === "when" &&
          typeof trigger.byLatest === "number" &&
          Number.isFinite(trigger.byLatest)
            ? trigger.byLatest
            : null,
        conflict: null,
        controlLabel,
      });
    }

    for (let leftIndex = 0; leftIndex < timeline.slots.length; leftIndex += 1) {
      const left = timeline.slots[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < timeline.slots.length; rightIndex += 1) {
        const right = timeline.slots[rightIndex];
        if (!right) continue;

        if (left.start.kind === "exact" && right.start.kind === "exact") {
          if (
            left.start.t === right.start.t ||
            (left.declaredEnd?.kind === "exact" && right.start.t < left.declaredEnd.t)
          ) {
            markConflict(cues, left.interaction.id, "conflict");
            markConflict(cues, right.interaction.id, "conflict");
          }
          continue;
        }

        if (
          left.start.kind === "window" &&
          right.start.kind === "window" &&
          earliestOf(left.start) <= latestOf(right.start) &&
          earliestOf(right.start) <= latestOf(left.start)
        ) {
          markConflict(cues, left.interaction.id, "possible");
          markConflict(cues, right.interaction.id, "possible");
        }
      }
    }
  }

  return cues;
}

export function timelineCauseLabel(cause: TimelineCause): "Time" | "Event" {
  return cause === "time" ? "Time" : "Event";
}

export function timelineConflictMessage(cue: TimelineCue): string | null {
  if (cue.conflict === "conflict") {
    return `Another action controls ${cue.controlLabel} at the same time`;
  }
  if (cue.conflict === "possible") {
    return `Another ${cue.controlLabel} action may start in the same window`;
  }
  return null;
}

function markConflict(
  cues: Map<string, TimelineCue>,
  interactionId: string,
  conflict: TimelineConflict,
) {
  const cue = cues.get(interactionId);
  if (!cue || cue.conflict === "conflict") return;
  cues.set(interactionId, { ...cue, conflict });
}

function timelineControlLabel(axis: Axis): string {
  switch (axis) {
    case "longitudinal":
      return "speed";
    case "lateral":
      return "steering";
    case "topology":
      return "route";
    case "existence":
      return "presence";
    default:
      return "the same setting";
  }
}
