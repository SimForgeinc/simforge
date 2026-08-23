/**
 * The grader benchmark — precision/recall of error recovery on cases with
 * *known* ground truth (FACT-E / C2-Faith controlled-perturbation pattern).
 *
 * For every corpus scenario the engine's own artifacts yield the true claim
 * set; perturbation operators corrupt copies in exactly one known way each;
 * the deterministic grader runs over every case. An injected error counts as
 * recovered when the grader flags exactly its position:
 *
 * - assertion errors (flips, reversals, phantoms): the corrupted claim id
 *   appears in `failedClaimIds`;
 * - deletions: some uncovered ground-truth claim references the deleted actor.
 *
 * Clean control cases must produce zero flags — those are the precision side
 * of the ledger.
 */

import type { Claim } from './claims.js';
import type { CorpusScenario } from './corpus.js';
import { deriveTrueClaims } from './ground-truth.js';
import { grade } from './grader.js';
import { applyPerturbation, perturbationTargets, type InjectedError, type PerturbedCase } from './perturb.js';

export const RECOVERY_GATE = 0.9;

/** Max perturbed cases per operator per scenario (keeps ops balanced). */
export const MAX_TARGETS_PER_OP = 6;

export interface CaseOutcome {
  readonly caseId: string;
  readonly scenarioId: string;
  /** Empty for clean controls. */
  readonly errors: readonly InjectedError[];
  /** Error positions the grader flagged. */
  readonly recovered: readonly string[];
  /** Flags on claims no error touched, or flags on clean controls. */
  readonly spuriousFlags: readonly string[];
  readonly score: number;
  readonly causality: number;
  readonly coverage: number;
}

export interface OpBreakdown {
  injected: number;
  recovered: number;
}

export interface BenchmarkReport {
  readonly benchmarkVersion: 1;
  readonly gate: { readonly threshold: number; readonly recall: number; readonly passed: boolean };
  readonly totals: {
    readonly scenarios: number;
    readonly cases: number;
    readonly cleanControls: number;
    readonly injectedErrors: number;
    readonly recoveredErrors: number;
    readonly spuriousFlags: number;
    readonly precision: number;
    readonly recall: number;
  };
  readonly byOp: Record<string, OpBreakdown>;
  readonly byScenario: ReadonlyArray<{
    readonly scenarioId: string;
    readonly cases: number;
    readonly injected: number;
    readonly recovered: number;
  }>;
  /** Human-readable residual analysis for every unrecovered error. */
  readonly residuals: ReadonlyArray<{ readonly caseId: string; readonly detail: string; readonly reason: string }>;
  readonly outcomes: readonly CaseOutcome[];
}

/** Build every perturbed case (plus one clean control) for one scenario. */
export function buildCases(scenario: CorpusScenario): PerturbedCase[] {
  const truth = deriveTrueClaims(scenario);
  const targets = perturbationTargets(truth);
  const cases: PerturbedCase[] = [
    { scenarioId: scenario.id, caseId: `${scenario.id}__clean`, errors: [], claims: structuredClone(truth) },
  ];
  let n = 0;
  for (const [op, list] of Object.entries(targets)) {
    for (const target of list.slice(0, MAX_TARGETS_PER_OP)) {
      n += 1;
      const c = applyPerturbation(`${scenario.id}__${op}-${n}`, scenario.id, truth, op as never, target);
      if (c) cases.push(c);
    }
  }
  return cases;
}

