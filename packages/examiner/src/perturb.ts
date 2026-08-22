/**
 * Controlled perturbations with known error positions — the FACT-E /
 * C2-Faith pattern that makes the grader itself measurable.
 *
 * Each operator takes a true claim set (derived by `ground-truth.ts` from a
 * real simulated trace) and corrupts it in exactly one known way, returning
 * the corrupted set plus the injected error record (which claim, which
 * operation, which actor). The benchmark then asks: did the grader flag it?
 */

import type { Claim } from './claims.js';


export type PerturbationOp =
  | 'flip-visibility'
  | 'reverse-trigger-order'
  | 'wrong-intent'
  | 'flip-spatial-relation'
  | 'delete-actor'
  | 'insert-phantom-actor';

/** A known injected error and where it lives. */
export interface InjectedError {
  readonly op: PerturbationOp;
  /** Corrupted claim id when the error is an assertion; absent for deletions. */
  readonly claimId?: string;
  /** Actor the error is about. */
  readonly actorId?: string;
  readonly detail: string;
}

export interface PerturbedCase {
  readonly scenarioId: string;
  readonly caseId: string;
  /** `null` errors = clean control case. */
  readonly errors: readonly InjectedError[];
  readonly claims: readonly Claim[];
}

const FLIP_VISIBILITY: Record<'visible' | 'occluded', 'visible' | 'occluded'> = {
  visible: 'occluded',
  occluded: 'visible',
};

function clone(claims: readonly Claim[]): Claim[] {
  return claims.map((c) => structuredClone(c));
}

interface Target {
  readonly index: number;
  readonly claim: Claim;
}

/**
 * All applicable single-error perturbation targets for one scenario's true
 * claim set, in deterministic order. Empty arrays for ops with no target.
 */
export function perturbationTargets(trueClaims: readonly Claim[]): Record<PerturbationOp, Target[]> {
  const out = {
    'flip-visibility': [] as Target[],
    'reverse-trigger-order': [] as Target[],
    'wrong-intent': [] as Target[],
    'flip-spatial-relation': [] as Target[],
    'delete-actor': [] as Target[],
    'insert-phantom-actor': [] as Target[],
  };
  const actors = [...new Set(trueClaims.flatMap((c) => c.actorIds))].sort();
  for (let i = 0; i < trueClaims.length; i++) {
    const c = trueClaims[i]!;
    if (c.type === 'visibility' && c.checkable === 'deterministic') {
      out['flip-visibility'].push({ index: i, claim: c });
    }
    if (c.type === 'causal-trigger') out['reverse-trigger-order'].push({ index: i, claim: c });
    if (c.type === 'intent') out['wrong-intent'].push({ index: i, claim: c });
    if (c.type === 'spatial' && c.relation !== 'within-distance' && c.relation !== 'same-lane') {
      out['flip-spatial-relation'].push({ index: i, claim: c });
    }
    if (c.checkable === 'deterministic' && actors.length > 1 && !out['insert-phantom-actor'].length) {
      out['insert-phantom-actor'].push({ index: i, claim: c });
    }
  }
  // delete-actor: one target per actor with at least one deterministic claim.
  for (const a of actors) {
    const hasDeterministic = trueClaims.some((c) => c.actorIds.includes(a) && c.checkable === 'deterministic');
    if (hasDeterministic) out['delete-actor'].push({ index: -1, claim: { ...trueClaims[0]!, actorIds: [a] } });
  }
  return out;
}

/**
 * Apply one perturbation at the given target. Returns the corrupted set plus
 * the known error position, or null when the op cannot apply cleanly.
 */
export function applyPerturbation(
  caseId: string,
  scenarioId: string,
  trueClaims: readonly Claim[],
  op: PerturbationOp,
  target: Target,
): PerturbedCase | null {
  const claims = clone(trueClaims);
  switch (op) {
    case 'flip-visibility': {
      const c = claims[target.index];
      if (!c || c.type !== 'visibility') return null;
      const flipped = FLIP_VISIBILITY[c.state];
      claims[target.index] = { ...c, state: flipped };
      return {
        scenarioId,
        caseId,
        claims,
        errors: [{ op, claimId: c.id, actorId: c.actorIds[0], detail: `visibility flipped to ${flipped}` }],
      };
    }
    case 'reverse-trigger-order': {
      const c = claims[target.index];
      if (!c || c.type !== 'causal-trigger') return null;
      // Swap cause and effect; keep relation valid only if it truly reverses.
      claims[target.index] = { ...c, cause: c.effect, effect: c.cause };
      return {
        scenarioId,
        caseId,
        claims,
        errors: [{
          op,
          claimId: c.id,
          actorId: c.actorIds[0],
          detail: `trigger order reversed: ${c.effect.kind} now claimed before ${c.cause.kind}`,
        }],
      };
    }
    case 'wrong-intent': {
      const c = claims[target.index];
      if (!c || c.type !== 'intent') return null;
      const wrong = c.verb === 'speed' ? 'changeLane' : 'speed';
      claims[target.index] = { ...c, verb: wrong };
      return {
        scenarioId,
        caseId,
        claims,
        errors: [{ op, claimId: c.id, actorId: c.actorIds[0], detail: `intent verb replaced with ${wrong}` }],
      };
    }
    case 'flip-spatial-relation': {
      const c = claims[target.index];
      if (!c || c.type !== 'spatial') return null;
      const flip: Record<string, string> = {
        'ahead-of': 'behind',
        behind: 'ahead-of',
        'left-of': 'right-of',
        'right-of': 'left-of',
      };
      const flipped = flip[c.relation];
      if (!flipped) return null;
      claims[target.index] = { ...c, relation: flipped as typeof c.relation };
      return {
        scenarioId,
        caseId,
        claims,
        errors: [{ op, claimId: c.id, actorId: c.actorIds[0], detail: `spatial relation flipped to ${flipped}` }],
      };
    }
    case 'delete-actor': {
      const actorId = target.claim.actorIds[0]!;
      const remaining = claims.filter((c) => !c.actorIds.includes(actorId));
      if (remaining.length === 0) return null;
      return {
        scenarioId,
        caseId,
        claims: remaining,
        errors: [{ op, actorId, detail: `all claims about "${actorId}" deleted` }],
      };
    }
    case 'insert-phantom-actor': {
      const anchor = claims[target.index];
      if (!anchor) return null;
      const phantom: Claim =
        anchor.type === 'spatial'
          ? { ...structuredClone(anchor), id: `${caseId}-phantom`, actorIds: ['phantom-vru'] }
          : {
              schema: anchor.schema,
              id: `${caseId}-phantom`,
              type: 'visibility',
              actorIds: ['phantom-vru'],
              tickRange: anchor.tickRange,
              checkable: 'deterministic',
              state: 'occluded',
            };
      return {
        scenarioId,
        caseId,
        claims: [...clone(claims), phantom],
        errors: [{ op, claimId: phantom.id, actorId: 'phantom-vru', detail: 'hallucinated actor inserted' }],
      };
    }
  }
}
