/**
 * SimForge-native closed-loop scoring over policy_step episode traces.
 *
 * Consumes the rich JSONL trace written by `adapters/policy-runner`
 * (one `reset` record, one record per decision carrying the decoded ego
 * state vector `sv`, the perception object list `objs` and the reward
 * breakdown `terms`, then a `summary` line) and produces a
 * route-completion × infraction-penalty driving score with per-event
 * records (tick + position), TTC minima and comfort (accel/jerk) metrics.
 *
 * Model-independent by construction: everything here is a pure function of
 * the trace plus the authored scenario context — no engine, no wall clock.
 * Deterministic traces therefore score identically forever.
 *
 * Terminal collision/goal classification mirrors the policy-eval server's
 * wire metrics (`col`/`goal` in eval-server.ts): the shared helpers
 * {@link collisionFromReward} / {@link goalFromReward} are the single
 * source of that rule.
 *
 * Boundary semantics (unit-tested exactly):
 * - thresholds on instantaneous values are strict (`>` / `<`);
 * - durations and accumulations fire inclusively (`>=`);
 * - `elapsed == deadline` is on time upstream (policy_step contract), so a
 *   `miss` flag in the trace is authoritative here.
 */

/* ------------------------------------------------------------ trace shapes */

/** Perception object row on the wire: [id, rangeM, bearingRad, rangeRateMps, lineOfSight]. */
export type TraceObj = readonly [string, number, number, number, number];

/** Optional per-decision signal annotation (red-light scoring input). */
export interface TraceSignalState {
  /** Governing head state for the ego's approach. */
  readonly state: 'red' | 'yellow' | 'green';
  /** Signed distance to the stop line along the route, metres (<= 0 once crossed). */
  readonly distM: number;
}

export interface TraceResetRecord {
  readonly seed: number | string;
  readonly session?: number;
  readonly t: number;
  readonly sv: readonly number[] | null;
  readonly objs: readonly TraceObj[];
  readonly deadline_ms?: number;
  readonly fallback?: string;
  readonly policy?: string;
}

export interface TraceStepRecord {
  readonly step: number;
  readonly t: number;
  readonly a?: unknown;
  readonly miss: number;
  readonly applied?: string;
  readonly rw: number;
  readonly term: number;
  readonly trunc: number;
  readonly sv: readonly number[] | null;
  /** [progress, proximity, comfort] — the wire's non-terminal reward terms. */
  readonly terms?: readonly number[] | null;
  readonly objs: readonly TraceObj[];
  /** Optional signal annotation; enables the red-light checker when present. */
  readonly sig?: TraceSignalState | null;
}

export interface ParsedTrace {
  readonly reset: TraceResetRecord | null;
  readonly steps: readonly TraceStepRecord[];
  readonly summary: Record<string, unknown> | null;
}

/** Parse a policy-runner trace (JSONL). Unknown keys pass through untouched. */
export function parseTraceJsonl(text: string): ParsedTrace {
  let reset: TraceResetRecord | null = null;
  let summary: Record<string, unknown> | null = null;
  const steps: TraceStepRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const doc = JSON.parse(trimmed) as Record<string, unknown>;
    if (doc['reset'] !== undefined) {
      reset = doc['reset'] as TraceResetRecord;
    } else if (doc['summary'] !== undefined) {
      summary = doc['summary'] as Record<string, unknown>;
    } else if (typeof doc['step'] === 'number') {
      steps.push(doc as unknown as TraceStepRecord);
    }
  }
  steps.sort((a, b) => a.step - b.step);
  return { reset, steps, summary };
}

/* -------------------------------------------- terminal reward classification */

/** The reward view both the eval server and the trace scorer classify from. */
export interface TerminalRewardView {
  readonly terminated: boolean;
  readonly reward: number;
  /** Named terms; terminal `collision` / `goal` present only when they fired. */
  readonly rewardTerms: Readonly<Record<string, number>>;
}

/**
 * Collision rule shared with the policy-eval server's `col` wire metric:
 * an explicit terminal collision term, or a termination whose reward is
 * deeply negative without a goal bonus.
 */
