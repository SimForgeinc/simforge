/**
 * Interaction layout: turning the model's static timing analysis into rail geometry.
 *
 * ## This is an adapter, not a resolver
 *
 * v1 computed clip starts itself, in `timeline-model.ts::computeClipStarts` — walking `after_clip`
 * chains, guarding cycles, falling back to t=0. v2 does not need that ported, because
 * `@uniscenarios/scenario-model` already does the whole analysis in `validate/timing.ts`:
 * `resolveTriggerTime` and `endBound` handle `at` / `after` / `when` / `arrival`, evaluate parameter
 * expressions at their declared defaults, guard `after` cycles, and honour the `event: 'start' | 'end'`
 * distinction that v1 had no equivalent for.
 *
 * Writing a second implementation here would be the worst kind of duplicate: two static analysers that
 * agree today and drift later, whose disagreement surfaces as "the validator says this fires at 3.5 s
 * but the timeline draws it somewhere else" — a bug that looks like a rendering defect and is not one.
 * So this module owns exactly one thing the model deliberately does not: how a `TimeBound` becomes a
 * rectangle.
 *
 * ## How indeterminacy is drawn
 *
 * The model returns three kinds of answer and never guesses. This layer must draw something anyway, so
 * it draws the earliest instant the interaction could fire and flags the chip `armed`. That is a
 * presentation decision, and it is why `armed` is on the returned record rather than baked into the
 * position: the UI must be able to say "somewhere from here" instead of quietly asserting a time the
 * analysis never claimed.
 */

import {
  earliestOf,
  endBound,
  interactionAxis,
  latestOf,
  resolveTriggerTime,
  staticScope,
  type Axis,
  type Interaction,
  type ScenarioTemplateV2,
  type TimingContext,
} from "@uniscenarios/scenario-model";

import { choreographyWindow } from "./clip-window";
import type { TimelineRange } from "./geometry";

/** One interaction, laid out on the rail. The v2 reshape of v1's `ResolvedBehaviorClip`. */
export type ResolvedInteraction = {
  interaction: Interaction;
  /** Index in `choreography.interactions` — the stable identity for issue paths and document ops. */
  index: number;
  /** The role that performs it, or `@world`. Lane assignment keys on this. */
  actor: string;
  /** The control axis it owns while active. Two interactions on one axis cannot both hold it. */
  axis: Axis;
  /** Layout rectangle in milliseconds, clamped into the clip window. */
  range: TimelineRange;
  /**
   * The start on screen is the earliest instant it *could* fire, not a time the analysis claims: a
   * condition trigger, a back-solved arrival, or an expression that reads a site fact no template
   * knows yet.
   */
  armed: boolean;
  /** No `until` was authored, so the right edge is the window edge rather than an authored value. */
  openEnded: boolean;
  /** Set when an `after` trigger chains this interaction to another one. */
  chainedTo: { id: string; event: "start" | "end" } | null;
};

/** Build the timing context the model's analysis needs from a template. */
export function timingContextFor(template: ScenarioTemplateV2): TimingContext {
  const { choreography } = template;
  return {
    clipStart: -choreography.warmupSeconds,
    clipEnd: choreography.clipSeconds,
    scope: staticScope(template),
    byId: new Map(choreography.interactions.map((it) => [it.id, it])),
  };
}

/**
 * Lay every interaction out against the clip window.
 *
 * Document order is preserved. Grouping into lanes is the caller's job, because who gets a lane is a
 * view decision — the same interaction belongs to an actor lane in one panel and to an axis lane in
 * another.
 */
export function resolveInteractionLayout(
  template: ScenarioTemplateV2,
): ResolvedInteraction[] {
  const ctx = timingContextFor(template);
  const window = choreographyWindow(template.choreography);

  return template.choreography.interactions.map((interaction, index) => {
    const start = resolveTriggerTime(interaction.trigger, ctx);
    const end = endBound(interaction, ctx);
    const startMs = earliestOf(start) * 1000;
    // `until` earlier than its own trigger is a real authoring error, and the model already reports it
    // as `until_before_trigger`. Clamping here keeps the rectangle non-negative without competing with
    // that message: a zero-width chip plus a validator error beats an inverted rectangle plus both.
    const endMs = Math.max(startMs, latestOf(end) * 1000);

    return {
      interaction,
      index,
      actor: interaction.actor,
      axis: interactionAxis(interaction),
      range: {
        startMs: Math.max(window.startMs, Math.min(startMs, window.endMs)),
        endMs: Math.max(window.startMs, Math.min(endMs, window.endMs)),
      },
      armed: start.kind !== "exact",
      openEnded: interaction.until === undefined,
      chainedTo:
        interaction.trigger.kind === "after"
          ? { id: interaction.trigger.of, event: interaction.trigger.event }
          : null,
    };
  });
}

/**
 * The last authored moment in a choreography, seconds — v1's `programContentEndSeconds`.
 *
 * Drives the dock's duration floor: shortening `clipSeconds` below this hides authored work rather
 * than deleting it, so the control that shortens the clip needs to know where the content ends.
 * Indeterminate ends do not extend it, because an open-ended interaction already runs to the clip edge
 * by definition and would otherwise pin the floor to the current length forever.
 */
export function authoredContentEndSeconds(template: ScenarioTemplateV2): number {
  const ctx = timingContextFor(template);
  let end = 0;
  for (const interaction of template.choreography.interactions) {
    const start = resolveTriggerTime(interaction.trigger, ctx);
    end = Math.max(end, earliestOf(start));
    if (interaction.until) {
      const declared = resolveTriggerTime(interaction.until, ctx);
      if (declared.kind === "exact") end = Math.max(end, declared.t);
    }
  }
  return end;
}
