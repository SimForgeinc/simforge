import type { Interaction } from '@simforge-oss/scenario';

export const SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES = [
  'traffic_control_route_unbound',
  'timed_route_turn_unreachable',
  'target_timing_infeasible',
] as const;

type SimpleModeSuppressedEngineIssueCode =
  (typeof SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES)[number];

const SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUES: Readonly<Record<
  SimpleModeSuppressedEngineIssueCode,
  true
>> = {
  traffic_control_route_unbound: true,
  timed_route_turn_unreachable: true,
  target_timing_infeasible: true,
};

/** Whether Simple mode should hide an engine-domain validation finding. */
export function isSimpleModeEngineIssueSuppressed(code: string | null | undefined): boolean {
  return code != null
    && SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUES[
      code as SimpleModeSuppressedEngineIssueCode
    ] === true;
}

export type EditorAuthoringValidationIssue = {
  readonly id: string;
  readonly severity: 'error' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly solution?: string;
};

/**
 * Find custom timed routes that cannot be previewed because no points have
 * been authored yet.
 */
export function emptyTimedRouteIssues(
  interactions: readonly Interaction[],
  actorNames?: Readonly<Record<string, string>>,
): EditorAuthoringValidationIssue[] {
  const issues: EditorAuthoringValidationIssue[] = [];
  for (const interaction of interactions) {
    if (
      interaction.verb !== 'route'
      || interaction.target.mode !== 'customTimedRoute'
      || (Array.isArray(interaction.target.points) && interaction.target.points.length > 0)
    ) {
      continue;
    }
    const actorName = actorNames?.[interaction.actor] ?? interaction.actor;
    issues.push({
      id: `timed-route-empty:${interaction.id}`,
      severity: 'error',
      title: 'Custom timed route has no points',
      detail: `${actorName}'s custom timed route needs at least one point before it can be previewed.`,
      solution: 'Open the route, add its first point on the map, then run the preview again.',
    });
  }
  return issues;
}
