/**
 * Degradation semantics.
 *
 * > **Rule: degradation may relax presentation, never intent.**
 *
 * Repairs are attempted in the order the research doc gives:
 *
 * 1. speed-clamp (preserve the arrival invariant over the speed parameter)
 * 2. feature-distance relax within tolerance
 * 3. lane-offset clamp (non-required roles)
 * 4. junction-class substitute (near-miss table, preferred only)
 * 5. actor drop (cosmetic only)
 * 6. otherwise `infeasible`
 *
 * There is deliberately no runway repair. "Shorten the run-up to the road
 * available" reads like a relaxation of presentation, but nothing downstream
 * shortens anything: the actor keeps its authored station and the materializer
 * clamps it onto the road end. Runway is now derived from the actors
 * (`requiredRunway` in `matcher.ts`), so a site that is too short fails the
 * required clause and is simply infeasible.
 *
 * The hard gate: **any repair that would touch a `required` clause or a
 * `required` role makes the site infeasible.** Relaxing a required clause is
 * relaxing what the scenario tests, which is never a repair — it is a different
 * scenario, and the author has `variants` for that.
 */

import type { ClauseResult, DegradationReport, FeatureBinding, Repair } from './types/site.js';
import type { LogicalAnchor } from './types/anchor.js';
import type { OnMissing, RoleBinding } from './types/roles.js';
import { passesRequired } from './scoring.js';

/** Score multipliers for repairs whose cost is not already in a clause score. */
const REPAIR_PENALTY: Record<Repair['kind'], number> = {
  speed_clamp: 0.97,
  feature_distance_relax: 1, // already reflected in the atM clause score
  lane_offset_clamp: 0.95,
  junction_class_substitute: 1, // already reflected in the control clause score
  actor_drop: 0.85,
};

export interface DegradeInput {
  anchor: LogicalAnchor;
  roles: RoleBinding[];
  clauses: ClauseResult[];
  bindings: FeatureBinding[];
  /** Weighted soft-clause score from `aggregateScore`. */
  softScore: number;
  failedRequiredClauses: string[];
}

export interface DegradeResult {
  report: DegradationReport;
  score: number;
}

function clauseByPath(clauses: ClauseResult[], path: string): ClauseResult | undefined {
  return clauses.find((c) => c.path === path);
}

const fmt = (v: unknown): string =>
  typeof v === 'number' ? String(Math.round(v * 100) / 100) : Array.isArray(v) ? v.join('|') : String(v);

/**
 * The author's stated instruction for an unsatisfiable lane request.
 *
 * Read from the binding first (the matcher records what it acted on) and from
 * the role as a fallback, so a caller that assembles bindings by hand — the
 * degradation tests do — still gets the author's intent rather than a silent
 * `undefined` that would recategorise a sanctioned clamp as a violation.
 */
function onMissingOf(binding: FeatureBinding, role: RoleBinding | undefined): OnMissing | undefined {
  if (binding.onMissing !== undefined) return binding.onMissing;
  return role !== undefined && 'onMissing' in role ? role.onMissing : undefined;
}

/**
 * Apply the ordered repair attempts and produce the report.
 *
 * Every repair records `touchesRequired`; the verdict is `infeasible` as soon
 * as one of them does, even if the repair itself "worked".
 */
