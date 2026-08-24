/**
 * The grader — scalar score in [0, 1] plus per-claim verdicts (WS7 contract).
 *
 * Two components, C2-Faith style:
 *
 * - `causality` — correctness of what the candidate *asserts*: the pass rate
 *   of deterministic claims under the checkers (wrong occlusion states,
 *   reversed trigger order, phantom intents, wrong spatial relations all
 *   push this down).
 *
 * - `coverage` — recall against the engine-derived true claim set: the
 *   fraction of ground-truth propositions the candidate accounts for
 *   (deleted actors, unmentioned conflicts push this down).
 *
 * The scalar score is a weighted mean (`causalityWeight`, default 0.5/0.5).
 * Coverage matching is type + actor + temporal-overlap + payload-compat.
 */

import { checkClaims, type Verdict } from './checkers.js';
import type { Claim } from './claims.js';
import { deriveTrueClaims } from './ground-truth.js';
import type { CorpusScenario } from './corpus.js';

export interface GraderOptions {
  /** Weight of the causality component in the scalar score; coverage gets the rest. */
  readonly causalityWeight?: number;
  /** Derive ground truth externally instead of inside the grader. */
  readonly trueClaims?: readonly Claim[];
}

export interface UncoveredTruth {
  /** The ground-truth claim id that no candidate claim covered. */
  readonly truthClaimId: string;
  readonly type: Claim['type'];
  readonly actorIds: readonly string[];
}

export interface GraderReport {
  /** Scalar in [0,1]: causalityWeight × causality + (1−w) × coverage. */
  readonly score: number;
  /** Pass rate of the candidate's own deterministic claims. */
  readonly causality: number;
  /** Recall of the engine-derived true claim set. */
  readonly coverage: number;
  readonly verdicts: readonly Verdict[];
  /** True claims no candidate claim accounted for — the audit trail for `coverage`. */
  readonly uncoveredTruth: readonly UncoveredTruth[];
  /** Candidate claim ids flagged by the deterministic checkers. */
  readonly failedClaimIds: readonly string[];
}

/** Half-open interval overlap on decision seconds. */
function overlaps(a: { fromTS: number; toTS: number }, b: { fromTS: number; toTS: number }): boolean {
  return a.fromTS < b.toTS && b.fromTS < a.toTS;
}

/** Do two claims of the same type assert compatible payloads? */
function payloadCompatible(truth: Claim, candidate: Claim): boolean {
  if (truth.type !== candidate.type) return false;
  switch (truth.type) {
    case 'visibility': {
      const t = truth as Extract<Claim, { type: 'visibility' }>;
      const c = candidate as Extract<Claim, { type: 'visibility' }>;
      return t.state === c.state;
    }
    case 'spatial': {
      const t = truth as Extract<Claim, { type: 'spatial' }>;
      const c = candidate as Extract<Claim, { type: 'spatial' }>;
      if (t.relation !== c.relation) return false;
      const ref = (c as { referenceActorId?: string }).referenceActorId ?? undefined;
      return ref === undefined || ref === ((t as unknown as { referenceActorId?: string }).referenceActorId ?? undefined);
    }
    case 'intent': {
      const t = truth as Extract<Claim, { type: 'intent' }>;
      const c = candidate as Extract<Claim, { type: 'intent' }>;
      return t.verb === c.verb;
    }
    case 'causal-trigger': {
      const t = truth as Extract<Claim, { type: 'causal-trigger' }>;
      const c = candidate as Extract<Claim, { type: 'causal-trigger' }>;
      return t.cause.kind === c.cause.kind && t.effect.kind === c.effect.kind && t.relation === c.relation;
    }
  }
}

function covers(truth: Claim, candidate: Claim): boolean {
  return (
    truth.type === candidate.type &&
    truth.actorIds.some((a) => candidate.actorIds.includes(a)) &&
    overlaps(truth.tickRange, candidate.tickRange) &&
    payloadCompatible(truth, candidate)
  );
}

/**
 * Grade one claim set against engine ground truth.
 * Pure: same inputs, same report, every time.
 */
export function grade(scenario: CorpusScenario, candidate: readonly Claim[], options: GraderOptions = {}): GraderReport {
  const weight = options.causalityWeight ?? 0.5;
  const verdicts = checkClaims(scenario, candidate);
  const judged = verdicts.filter((v) => v.status === 'pass' || v.status === 'fail');
  const passed = judged.filter((v) => v.status === 'pass').length;
  const causality = judged.length === 0 ? 1 : passed / judged.length;

  const truth = options.trueClaims ?? deriveTrueClaims(scenario);
  const uncovered: UncoveredTruth[] = [];
  for (const g of truth) {
    if (!candidate.some((c) => covers(g, c))) {
      uncovered.push({ truthClaimId: g.id, type: g.type, actorIds: g.actorIds });
    }
  }
  const coverage = truth.length === 0 ? 1 : (truth.length - uncovered.length) / truth.length;

  return {
    score: weight * causality + (1 - weight) * coverage,
    causality,
    coverage,
    verdicts,
    uncoveredTruth: uncovered,
    failedClaimIds: verdicts.filter((v) => v.status === 'fail').map((v) => v.claimId),
  };
}
