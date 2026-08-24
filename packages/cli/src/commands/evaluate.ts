/**
 * `uniscenarios evaluate <trace> [--filter critical|negative-control|all]`.
 *
 * The reject filters, applied to a trace. `--filter negative-control` is not a
 * different set of filters — it is the same set with `trivially_safe` demoted
 * from a rejection to a tag, because the taxonomy deliberately contains
 * scenarios whose whole point is that nothing happens.
 */

import { readFile } from 'node:fs/promises';

import {
  createBlindReviewPacket,
  evaluateIntentRubric,
  evaluateTrace,
  intentRubricSchema,
  type EvaluateFilters,
  type IntentEvaluation,
} from '@simforge/engine';

import { CliError, EXIT } from '../errors.js';
import { emit, emitLines, fixed, pad } from '../output.js';
import { readTraceFile, writeJsonFile } from '@simforge/compiler/node';
import { metricsSummary } from './simulate.js';

export type EvaluateFilterMode = 'critical' | 'negative-control' | 'all';

export interface EvaluateOptions {
  readonly file: string;
  readonly filter: EvaluateFilterMode;
  readonly trivialTtcS?: number | undefined;
  readonly rejectCollisions: boolean;
  /** Optional canonical IntentRubric JSON evaluated alongside criticality. */
  readonly rubric?: string | undefined;
  /** Optional bounded packet for a context-blind Codex reviewer. */
  readonly blindReviewOut?: string | undefined;
  readonly pretty: boolean;
}

/**
 * Intent evidence may explain an intentionally stationary/no-conflict episode,
 * but it never suppresses hard generic safety or execution failures.
 */
export function combinedEvaluationVerdict(
  generic: { verdict: 'accept' | 'reject'; findings: ReadonlyArray<{ code: string }> },
  intent: IntentEvaluation | null,
): 'accept' | 'reject' {
  if (intent === null) return generic.verdict;
  if (intent.verdict === 'reject') return 'reject';
  const explainedByIntent = new Set(['no_interaction', 'trivially_safe', 'out_of_window']);
  return generic.findings.some((finding) => !explainedByIntent.has(finding.code)) ? 'reject' : 'accept';
}

async function readIntentRubric(file: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new CliError('invalid_json', `cannot read intent rubric ${file}: ${error instanceof Error ? error.message : String(error)}`, { path: file });
  }
  const parsed = intentRubricSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError('bad_value', 'the intent rubric is invalid', {
      path: file,
      detail: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), reason: issue.message })) },
      exitCode: EXIT.validationFindings,
    });
  }
  return parsed.data;
}

export function filtersFor(
  mode: EvaluateFilterMode,
  extra: { trivialTtcS?: number | undefined; rejectCollisions?: boolean } = {},
): EvaluateFilters {
  return {
    ...(mode === 'negative-control' ? { negativeControl: true } : {}),
    ...(extra.trivialTtcS === undefined ? {} : { trivialTtcS: extra.trivialTtcS }),
    ...(extra.rejectCollisions ? { rejectCollisions: true } : {}),
  };
}

/** `critical` / `trivially-safe` / `infeasible` — the batch's headline buckets. */
export function criticalityBand(
  verdict: 'accept' | 'reject',
  findings: ReadonlyArray<{ code: string }>,
): 'critical' | 'trivially-safe' | 'no-interaction' | 'unavoidable' | 'out-of-window' | 'never-fired' {
  if (verdict === 'accept') return 'critical';
  const codes = new Set(findings.map((f) => f.code));
  if (codes.has('no_interaction')) return 'no-interaction';
  if (codes.has('trivially_safe')) return 'trivially-safe';
  if (codes.has('physically_unavoidable')) return 'unavoidable';
  if (codes.has('never_fired')) return 'never-fired';
  if (codes.has('out_of_window')) return 'out-of-window';
  return 'trivially-safe';
}

export async function evaluate(options: EvaluateOptions): Promise<number> {
  if (!['critical', 'negative-control', 'all'].includes(options.filter)) {
    throw new CliError('bad_value', `--filter must be critical | negative-control | all`, {
      path: '--filter',
    });
  }
  const trace = await readTraceFile(options.file);
  const evaluation = evaluateTrace(
    trace,
    filtersFor(options.filter, {
      trivialTtcS: options.trivialTtcS,
      rejectCollisions: options.rejectCollisions,
    }),
  );
  const band = criticalityBand(evaluation.verdict, evaluation.findings);
  let intentEvaluation: IntentEvaluation | null = null;
  if (options.rubric) {
    const rubric = await readIntentRubric(options.rubric);
    intentEvaluation = evaluateIntentRubric(trace, rubric);
    if (options.blindReviewOut) {
      await writeJsonFile(options.blindReviewOut, createBlindReviewPacket(rubric, intentEvaluation));
    }
  } else if (options.blindReviewOut) {
    throw new CliError('missing_argument', '--blind-review-out requires --rubric', { path: '--rubric' });
  }
  const combinedVerdict = combinedEvaluationVerdict(evaluation, intentEvaluation);

  const payload = {
    file: options.file,
    mapId: trace.header.mapId,
    metricSubject: trace.header.metricSubject,
    filter: options.filter,
    verdict: evaluation.verdict,
    combinedVerdict,
    band,
    tags: evaluation.tags,
    findings: evaluation.findings,
    summary: evaluation.summary,
    metrics: metricsSummary(trace),
    ...(options.rubric ? { intentRubric: options.rubric, intentEvaluation } : {}),
    ...(options.blindReviewOut ? { blindReviewPacket: options.blindReviewOut } : {}),
  };

  if (!options.pretty) {
    emit(payload, options);
  } else {
    const lines = [
      `${options.file}: ${combinedVerdict.toUpperCase()} (${band}; generic ${evaluation.verdict})`,
      `minTTC ${fixed(evaluation.summary.minTTC)} s at t=${fixed(evaluation.summary.minTTCt)} s · requiredDecelMax ${fixed(
        evaluation.summary.requiredDecelMax,
      )} m/s² · collisions ${evaluation.summary.collisions} · neverFired ${evaluation.summary.neverFired}`,
    ];
    if (evaluation.tags.length > 0) lines.push(`tags: ${evaluation.tags.join(', ')}`);
    if (evaluation.findings.length > 0) {
      lines.push('', 'findings:');
      for (const f of evaluation.findings) lines.push(`  ${pad(f.code, 26)}${f.reason}`);
    }
    if (intentEvaluation) {
      lines.push('', `intent: ${intentEvaluation.verdict.toUpperCase()} · ${intentEvaluation.counts.pass} pass · ${intentEvaluation.counts.fail} fail · ${intentEvaluation.counts.unchecked} unchecked · ${intentEvaluation.counts.unsupported} unsupported`);
      for (const criterion of intentEvaluation.criteria) lines.push(`  ${pad(criterion.status, 12)}${criterion.id}: ${criterion.reason}`);
    }
    emitLines(lines);
  }

  // A rejection is a *finding*, not a command failure: the caller asked whether
  // this instance passes, and it got a definite answer.
  return combinedVerdict === 'accept' ? EXIT.ok : EXIT.validationFindings;
}