export function degrade(input: DegradeInput): DegradeResult {
  const { clauses, bindings, roles } = input;
  const repairs: Repair[] = [];
  const failedRequired = [...input.failedRequiredClauses];
  const roleByName = new Map(roles.map((r) => [r.role, r]));

  // 1a. speed clamp -------------------------------------------------------
  const speed = clauseByPath(clauses, 'corridor.speedLimitKph');
  if (speed && speed.supported && !passesRequired(speed.score)) {
    const wanted = Array.isArray(speed.required) ? (speed.required as [number, number]) : [0, 0];
    repairs.push({
      kind: 'speed_clamp',
      path: speed.path,
      requestedKph: [wanted[0] as number, wanted[1] as number],
      appliedKph: typeof speed.actual === 'number' ? speed.actual : 0,
      touchesRequired: speed.essentiality === 'required',
      note: `speeds clamped to the site limit ${fmt(speed.actual)} kph (arrival invariants re-solved over the speed parameter)`,
    });
  }


  // 2. feature-distance relax --------------------------------------------
  for (const clause of clauses) {
    if (!clause.path.startsWith('features.') || !clause.path.endsWith('.atM')) continue;
    if (!clause.supported || passesRequired(clause.score) || clause.score <= 0) continue;
    const wanted = Array.isArray(clause.required) ? (clause.required as [number, number]) : [0, 0];
    repairs.push({
      kind: 'feature_distance_relax',
      path: clause.path,
      requestedM: [wanted[0] as number, wanted[1] as number],
      actualM: typeof clause.actual === 'number' ? clause.actual : 0,
      slackM: clause.slack,
      touchesRequired: clause.essentiality === 'required',
      note: `feature sits ${fmt(clause.slack)} m outside the requested window, inside tolerance`,
    });
  }

  // 3. lane-offset clamp --------------------------------------------------
  // `onMissing: 'clamp' | 'drop'` is an *author instruction*, not a matcher
  // liberty: a clamp the author asked for does not touch intent even on a
  // required role. Every lane-indexed binding now carries that instruction, so
  // "sanctioned" is a property of what the author wrote rather than of which
  // role kind happened to have the field.
  for (const binding of bindings) {
    if (binding.status !== 'clamped') continue;
    const role = roleByName.get(binding.role);
    const onMissing = onMissingOf(binding, role);
    const sanctioned = onMissing === 'clamp';
    const requestedK =
      binding.requestedK ?? (role?.kind === 'lane_offset' ? role.k : (binding.pose?.k ?? 0));
    repairs.push({
      kind: 'lane_offset_clamp',
      role: binding.role,
      requestedK,
      appliedK: binding.pose?.k ?? 0,
      touchesRequired: !sanctioned && role?.essentiality === 'required',
      note: `${binding.role} moved from lane k=${requestedK} to k=${binding.pose?.k ?? 0}${
        sanctioned ? ' (onMissing: clamp)' : ''
      }`,
    });
  }

  // 4. junction-class substitute -----------------------------------------
  for (const clause of clauses) {
    if (!clause.path.endsWith('junction.control')) continue;
    if (!clause.supported || passesRequired(clause.score) || clause.score <= 0) continue;
    repairs.push({
      kind: 'junction_class_substitute',
      path: clause.path,
      requested: Array.isArray(clause.required) ? clause.required.map(String) : [String(clause.required)],
      actual: String(clause.actual),
      nearMissScore: clause.score,
      touchesRequired: clause.essentiality === 'required',
      note: `${fmt(clause.actual)} junction substituted for ${fmt(clause.required)} (near-miss ${clause.score})`,
    });
  }

  // 5. actor drop ---------------------------------------------------------
  for (const binding of bindings) {
    if (binding.status !== 'dropped' && binding.status !== 'failed') continue;
    const role = roleByName.get(binding.role);
    const essentiality = role?.essentiality ?? 'required';
    // An author-sanctioned `onMissing: 'drop'` is a rendition choice, not a
    // relaxation of intent. `onMissing: 'fail'` is the opposite: the author
    // said this site should be rejected.
    const sanctionedDrop = binding.status === 'dropped' && onMissingOf(binding, role) === 'drop';
    const touchesRequired = !sanctionedDrop && essentiality !== 'cosmetic';
    repairs.push({
      kind: 'actor_drop',
      role: binding.role,
      reason: binding.notes[0] ?? 'role could not be bound',
      touchesRequired,
      note: sanctionedDrop
        ? `${binding.role} dropped (onMissing: drop)`
        : essentiality === 'cosmetic'
          ? `${binding.role} dropped (cosmetic)`
          : `${binding.role} could not be bound and is not cosmetic`,
    });
    if (touchesRequired) failedRequired.push(`roles.${binding.role}`);
  }

  const touchedRequired = repairs.some((r) => r.touchesRequired);
  const unsupportedRequired = clauses
    .filter((c) => c.essentiality === 'required' && !c.supported)
    .map((c) => c.path);

  let score = input.softScore;
  for (const repair of repairs) score *= REPAIR_PENALTY[repair.kind];
  score = Math.max(0, Math.min(1, score));

  const uniqueFailed = [...new Set(failedRequired)].sort();
  const infeasible = uniqueFailed.length > 0 || touchedRequired;
  const allExact =
    repairs.length === 0 &&
    clauses.every((c) => !c.supported || passesRequired(c.score)) &&
    bindings.every((b) => b.status === 'bound');

  const verdict: DegradationReport['verdict'] = infeasible
    ? 'infeasible'
    : allExact
      ? 'exact'
      : 'degraded';

  const summaryParts: string[] = [];
  if (verdict === 'exact') {
    summaryParts.push('Exact match: every clause and role bound without relaxation.');
  } else if (verdict === 'degraded') {
    summaryParts.push(`Degraded match (score ${score.toFixed(2)}).`);
    for (const repair of repairs) summaryParts.push(repair.note + '.');
    const soft = clauses.filter((c) => c.supported && c.score < 1 && c.essentiality !== 'required');
    for (const clause of soft.slice(0, 3)) summaryParts.push(`${clause.reason}.`);
    summaryParts.push('Presentation was relaxed; the scenario still tests what it was written to test.');
  } else {
    summaryParts.push('Infeasible at this site.');
    for (const path of uniqueFailed) {
      const clause = clauseByPath(clauses, path);
      summaryParts.push(clause ? `${clause.reason}.` : `${path} could not be satisfied.`);
    }
    for (const repair of repairs.filter((r) => r.touchesRequired)) {
      summaryParts.push(`Would have required relaxing a required clause: ${repair.note}.`);
    }
    if (unsupportedRequired.length > 0) {
      summaryParts.push(
        `Required clauses this map index cannot answer: ${unsupportedRequired.join(', ')}.`,
      );
    }
  }

  return {
    score: verdict === 'infeasible' ? 0 : score,
    report: {
      verdict,
      score: verdict === 'infeasible' ? 0 : score,
      repairs,
      failedRequiredClauses: uniqueFailed,
      summary: summaryParts.join(' '),
      intentPreserved: !infeasible,
    },
  };
}
