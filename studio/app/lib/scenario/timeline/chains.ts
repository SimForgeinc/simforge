/**
 * `after` chains: asking about a cycle BEFORE the author commits to one.
 *
 * The model reports a closed chain as `trigger_cycle`, and `resolveTriggerTime` degrades a cyclic
 * chain to the full window rather than recursing — so nothing here is a safety net. This answers the
 * other version of the question: given that the author is about to pick a parent from a list, which
 * entries in that list would close a ring?
 *
 * The difference is the whole point. A validator issue arrives after the mistake, on a document that
 * now has a ring in it, and every interaction in the ring waits for one that waits for it, so none of
 * them ever fires. A disabled option in the picker means the mistake was never available. Both are
 * wanted; only one of them needs the author to read an error list.
 *
 * This is the v2 reshape of v1's `clipIdsThatWouldLoop`, which walked `after_clip` parents. v2's
 * `after` also carries `event: 'start' | 'end'`, but the cycle question ignores it: waiting for either
 * end of an interaction that is waiting for you is the same deadlock.
 */

import type { Interaction } from "@simforge/scenario";

/**
 * Ids that already chain back to `interactionId`, directly or through others.
 *
 * Naming one of these as `interactionId`'s `after` target closes a ring. `interactionId` itself is
 * excluded from the result — a self-reference is a distinct mistake the model reports as
 * `self_reference`, and reporting it here as well would put the same entry behind two explanations.
 */
export function interactionIdsThatWouldCycle(
  interactionId: string,
  interactions: readonly Interaction[],
): Set<string> {
  const parentOf = new Map<string, string>();
  for (const interaction of interactions) {
    if (interaction.trigger.kind === "after") {
      parentOf.set(interaction.id, interaction.trigger.of);
    }
  }

  const cycling = new Set<string>();
  for (const candidate of interactions) {
    if (candidate.id === interactionId) continue;
    // `walked` also terminates on a ring that does NOT include `interactionId`: a chain that is already
    // broken elsewhere must not hang this walk, because the picker still has to render.
    const walked = new Set<string>([candidate.id]);
    let at = parentOf.get(candidate.id);
    while (at !== undefined && !walked.has(at)) {
      if (at === interactionId) {
        cycling.add(candidate.id);
        break;
      }
      walked.add(at);
      at = parentOf.get(at);
    }
  }
  return cycling;
}

/** Whether pointing `interactionId`'s `after` trigger at `parentId` would close a ring. */
export function wouldCycle(
  interactionId: string,
  parentId: string,
  interactions: readonly Interaction[],
): boolean {
  if (interactionId === parentId) return true;
  return interactionIdsThatWouldCycle(interactionId, interactions).has(parentId);
}