export function collisionFromReward(view: TerminalRewardView): boolean {
  return (
    'collision' in view.rewardTerms ||
    (view.terminated && view.reward <= -1 && !('goal' in view.rewardTerms))
  );
}

/** Goal rule shared with the policy-eval server's `goal` wire metric. */
export function goalFromReward(view: TerminalRewardView): boolean {
  return Boolean(view.rewardTerms['goal']);
}

/** Residuals smaller than this are shaping noise, not terminal bonuses. */
const TERMINAL_RESIDUAL_EPS = 1e-6;

/**
 * Rebuild a {@link TerminalRewardView} from a trace record: the wire carries
 * `rw` and the three shaping terms, so any terminal collision penalty / goal
 * bonus survives exactly as the residual `rw - (progress+proximity+comfort)`.
 */
export function rewardViewFromStep(step: TraceStepRecord): TerminalRewardView {
  const [progress = 0, proximity = 0, comfort = 0] = step.terms ?? [];
  const residual = step.rw - (progress + proximity + comfort);
  return {
    terminated: step.term === 1,
    reward: step.rw,
    rewardTerms: {
      progress,
      proximity,
      comfort,
      ...(step.term === 1 && residual < -TERMINAL_RESIDUAL_EPS ? { collision: residual } : {}),
      ...(step.term === 1 && residual > TERMINAL_RESIDUAL_EPS ? { goal: residual } : {}),
    },
  };
}

/* ----------------------------------------------------------- configuration */

export type InfractionType =
  | 'collision-vehicle'
  | 'collision-pedestrian'
  | 'collision-static'
  | 'off-road'
  | 'wrong-way'
  | 'red-light'
  | 'stuck'
  | 'speeding';

export type ScoreEventType =
  | InfractionType
  | 'ttc-critical'
  | 'accel-bound'
  | 'jerk-bound'
  | 'deadline-miss'
  | 'goal-reached';

export interface ScoreEvent {
  readonly type: ScoreEventType;
  /** Decision index (trace `step`). */
  readonly tick: number;
  readonly tS: number;
  readonly severity: 'info' | 'warning' | 'infraction';
  readonly position: { x: number; y: number } | null;
  readonly data?: Record<string, unknown>;
}

/** Multiplicative penalty factor applied once per infraction event. */
export interface PenaltyFactors {
  collisionVehicle: number;
  collisionPedestrian: number;
  collisionStatic: number;
  offRoad: number;
  wrongWay: number;
  redLight: number;
  stuck: number;
  speeding: number;
}

export interface ScoringConfig {
  penalties: PenaltyFactors;
  /** Off-road when |lane-relative lateral offset| exceeds this (strict >), metres. */
  offRoadLateralM: number;
  /** Hysteresis: an off-road episode clears when |offset| <= offRoadLateralM - offRoadClearM. */
  offRoadClearM: number;
  /** Wrong-way when cumulative reverse route-arc progress reaches this (>=), metres. */
  wrongWayReverseM: number;
  /** Reverse progress only counts while moving faster than this, m/s. */
  wrongWayMinSpeedMps: number;
  /** Stopped when speed is below this (strict <), m/s. */
  stuckSpeedMps: number;
  /** Stuck fires when continuously stopped for at least this long (>=), seconds. */
  stuckTimeoutS: number;
  /** Speeding when speed > limit × (1 + tolerance) (strict >). */
  speedingToleranceFrac: number;
  /** Speeding fires when continuously over for at least this long (>=), seconds. */
  speedingMinDurationS: number;
  /** ttc-critical when the step's minimum TTC drops below this (strict <), seconds. */
  ttcCriticalS: number;
  /** Comfort bounds: events fire when exceeded (strict >). */
  comfortMaxAccelMps2: number;
  comfortMaxJerkMps3: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  penalties: {
    // CARLA-leaderboard-shaped factors, SimForge event vocabulary.
    collisionVehicle: 0.6,
    collisionPedestrian: 0.5,
    collisionStatic: 0.65,
    offRoad: 0.75,
    wrongWay: 0.7,
    redLight: 0.7,
    stuck: 0.8,
    speeding: 0.9,
  },
  offRoadLateralM: 3.0,
  offRoadClearM: 0.5,
  wrongWayReverseM: 1.0,
  wrongWayMinSpeedMps: 0.5,
  stuckSpeedMps: 0.3,
  stuckTimeoutS: 8,
  speedingToleranceFrac: 0.1,
  speedingMinDurationS: 1.0,
  ttcCriticalS: 1.5,
  comfortMaxAccelMps2: 3.5,
  comfortMaxJerkMps3: 8,
};

