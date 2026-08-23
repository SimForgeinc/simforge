import type { Interaction } from './input.js';

export interface RemovedDanglingInteraction {
  readonly interactionId: string;
  readonly missingInteractionId: string;
}

/**
 * Remove concrete commands whose `after()` source no longer exists.
 *
 * This is intentionally not part of authored-template parsing: a genuinely
 * dangling source reference is an authoring error. Materializers call this
 * only after site degradation or legacy-evidence migration has deliberately
 * removed commands, making their dependants stale as well. Iteration handles
 * transitive chains atomically.
 */
export function pruneDanglingAfterInteractions(
  interactions: readonly Interaction[],
): { interactions: Interaction[]; removed: RemovedDanglingInteraction[] } {
  let kept = [...interactions];
  const removed: RemovedDanglingInteraction[] = [];
  for (;;) {
    const ids = new Set(kept.map((interaction) => interaction.id));
    const stale = kept.filter((interaction) => interaction.trigger.kind === 'after'
      && !ids.has(interaction.trigger.interactionId));
    if (stale.length === 0) break;
    const staleIds = new Set(stale.map((interaction) => interaction.id));
    for (const interaction of stale) {
      removed.push({
        interactionId: interaction.id,
        missingInteractionId: interaction.trigger.kind === 'after'
          ? interaction.trigger.interactionId
          : '',
      });
    }
    kept = kept.filter((interaction) => !staleIds.has(interaction.id));
  }
  return { interactions: kept, removed };
}
