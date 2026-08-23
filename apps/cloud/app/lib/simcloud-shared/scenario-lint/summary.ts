import { z } from "zod";

import type {
  LintActorReport,
  LintMetricSample,
  LintReport,
  LintViolation,
} from "./types";

export const ScenarioLintSeverityCountsSchema = z.object({
  violation_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
});
export type ScenarioLintSeverityCounts = z.infer<
  typeof ScenarioLintSeverityCountsSchema
>;

export const ScenarioLintActorPeaksSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(["vehicle", "walker"]),
  peaks: z.record(z.number()),
});
export type ScenarioLintActorPeaks = z.infer<
  typeof ScenarioLintActorPeaksSchema
>;

/**
 * Storage-oriented lint projection. It deliberately omits the per-timestep
 * metric samples while retaining enough information for inspection, repair
 * prompts, and batch ranking.
 */
export const ScenarioLintCompactReportSchema = z.object({
  schema_version: z.literal("simforge.scenario-lint.v1"),
  verdict: z.enum(["pass", "warn", "fail"]),
  violation_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
  by_kind: z.record(ScenarioLintSeverityCountsSchema),
  per_actor: z.array(ScenarioLintActorPeaksSchema),
});
export type ScenarioLintCompactReport = z.infer<
  typeof ScenarioLintCompactReportSchema
>;

function peak(
  samples: LintMetricSample[],
  value: (sample: LintMetricSample) => number,
): number {
  return samples.reduce(
    (highest, sample) => Math.max(highest, Math.abs(value(sample))),
    0,
  );
}

function discontinuityPeaks(
  violations: LintViolation[],
): Record<string, number> {
  const peaks: Record<string, number> = {};
  for (const violation of violations) {
    if (!violation.kind.endsWith("_discontinuity")) continue;
    peaks[violation.kind] = Math.max(
      peaks[violation.kind] ?? 0,
      violation.peakValue,
    );
  }
  return peaks;
}

function actorPeaks(actor: LintActorReport): ScenarioLintActorPeaks {
  const peaks: Record<string, number> =
    actor.kind === "walker"
      ? {
          speed: peak(actor.samples, (sample) => sample.speed),
        }
      : {
          longitudinal_acceleration: peak(
            actor.samples,
            (sample) => sample.longitudinalAcceleration,
          ),
          longitudinal_deceleration: peak(
            actor.samples,
            (sample) => sample.longitudinalDeceleration,
          ),
          lateral_acceleration: peak(
            actor.samples,
            (sample) => sample.lateralAcceleration,
          ),
          longitudinal_jerk: peak(
            actor.samples,
            (sample) => sample.longitudinalJerk,
          ),
        };
  Object.assign(peaks, discontinuityPeaks(actor.violations));
  return { actor_id: actor.actorId, kind: actor.kind, peaks };
}

export function compactLintReport(
  report: LintReport,
): ScenarioLintCompactReport {
  const byKind = new Map<string, ScenarioLintSeverityCounts>();
  for (const violation of report.violations) {
    const counts = byKind.get(violation.kind) ?? {
      violation_count: 0,
      warning_count: 0,
    };
    if (violation.severity === "violation") counts.violation_count += 1;
    else counts.warning_count += 1;
    byKind.set(violation.kind, counts);
  }

  return {
    schema_version: report.schemaVersion,
    verdict: report.summary.verdict,
    violation_count: report.summary.violationCount,
    warning_count: report.summary.warningCount,
    by_kind: Object.fromEntries(
      [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    per_actor: report.perActor.map(actorPeaks),
  };
}
