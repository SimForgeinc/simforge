export type LintActorKind = "vehicle" | "walker";

export const SCENARIO_LINT_SCHEMA_VERSION =
  "simforge.scenario-lint.v1" as const;

export interface LintTrackSample {
  /** Seconds. */
  t: number;
  /** Planar position in meters. */
  x: number;
  /** Planar position in meters. */
  y: number;
  /** Heading in radians. */
  yaw?: number;
  /** Scalar speed in meters per second. */
  speed?: number;
}

export interface LintActorTrack {
  actorId: string;
  kind: LintActorKind;
  samples: LintTrackSample[];
}

export type LintViolationKind =
  | "longitudinal_acceleration"
  | "longitudinal_deceleration"
  | "lateral_acceleration"
  | "longitudinal_jerk"
  | "speed"
  | "position_discontinuity"
  | "speed_discontinuity"
  | "heading_discontinuity";

export type LintSeverity = "warning" | "violation";

export interface LintViolation {
  actorId: string;
  kind: LintViolationKind;
  tStart: number;
  tEnd: number;
  peakValue: number;
  threshold: number;
  severity: LintSeverity;
}

export interface LintMetricSample {
  t: number;
  speed: number;
  /** Positive portion of signed longitudinal acceleration, in m/s². */
  longitudinalAcceleration: number;
  /** Magnitude of the negative portion of acceleration, in m/s². */
  longitudinalDeceleration: number;
  /** Signed lateral acceleration, in m/s². */
  lateralAcceleration: number;
  /** Signed longitudinal jerk, in m/s³. */
  longitudinalJerk: number;
  /** Signed yaw rate, in rad/s. */
  yawRate: number;
}

export interface LintActorReport {
  actorId: string;
  kind: LintActorKind;
  samples: LintMetricSample[];
  violations: LintViolation[];
}

export interface LintReport {
  schemaVersion: typeof SCENARIO_LINT_SCHEMA_VERSION;
  perActor: LintActorReport[];
  violations: LintViolation[];
  summary: {
    verdict: "pass" | "warn" | "fail";
    violationCount: number;
    warningCount: number;
    byKind: Record<string, number>;
  };
}
