import type { JunctionSignalPlan, ScenarioEditorActorDraft } from "@simcloud/shared";


/**
 * Clips that are authored, valid, and cannot ever do anything.
 *
 * A clip that fails validation is loud. A clip that PASSES validation and then
 * never fires is silent, and silence is what this whole thread has been about:
 * the scenario looks authored, the timeline draws a bar, the gates go green, and
 * the car does not do the thing. The eval harness has been warning about the
 * shape below since `a4793af33` — but only an agent running the harness ever saw
 * that warning, never an author in the editor.
 *
 * Kept as a pure function over drafts so the rule has one statement and the hook
 * is only a publisher.
 */

export type InertClip = {
  actorId: string;
  actorLabel: string;
  clipId: string;
  clipLabel: string;
  reason: string;
};

/**
 * A drive-by-points actor whose ONE clip waits for a condition.
 *
 * The actor is placed on a path, so the path controller starts driving it at
 * t=0 — there is no "not yet" state for it to be in. The condition is evaluated
 * on the first tick, latches whatever it reads, and is spent. Whatever the clip
 * was meant to add on top of the drive never arrives, and the actor simply
 * drives its polyline as though the clip were not there.
 *
 * The fix is the same one the model now supports end to end: give it a baseline
 * and lay the conditional clip over that, so there is something for the
 * condition to interrupt.
 */
function pathActorWithOnlyAConditionalClip(
  actor: ScenarioEditorActorDraft,
): InertClip | null {
  if (actor.kind !== "vehicle") return null;
  if (actor.placement_mode !== "path" && actor.placement_mode !== "timed_path") return null;
  const clips = actor.behavior?.clips ?? [];
  if (clips.length !== 1) return null;
  const clip = clips[0]!;
  if (clip.trigger.kind === "at_time") return null;
  return {
    actorId: actor.id,
    actorLabel: actor.label || actor.id,
    clipId: clip.id,
    clipLabel: clip.label || clip.id,
    reason:
      `its only clip waits for "${clip.trigger.kind}", but a drive-by-points actor is already ` +
      "driving at t=0 — the condition latches on the first tick and is spent, so the clip never " +
      "does anything. Give the actor a baseline clip and lay this one over it.",
  };
}

/**
 * Clips that are waiting for each other.
 *
 * `after_clip` means "not until that one is done", so a ring of them — A after
 * B, B after A, or any longer loop — is a set of clips each waiting on a clip
 * that is waiting on it. Not one of them ever starts.
 *
 * Nothing else catches this. The schema is satisfied, because every id in the
 * ring resolves to a real clip. The timeline draws bars for all of them,
 * because `effectiveClipStarts` breaks the cycle at t=0 rather than throwing —
 * a half-authored program still has to render. And both runtimes simply never
 * fire the triggers, so the scenario runs, passes, and does nothing.
 *
 * It is also one dropdown away: the parent picker offers every other clip on
 * the actor, including the one already pointing back.
 */
function clipsWaitingOnEachOther(
  actor: ScenarioEditorActorDraft,
): InertClip[] {
  const clips = actor.behavior?.clips ?? [];
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const parentOf = new Map<string, string>();
  for (const clip of clips) {
    if (clip.trigger.kind === "after_clip") {
      parentOf.set(clip.id, clip.trigger.clip_id);
    }
  }

  const nameOf = (id: string) => byId.get(id)?.label || id;
  /** Every clip id that sits on a ring, found once however many walks reach it. */
  const onARing = new Set<string>();

  for (const start of parentOf.keys()) {
    if (onARing.has(start)) continue;
    const walked = new Set<string>();
    let at: string | undefined = start;
    let looped: string | null = null;
    while (at != null) {
      if (walked.has(at)) {
        looped = at;
        break;
      }
      walked.add(at);
      const next = parentOf.get(at);
      // The chain either terminates in a clip that waits on something real, or
      // dangles. A dangling parent is a different defect with its own message.
      if (next == null || !byId.has(next)) break;
      at = next;
    }
    if (looped == null) continue;
    let node = looped;
    do {
      onARing.add(node);
      node = parentOf.get(node)!;
    } while (node !== looped);
  }

  if (onARing.size === 0) return [];

  const ring = [...onARing].map(nameOf).join(" → ");
  return clips
    .filter((clip) => onARing.has(clip.id))
    .map((clip) => ({
      actorId: actor.id,
      actorLabel: actor.label || actor.id,
      clipId: clip.id,
      clipLabel: clip.label || clip.id,
      reason:
        `its chain loops back on itself (${ring} → …), so every clip in the loop is waiting ` +
        "for one that is waiting for it and none of them ever starts. Point one of them at a " +
        "time or a condition instead.",
    }));
}

