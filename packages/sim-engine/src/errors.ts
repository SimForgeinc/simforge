/**
 * Structured errors.
 *
 * Everything the engine rejects comes back as `{code, path, reason}` so an
 * unattended repair loop (LLM authoring → validate → repair) can act on it
 * without parsing prose. `path` is a JSON pointer-ish dotted path into the
 * `SimScenarioInput` document.
 */

export type SimIssueCode =
  // route / topology
  | 'route_lane_missing'
  | 'route_disconnected'
  | 'route_empty'
  | 'route_orientation_ambiguous'
  | 'route_turn_unavailable'
  // feasibility guards
  | 'runway_insufficient'
  | 'decel_budget_exceeded'
  | 'timed_route_speed_unreachable'
  | 'timed_route_acceleration_unreachable'
  | 'timed_route_turn_unreachable'
  | 'spawn_overlap'
  | 'spawn_off_lane'
  | 'spawn_lane_not_on_route'
  | 'spawn_lane_pose_mismatch'
  | 'traffic_control_route_unbound'
  | 'traffic_control_binding_repaired'
  // gear
  | 'reverse_spawn_heading_adjusted'
  // binding
  | 'actor_unknown'
  | 'interaction_unknown'
  | 'signal_unknown'
  | 'arrival_unsolvable'
  | 'lane_change_illegal'
  | 'lateral_duration_clamped'
  | 'lateral_tracking_failed';

export type SimIssueSeverity = 'error' | 'warning';

export interface SimIssue {
  readonly code: SimIssueCode;
  readonly severity: SimIssueSeverity;
  /** Dotted path into the input document, e.g. `actors[2].behavior.route`. */
  readonly path: string;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
}

export class SimEngineError extends Error {
  readonly issues: readonly SimIssue[];

  constructor(message: string, issues: readonly SimIssue[]) {
    super(message);
    this.name = 'SimEngineError';
    this.issues = issues;
  }
}

export function issue(
  code: SimIssueCode,
  path: string,
  reason: string,
  detail?: Record<string, unknown>,
  severity: SimIssueSeverity = 'error',
): SimIssue {
  return detail === undefined
    ? { code, severity, path, reason }
    : { code, severity, path, reason, detail };
}