function evaluate(scenario: CorpusScenario, c: PerturbedCase, truth: readonly Claim[]): CaseOutcome {
  const report = grade(scenario, c.claims, { trueClaims: truth });
  const base = { score: report.score, causality: report.causality, coverage: report.coverage };
  const flagged = new Set(report.failedClaimIds);
  const coveredKeys = report.uncoveredTruth.map((u) => `${u.type}|${u.actorIds.join(',')}`);
  const recovered: string[] = [];
  const spurious: string[] = [];

  if (c.errors.length === 0) {
    for (const f of report.failedClaimIds) spurious.push(f);
    for (const u of report.uncoveredTruth) spurious.push(`uncovered:${u.truthClaimId}`);
    return { ...base, caseId: c.caseId, scenarioId: c.scenarioId, errors: [], recovered, spuriousFlags: spurious };
  }

  for (const e of c.errors) {
    const actorId = e.actorId;
    if (e.claimId !== undefined && flagged.has(e.claimId)) {
      recovered.push(e.claimId);
    } else if (
      e.claimId === undefined &&
      actorId !== undefined &&
      coveredKeys.some((k) => k.split('|')[1]?.split(',').includes(actorId))
    ) {
      recovered.push(`${e.op}:${actorId}`);
    }
  }
  // Any flag not attributable to a known injected position is a spurious flag.
  for (const f of report.failedClaimIds) {
    if (!c.errors.some((e) => e.claimId === f)) spurious.push(f);
  }
  return { ...base, caseId: c.caseId, scenarioId: c.scenarioId, errors: c.errors, recovered, spuriousFlags: spurious };
}

/** Run the full benchmark over a set of scenarios. Pure and deterministic. */
export function runBenchmark(scenarios: readonly CorpusScenario[]): BenchmarkReport {
  const outcomes: CaseOutcome[] = [];
  const byOp: Record<string, OpBreakdown> = {};
  const byScenario: BenchmarkReport['byScenario'][number][] = [];
  const residuals: { caseId: string; detail: string; reason: string }[] = [];

  for (const s of scenarios) {
    let injected = 0;
    let recoveredCount = 0;
    for (const c of buildCases(s)) {
      const outcome = evaluate(s, c, deriveTrueClaims(s));
      outcomes.push(outcome);
      if (c.errors.length > 0) {
        for (const e of c.errors) {
          injected += 1;
          const entry = (byOp[e.op] ??= { injected: 0, recovered: 0 });
          entry.injected += 1;
          if (outcome.recovered.length > 0) {
            recoveredCount += 1;
            entry.recovered += 1;
          } else {
            residuals.push({ caseId: outcome.caseId, detail: e.detail, reason: explainResidual(s, e) });
          }
        }
      }
    }
    byScenario.push({
      scenarioId: s.id,
      cases: outcomes.filter((o) => o.scenarioId === s.id).length,
      injected,
      recovered: recoveredCount,
    });
  }

  const injectedTotal = Object.values(byOp).reduce((a, b) => a + b.injected, 0);
  const recoveredTotal = Object.values(byOp).reduce((a, b) => a + b.recovered, 0);
  const spuriousFlags = outcomes.reduce((a, o) => a + o.spuriousFlags.length, 0);
  const tp = recoveredTotal;
  const fp = spuriousFlags;
  const recall = injectedTotal === 0 ? 0 : recoveredTotal / injectedTotal;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);

  return {
    benchmarkVersion: 1,
    gate: { threshold: RECOVERY_GATE, recall, passed: recall >= RECOVERY_GATE },
    totals: {
      scenarios: scenarios.length,
      cases: outcomes.length,
      cleanControls: outcomes.filter((o) => o.errors.length === 0).length,
      injectedErrors: injectedTotal,
      recoveredErrors: recoveredTotal,
      spuriousFlags,
      precision,
      recall,
    },
    byOp,
    byScenario,
    residuals,
    outcomes,
  };
}

/** Best-effort mechanical explanation for an unrecovered injected error. */
function explainResidual(scenario: CorpusScenario, e: InjectedError): string {
  switch (e.op) {
    case 'delete-actor':
      return `no ground-truth claim referencing "${e.actorId}" remained unmatched after deletion (its claims may have been unverifiable and excluded from coverage)`;
    case 'reverse-trigger-order':
      return 'the reversed chain still admits a valid ordering under the relation semantics (precedes/causes window not violated)';
    case 'flip-visibility':
      return `the flipped window contained no evaluated decision tick for this pair (${scenario.egoId} perspective)`;
    default:
      return 'checker did not flag the mutated claim; inspect the claim payload against channel records';
  }
}