/**
 * A light the scene never planned.
 *
 * `AUTHORING.md` §Signals has said this since D2's first iteration, and only an
 * agent reading that file ever saw it: an unplanned junction is forced green and
 * emits no state change, so a clip waiting for one waits forever. Waiting for
 * `green` specifically is worse than useless — it is already green at spawn, so
 * the trigger latches on the first tick, is spent, and looks in the event log
 * exactly like a trigger that worked.
 *
 * Gate A now fails closed on the corpus version of this (`78cd40ec2`). This is
 * the same question asked in the editor, where the author can still fix it.
 */
function signalTriggersOnAnUnplannedJunction(
  actor: ScenarioEditorActorDraft,
  signalPlans: readonly JunctionSignalPlan[],
): InertClip[] {
  const planned = new Set(signalPlans.map((plan) => String(plan.junction_id)));
  const found: InertClip[] = [];
  for (const clip of actor.behavior?.clips ?? []) {
    // The end trigger matters as much as the start one: a `stop` held until a
    // light turns green is the documented way to author signal compliance, and
    // it is the half that strands the actor when the junction has no plan.
    const triggers = [
      clip.trigger,
      ...(clip.end.kind === "until_trigger" ? [clip.end.trigger] : []),
    ];
    for (const trigger of triggers) {
      if (trigger.kind !== "signal_state") continue;
      const junctionId = String(trigger.signal.junction_id);
      if (planned.has(junctionId)) continue;
      found.push({
        actorId: actor.id,
        actorLabel: actor.label || actor.id,
        clipId: clip.id,
        clipLabel: clip.label || clip.id,
        reason:
          `it waits for junction ${junctionId} to turn ${trigger.state}, but the scene declares no ` +
          "signal plan there. An unplanned junction is forced green and never changes state, so " +
          `${trigger.state === "green" ? "the trigger latches at t=0 and is spent" : "the trigger never fires"}` +
          ". Author a signal plan for that junction, or trigger on something else.",
      });
      break;
    }
  }
  return found;
}

const RULES: readonly ((
  actor: ScenarioEditorActorDraft,
  signalPlans: readonly JunctionSignalPlan[],
) => InertClip | InertClip[] | null)[] = [
  pathActorWithOnlyAConditionalClip,
  clipsWaitingOnEachOther,
  signalTriggersOnAnUnplannedJunction,
];

/** Every inert clip across the scene, in actor order. */
export function inertClips(
  actors: readonly ScenarioEditorActorDraft[],
  signalPlans: readonly JunctionSignalPlan[] = [],
): InertClip[] {
  const found: InertClip[] = [];
  for (const actor of actors) {
    for (const rule of RULES) {
      const hit = rule(actor, signalPlans);
      if (!hit) continue;
      if (Array.isArray(hit)) found.push(...hit);
      else found.push(hit);
    }
  }
  return found;
}

/** One line per inert clip, for the notification's detail block. */
export function inertClipsDetail(clips: readonly InertClip[]): string {
  return clips.map((clip) => `${clip.actorLabel} — "${clip.clipLabel}": ${clip.reason}`).join("\n");
}
