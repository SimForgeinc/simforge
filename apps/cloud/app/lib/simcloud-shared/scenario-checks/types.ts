/**
 * A general "checks passed/failed" report produced after a scenario runs (2D
 * simulate or CARLA render). Unlike `ScenarioValidationReport` — whose check
 * ids are a closed collision-family enum — this container is open across
 * categories (osc, kinematic, integrity, parity) so it can carry the OSC
 * round-trip result, the kinematic-plausibility lint, and the CARLA/esmini
 * parity outcome side by side.
 *
 * The kinematic checks intentionally mirror the thresholds of the M1
 * scenario-lint engine (`packages/shared/src/scenario-lint` on the milestone
 * branch); when that lands, `runKinematicChecks` can defer to `lintActorTracks`
 * and map its `LintReport` into these checks instead of recomputing.
 */

export type ScenarioCheckStatus = "pass" | "warn" | "fail";

export type ScenarioCheckCategory = "osc" | "kinematic" | "integrity" | "parity";

export interface ScenarioCheck {
  /** Namespaced stable id, e.g. "kinematic.longitudinal_deceleration". */
  id: string;
  category: ScenarioCheckCategory;
  status: ScenarioCheckStatus;
  /** Short label for a UI chip. */
  label: string;
  /** One-line human-and-agent-readable explanation. */
  detail: string;
  /** The actor this check is about, when actor-scoped. */
  actorId?: string | null;
  /** Measured quantity (units per check), if any. */
  measuredValue?: number | null;
  /** Threshold the measurement was compared against, if any. */
  threshold?: number | null;
}

export interface ScenarioCheckReport {
  /** fail if any check failed; warn if any warned (none failed); else pass. */
  verdict: ScenarioCheckStatus;
  /** ISO timestamp when produced, if the caller supplies one. */
  generatedAt: string | null;
  passed: number;
  warned: number;
  failed: number;
  checks: ScenarioCheck[];
}

/** One time-sampled pose for an actor. Speed/yaw are derived if absent. */
export interface CheckTrackSample {
  /** Seconds since scenario start; must be strictly increasing per actor. */
  t: number;
  x: number;
  y: number;
  /** Heading, radians. Derived from the velocity vector when omitted. */
  yaw?: number;
  /** Speed, m/s. Finite-differenced from position when omitted. */
  speed?: number;
}

export interface CheckActorTrack {
  actorId: string;
  kind: "vehicle" | "walker" | "prop";
  samples: CheckTrackSample[];
}
