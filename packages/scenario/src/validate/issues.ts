/**
 * `ClauseResult` — one issue shape shared by the validator and the matcher.
 *
 * `docs/research/retargeting.md` ends its validator section with "validator
 * checks and anchor clauses share the ClauseResult shape → one unified quality
 * report", and that is load-bearing rather than tidy-minded: the site picker,
 * the CLI, the timeline gutter and the LLM repair loop all consume one list. A
 * clause that failed to match ("needed 4 arms, site has 3") and a check that
 * failed to validate ("needed 220 m of runway, site has 140 m") are the same
 * kind of statement about the same kind of thing, and rendering them through
 * one component is what makes the quality report explainable.
 *
 * `required` / `actual` are free-form JSON values, because the alternative —
 * a typed payload per code — puts a schema change in the path of every new
 * check and buys nothing: consumers render them, they do not compute on them.
 */

/** How bad an issue is. `error` blocks; `warning` and `info` do not. */
export type Severity = 'error' | 'warning' | 'info';

/**
 * Machine-readable issue codes.
 *
 * Stable strings: an agent repair loop keys off these, so renaming one is a
 * breaking change to the CLI contract.
 */
export const ISSUE_CODES = [
  // --- the document did not even parse --------------------------------------
  'schema_invalid',
  // --- reference resolution -------------------------------------------------
  'role_ref_unknown',
  'feature_ref_unknown',
  'interaction_ref_unknown',
  'param_ref_unknown',
  'control_ref_unknown',
  'sensor_ref_unknown',
  'divergence_ref_unknown',
  'feature_kind_mismatch',
  'self_reference',
  // --- timeline structure ---------------------------------------------------
  'dynamics_required',
  'bylatest_required',
  'axis_conflict',
  'axis_conflict_possible',
  'until_before_trigger',
  'trigger_cycle',
  'trigger_out_of_clip',
  'event_order_inconsistent',
  // --- typed state ----------------------------------------------------------
  'unknown_set_key',
  'set_value_type',
  'set_value_range',
  'set_actor_mismatch',
  'actor_class_mismatch',
  'static_actor_motion',
  // --- document coherence ---------------------------------------------------
  'authored_actor_limit_exceeded',
  'metric_subject_unknown',
  'metric_subject_missing',
  'derived_param_cycle',
  'expr_error',
  'anchor_unconstrained',
  /**
   * An authored anchor clause the matcher cannot express, and therefore
   * discards. The template would otherwise bind sites that were never checked
   * against the requirement and still report score 1.00 / `exact`.
   */
  'clause_unmatchable',
  'occluder_pair_missing',
  'occluder_dropped',
  'attached_prop_repeat_unsupported',
  'attached_prop_repeat_unsupported',
  'non_portable_role',
  'pin_required',
  'pin_site_unresolved',
  'variant_path_invalid',
  'variant_target_unknown',
  'relative_to_cycle',
  // --- map-dependent (tier 1, needs a MapContext) ---------------------------
  'role_unbound',
  'route_disconnected',
  'illegal_lane_change',
  'wrong_lane_type',
  'spawn_off_lane',
  'spawn_overlap',
  'runway_insufficient',
  'trigger_unbindable',
  'speed_over_limit',
] as const;

/** A machine-readable issue code. */
export type IssueCode = (typeof ISSUE_CODES)[number];

/** One finding: a failed clause, or a failed check. */
export interface ClauseResult {
  /** Dotted/indexed path into the template, e.g. `choreography.interactions.3.dynamics`. */
  path: string;
  severity: Severity;
  code: IssueCode;
  /** One sentence, addressed to whoever has to fix it (human or agent). */
  message: string;
  /** What the check wanted, when that is a value worth showing. */
  required?: unknown;
  /** What it found. */
  actual?: unknown;
}

/** Build a `ClauseResult`. Keeps the check sites to one line each. */
export function issue(
  severity: Severity,
  code: IssueCode,
  path: string,
  message: string,
  detail?: { required?: unknown; actual?: unknown },
): ClauseResult {
  const result: ClauseResult = { path, severity, code, message };
  if (detail?.required !== undefined) result.required = detail.required;
  if (detail?.actual !== undefined) result.actual = detail.actual;
  return result;
}

/** Join path segments the way {@link ClauseResult.path} spells them. */
export function joinPath(...segments: Array<string | number>): string {
  return segments.join('.');
}

/** The outcome of a validation pass. */
export interface ValidationReport {
  /** True when no issue has severity `error`. */
  ok: boolean;
  issues: ClauseResult[];
  /** True when map-dependent checks ran (a `MapContext` was supplied). */
  mapChecked: boolean;
}

/** Assemble a report, sorting issues so output is diff-stable. */
export function toReport(issues: ClauseResult[], mapChecked: boolean): ValidationReport {
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code),
  );
  return { ok: !sorted.some((i) => i.severity === 'error'), issues: sorted, mapChecked };
}
