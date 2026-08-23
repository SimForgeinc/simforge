/**
 * Tier-1 validation: `validateTemplate(template, mapContext?)`.
 *
 * Tier 1 is the "on every edit, under 5 ms" pass. It never simulates: it reads
 * the document, optionally asks a {@link MapContext} about the site, and
 * returns `ClauseResult`s. Tier 2 (invariant residuals, min-TTC, never-fired
 * triggers) needs a trace and belongs to `sim-engine`.
 *
 * Two entry points, both pure:
 *
 * - {@link validateTemplate} — checks a template that has already been parsed.
 * - {@link parseAndValidateTemplate} — parses unknown JSON first and returns
 *   schema failures in the same `ClauseResult` shape, so a CLI or an agent gets
 *   one error format whether the document was malformed or merely wrong.
 */

import { toScenarioIssues } from '../errors.js';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '../schema/v2/template.js';
import { issue, toReport, type ClauseResult, type ValidationReport } from './issues.js';
import { mapIssues } from './map-checks.js';
import type { MapContext } from './map-context.js';
import { structuralIssues } from './structural.js';

export {
  ISSUE_CODES,
  issue,
  joinPath,
  toReport,
  type ClauseResult,
  type IssueCode,
  type Severity,
  type ValidationReport,
} from './issues.js';

export type {
  FeatureFacts,
  GateFacts,
  LaneChangePermissions,
  LaneFacts,
  LaneRsl,
  LaneType,
  MapContext,
  SignalFacts,
} from './map-context.js';

export {
  createFakeMapContext,
  type FakeLane,
  type FakeMapOptions,
} from './fake-map-context.js';

export {
  collectExpressions,
  isPortableTemplate,
  staticScope,
  structuralIssues,
  unusedRoles,
} from './structural.js';

export { mapIssues } from './map-checks.js';

export {
  axisTimeline,
  earliestOf,
  endBound,
  latestOf,
  resolveTriggerTime,
  type AxisSlot,
  type AxisTimeline,
  type TimeBound,
  type TimingContext,
} from './timing.js';

/**
 * Validate a parsed template.
 *
 * @param template A template that has passed {@link ScenarioTemplateV2Schema}.
 * @param mapContext When given, the map-dependent checks run too; when absent,
 *   only the document-only checks run and `report.mapChecked` is false.
 */
export function validateTemplate(
  template: ScenarioTemplateV2,
  mapContext?: MapContext,
): ValidationReport {
  const issues: ClauseResult[] = structuralIssues(template);
  if (mapContext) issues.push(...mapIssues(template, mapContext));
  return toReport(issues, mapContext !== undefined);
}

/**
 * Parse unknown JSON as a template and validate it in one step.
 *
 * Schema failures come back as `ClauseResult`s with code `schema_invalid` in the
 * `issues` list rather than as a thrown error, because the caller is usually a
 * repair loop that wants the same list either way. `template` is `undefined`
 * exactly when parsing failed.
 */
export function parseAndValidateTemplate(
  json: unknown,
  mapContext?: MapContext,
): { template?: ScenarioTemplateV2; report: ValidationReport } {
  const parsed = ScenarioTemplateV2Schema.safeParse(json);
  if (!parsed.success) {
    const issues = toScenarioIssues(parsed.error.issues).map((i) =>
      issue('error', 'schema_invalid', i.path, i.message),
    );
    return { report: toReport(issues, false) };
  }
  return { template: parsed.data, report: validateTemplate(parsed.data, mapContext) };
}