/** Authored facts about the scenario an episode ran in. */
export interface ScenarioScoringContext {
  /** Decisions per second the trace was recorded at. */
  readonly decisionHz: number;
  /** Actor id → authored kind ('vehicle' | 'pedestrian' | 'bicycle' | …). */
  readonly actorKinds?: Readonly<Record<string, string>>;
  /** Authored speed limit for the ego's corridor; null disables the speeding checker. */
  readonly speedLimitMps?: number | null;
  /**
   * Authored route-completion denominator, metres. Route completion is
   * clamp(Δ route-arc / expectedRouteM); null scores completion as 1
   * (unassessed) unless the episode reached an explicit goal.
   */
  readonly expectedRouteM?: number | null;
}

/* ---------------------------------------------------------------- scoring */

export interface EpisodeScore {
  /** routeCompletion × penaltyProduct, in [0, 1]. */
  readonly drivingScore: number;
  readonly routeCompletion: number;
  readonly penaltyProduct: number;
  readonly infractions: Readonly<Record<InfractionType, number>>;
  readonly ttc: { readonly minTtcS: number | null; readonly criticalCount: number };
  readonly comfort: {
    readonly maxAbsAccelMps2: number;
    readonly maxAbsJerkMps3: number;
    readonly accelViolations: number;
    readonly jerkViolations: number;
  };
  readonly terminal: { readonly collision: boolean; readonly goal: boolean; readonly truncated: boolean };
  readonly steps: number;
  readonly deadlineMisses: number;
  readonly events: readonly ScoreEvent[];
}

const INFRACTION_TYPES: readonly InfractionType[] = [
  'collision-vehicle',
  'collision-pedestrian',
  'collision-static',
  'off-road',
  'wrong-way',
  'red-light',
  'stuck',
  'speeding',
];

function penaltyFor(type: InfractionType, p: PenaltyFactors): number {
  switch (type) {
    case 'collision-vehicle': return p.collisionVehicle;
    case 'collision-pedestrian': return p.collisionPedestrian;
    case 'collision-static': return p.collisionStatic;
    case 'off-road': return p.offRoad;
    case 'wrong-way': return p.wrongWay;
    case 'red-light': return p.redLight;
    case 'stuck': return p.stuck;
    case 'speeding': return p.speeding;
  }
}

function collisionTypeForKind(kind: string | undefined): InfractionType {
  if (kind === 'pedestrian') return 'collision-pedestrian';
  if (kind === 'vehicle' || kind === 'bicycle') return 'collision-vehicle';
  return 'collision-static';
}

/** Minimum time-to-collision across closing perceived objects; null when nothing closes. */
export function stepMinTtcS(objs: readonly TraceObj[]): number | null {
  let min: number | null = null;
  for (const [, rangeM, , rangeRateMps] of objs) {
    if (rangeRateMps >= 0) continue; // opening or holding
    const ttc = rangeM / -rangeRateMps;
    if (min === null || ttc < min) min = ttc;
  }
  return min;
}

export function resolveScoringConfig(overrides?: Partial<ScoringConfig>): ScoringConfig {
  return {
    ...DEFAULT_SCORING_CONFIG,
    ...overrides,
    penalties: { ...DEFAULT_SCORING_CONFIG.penalties, ...(overrides?.penalties ?? {}) },
  };
}

/** Score one episode trace against its authored scenario context. */
export function scoreEpisode(
  trace: ParsedTrace,
  ctx: ScenarioScoringContext,
  overrides?: Partial<ScoringConfig>,
): EpisodeScore {
  if (!Number.isFinite(ctx.decisionHz) || ctx.decisionHz <= 0) {
    throw new Error(`decisionHz must be positive, got ${String(ctx.decisionHz)}`);
  }
  const cfg = resolveScoringConfig(overrides);
  const dtS = 1 / ctx.decisionHz;
  const events: ScoreEvent[] = [];
  const counts: Record<InfractionType, number> = {
    'collision-vehicle': 0,
    'collision-pedestrian': 0,
    'collision-static': 0,
    'off-road': 0,
    'wrong-way': 0,
    'red-light': 0,
    'stuck': 0,
    'speeding': 0,
  };

  const push = (
    type: ScoreEventType,
    step: TraceStepRecord,
    severity: ScoreEvent['severity'],
    data?: Record<string, unknown>,
  ): void => {
    const sv = step.sv;
    const position = sv && sv.length >= 2 ? { x: sv[0]!, y: sv[1]! } : null;
    events.push({ type, tick: step.step, tS: step.t, severity, position, ...(data ? { data } : {}) });
    if (severity === 'infraction') counts[type as InfractionType] += 1;
  };

  // Route-completion baseline: the reset record's route arc when present.
  const s0 = trace.reset?.sv?.[8] ?? trace.steps[0]?.sv?.[8] ?? null;

  // Checker state.
  let offRoadActive = false;
  let reverseAccumM = 0;
  let wrongWayActive = false;
  let stoppedSteps = 0;
  let stuckActive = false;
  let overSpeedSteps = 0;
  let speedingActive = false;
  let ttcCriticalActive = false;
  let accelActive = false;
  let jerkActive = false;
  let prevAccel: number | null = null;
  let prevS: number | null = s0;
  let prevSig: TraceSignalState | null = null;

  let minTtcS: number | null = null;
  let maxAbsAccel = 0;
  let maxAbsJerk = 0;
  let accelViolations = 0;
  let jerkViolations = 0;
  let deadlineMisses = 0;
  let terminalCollision = false;
  let terminalGoal = false;
  let truncated = false;
  let lastS: number | null = s0;

  for (const step of trace.steps) {
    const sv = step.sv;
    const speed = sv?.[4] ?? 0;
    const accel = sv?.[5] ?? 0;
    const latOff = sv?.[6] ?? 0;
    const routeS = sv?.[8] ?? null;

    if (step.miss === 1) {
      deadlineMisses += 1;
      push('deadline-miss', step, 'info', { applied: step.applied ?? null });
    }

    // Off-road: strict > on entry, hysteresis on exit.
    if (!offRoadActive && Math.abs(latOff) > cfg.offRoadLateralM) {
      offRoadActive = true;
      push('off-road', step, 'infraction', { lateralOffsetM: latOff });
    } else if (offRoadActive && Math.abs(latOff) <= cfg.offRoadLateralM - cfg.offRoadClearM) {
      offRoadActive = false;
    }

    // Wrong-way: accumulate reverse route-arc progress while moving.
    if (routeS !== null && prevS !== null) {
      const ds = routeS - prevS;
      if (ds < 0 && speed > cfg.wrongWayMinSpeedMps) {
        reverseAccumM += -ds;
        if (!wrongWayActive && reverseAccumM >= cfg.wrongWayReverseM) {
          wrongWayActive = true;
          push('wrong-way', step, 'infraction', { reverseM: reverseAccumM });
        }
      } else if (ds > 0) {
        reverseAccumM = 0;
        wrongWayActive = false;
      }
    }
    if (routeS !== null) {
      prevS = routeS;
      lastS = routeS;
    }

    // Stuck: continuous stopped time, one event per stuck period. Duration
    // is steps × dt (one multiply), never a float accumulator, so the >=
    // boundary is exact at every decision rate that divides the engine tick.
    if (speed < cfg.stuckSpeedMps) {
      stoppedSteps += 1;
      if (!stuckActive && stoppedSteps * dtS >= cfg.stuckTimeoutS) {
        stuckActive = true;
        push('stuck', step, 'infraction', { stoppedS: stoppedSteps * dtS });
      }
    } else {
      stoppedSteps = 0;
      stuckActive = false;
    }

    // Speeding vs the authored limit, sustained (steps × dt, as above).
    if (ctx.speedLimitMps != null && ctx.speedLimitMps > 0) {
      const bound = ctx.speedLimitMps * (1 + cfg.speedingToleranceFrac);
      if (speed > bound) {
        overSpeedSteps += 1;
        if (!speedingActive && overSpeedSteps * dtS >= cfg.speedingMinDurationS) {
          speedingActive = true;
          push('speeding', step, 'infraction', { speedMps: speed, limitMps: ctx.speedLimitMps });
        }
      } else {
        overSpeedSteps = 0;
        speedingActive = false;
      }
    }

    // Red light: stop-line crossing (dist goes positive → non-positive) on red.
    const sig = step.sig ?? null;
    if (sig && prevSig && prevSig.state === 'red' && prevSig.distM > 0 && sig.distM <= 0) {
      push('red-light', step, 'infraction', { crossedAtDistM: sig.distM });
    }
    prevSig = sig;

    // TTC minima over closing perceived objects.
    const ttc = stepMinTtcS(step.objs);
    if (ttc !== null) {
      if (minTtcS === null || ttc < minTtcS) minTtcS = ttc;
      if (ttc < cfg.ttcCriticalS) {
        if (!ttcCriticalActive) {
          ttcCriticalActive = true;
          push('ttc-critical', step, 'warning', { ttcS: ttc });
        }
      } else {
        ttcCriticalActive = false;
      }
    } else {
      ttcCriticalActive = false;
    }

    // Comfort: accel and jerk bounds (decision-rate finite difference).
    const absAccel = Math.abs(accel);
    if (absAccel > maxAbsAccel) maxAbsAccel = absAccel;
    if (absAccel > cfg.comfortMaxAccelMps2) {
      accelViolations += 1;
      if (!accelActive) {
        accelActive = true;
        push('accel-bound', step, 'warning', { accelMps2: accel });
      }
    } else {
      accelActive = false;
    }
    if (prevAccel !== null) {
      const jerk = (accel - prevAccel) * ctx.decisionHz;
      const absJerk = Math.abs(jerk);
      if (absJerk > maxAbsJerk) maxAbsJerk = absJerk;
      if (absJerk > cfg.comfortMaxJerkMps3) {
        jerkViolations += 1;
        if (!jerkActive) {
          jerkActive = true;
          push('jerk-bound', step, 'warning', { jerkMps3: jerk });
        }
      } else {
        jerkActive = false;
      }
    }
    prevAccel = accel;

    // Terminal classification (shared rule with the eval server).
    if (step.term === 1) {
      const view = rewardViewFromStep(step);
      if (collisionFromReward(view)) {
        terminalCollision = true;
        const partner = step.objs[0] ?? null;
        const kind = partner ? ctx.actorKinds?.[partner[0]] : undefined;
        push(collisionTypeForKind(kind), step, 'infraction', {
          partnerId: partner?.[0] ?? null,
          partnerKind: kind ?? null,
          penalty: view.rewardTerms.collision ?? null,
        });
      }
      if (goalFromReward(view)) {
        terminalGoal = true;
        push('goal-reached', step, 'info', { bonus: view.rewardTerms.goal ?? null });
      }
    }
    if (step.trunc === 1) truncated = true;
  }

  // Route completion.
  let routeCompletion: number;
  if (terminalGoal) {
    routeCompletion = 1;
  } else if (ctx.expectedRouteM != null && ctx.expectedRouteM > 0 && s0 !== null && lastS !== null) {
    routeCompletion = Math.min(1, Math.max(0, (lastS - s0) / ctx.expectedRouteM));
  } else {
    routeCompletion = 1; // unassessed
  }

  let penaltyProduct = 1;
  for (const type of INFRACTION_TYPES) {
    const n = counts[type];
    if (n > 0) penaltyProduct *= penaltyFor(type, cfg.penalties) ** n;
  }

  return {
    drivingScore: routeCompletion * penaltyProduct,
    routeCompletion,
    penaltyProduct,
    infractions: counts,
    ttc: { minTtcS, criticalCount: events.filter((e) => e.type === 'ttc-critical').length },
    comfort: {
      maxAbsAccelMps2: maxAbsAccel,
      maxAbsJerkMps3: maxAbsJerk,
      accelViolations,
      jerkViolations,
    },
    terminal: { collision: terminalCollision, goal: terminalGoal, truncated },
    steps: trace.steps.length,
    deadlineMisses,
    events,
  };
}
