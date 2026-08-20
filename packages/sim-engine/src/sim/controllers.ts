/**
 * Per-axis controllers.
 *
 * ## Motion model (and what it is not)
 *
 * Vehicles are **path followers with a bicycle-ish heading**: longitudinal
 * state is `(s, v)` along the route arc length, lateral state is a signed
 * offset from the centreline, and heading is `routeHeading + atan2(ṫ, v)` — the
 * body slip a real steering input would produce. There is no tyre model, no
 * yaw inertia, no load transfer. Accelerations are clamped to per-class limits,
 * which is the level of fidelity criticality metrics (TTC, required decel,
 * arrival timing) are actually sensitive to.
 *
 * Pedestrians are point-mass path followers with the same code path and softer
 * limits.
 *
 * ## One axis, one owner
 *
 * `longCmd` and `latCmd` are single slots. A newly fired interaction on an axis
 * *replaces* whatever was there and emits a `preemption` event — action-level
 * replacement, no priorities, no nesting (the esmini lesson from the research
 * doc). Releasing a command (its `until` fired, or its profile completed and it
 * had no `until`) returns the axis to default behaviour: cruise at
 * `speedFactor × speedLimit`, hold zero lateral offset.
 */

import { clamp } from '../core/math.js';
import { isPedestrianLikeKind, type ActorKind } from '../schema/input.js';
import { alongRouteGapM, lateralSeparationM } from './pairs.js';
import { transitionValue } from './dynamics.js';
import type { ActorRuntime } from './state.js';
import type { SignalBook } from './signals.js';
import { phaseForbidsEntry } from './signals.js';

const LEGACY_DRIVER = {
  naturalistic: false,
  desiredSpeedFactor: 1,
  timeHeadwayS: 1,
  minimumGapM: 2,
  accelScale: 1,
  comfortBrakeScale: 1,
  reactionTimeS: 0,
  startDelayS: 0,
  comfortableLateralAccelerationMps2: 2.2,
  comfortableDecelerationMps2: 2.5,
} as const;

function driverFor(a: ActorRuntime): NonNullable<ActorRuntime['driver']> {
  return a.driver ?? LEGACY_DRIVER;
}

export interface MotionLimits {
  readonly accelMax: number;
  readonly brakeComfort: number;
  readonly brakeHard: number;
  readonly lateralRateMax: number;
  readonly lateralAccelMax: number;
  readonly lateralJerkMax: number;
}

export const VEHICLE_LIMITS: MotionLimits = {
  accelMax: 3.0,
  brakeComfort: 3.5,
  brakeHard: 8.0,
  lateralRateMax: 2.5,
  lateralAccelMax: 3.0,
  // A 3.5 m quintic lane change in 3 s peaks at 7.78 m/s³. Keep the common
  // passenger-car preset feasible while still bounding the profile.
  lateralJerkMax: 8.0,
};

export const PEDESTRIAN_LIMITS: MotionLimits = {
  accelMax: 1.5,
  brakeComfort: 1.5,
  brakeHard: 3.0,
  lateralRateMax: 1.0,
  lateralAccelMax: 2.0,
  lateralJerkMax: 4.0,
};

/** Per-class envelopes. Generic `vehicle` keeps the original limits so legacy
 * inputs simulate byte-for-byte as before. */
export const MOTION_LIMITS_BY_KIND: Readonly<Record<ActorKind, MotionLimits>> = {
  vehicle: VEHICLE_LIMITS,
  car: VEHICLE_LIMITS,
  truck: {
    accelMax: 1.4,
    brakeComfort: 2.5,
    brakeHard: 6,
    lateralRateMax: 1.25,
    lateralAccelMax: 1.5,
    lateralJerkMax: 2.5,
  },
  bus: {
    accelMax: 1.2,
    brakeComfort: 2.2,
    brakeHard: 5.5,
    lateralRateMax: 1.1,
    lateralAccelMax: 1.3,
    lateralJerkMax: 2.2,
  },
  van: {
    accelMax: 2.4,
    brakeComfort: 3.2,
    brakeHard: 7,
    lateralRateMax: 2,
    lateralAccelMax: 2.4,
    lateralJerkMax: 5,
  },
  motorcycle: {
    accelMax: 4,
    brakeComfort: 4,
    brakeHard: 9,
    lateralRateMax: 3,
    lateralAccelMax: 4,
    lateralJerkMax: 8,
  },
  bicycle: {
    accelMax: 1.1,
    brakeComfort: 1.5,
    brakeHard: 3.5,
    lateralRateMax: 1.2,
    lateralAccelMax: 2,
    lateralJerkMax: 4,
  },
  pedestrian: PEDESTRIAN_LIMITS,
  scooter: {
    accelMax: 1.5,
    brakeComfort: 2,
    brakeHard: 4,
    lateralRateMax: 1.5,
    lateralAccelMax: 2.5,
    lateralJerkMax: 5,
  },
  sidewalk_robot: {
    accelMax: 1.2,
    brakeComfort: 1.8,
    brakeHard: 3.5,
    lateralRateMax: 1.2,
    lateralAccelMax: 2,
    lateralJerkMax: 4,
  },
  drone: {
    accelMax: 3,
    brakeComfort: 3,
    brakeHard: 6,
    lateralRateMax: 3,
    lateralAccelMax: 4,
    lateralJerkMax: 8,
  },
  animal: {
    accelMax: 2,
    brakeComfort: 2,
    brakeHard: 4,
    lateralRateMax: 1.5,
    lateralAccelMax: 3,
    lateralJerkMax: 6,
  },
  static_object: {
    accelMax: 0,
    brakeComfort: 0,
    brakeHard: 0,
    lateralRateMax: 0,
    lateralAccelMax: 0,
    lateralJerkMax: 0,
  },
};

export function limitsFor(a: Pick<ActorRuntime, 'kind'>): MotionLimits {
  return MOTION_LIMITS_BY_KIND[a.kind];
}

/** Cruise convergence gain: `τ = 0.5 s`, so warm-up settles to <1e-4 relative
 * error in 5 s. Deliberately brisk — the prologue exists to remove transients. */
const CRUISE_GAIN = 2.0;

/** Gap controller gains (PD on gap error). Critically damped for a 15 m/s
 * follower at a 2 s headway; equilibrium gap equals the commanded gap exactly,
 * unlike IDM's `1/sqrt(1-(v/v0)^4)` offset. */
const GAP_KP = 0.4;
const GAP_KD = 1.2;
/** Jam distance floor so a commanded time-gap does not collapse at standstill. */
const GAP_MIN_M = 2.0;

/** Aggression 0 → 1.3× gaps, 0.5 → 1.0×, 1 → 0.7×. */
export function gapScaleFor(aggression: number): number {
  return 1.3 - 0.6 * aggression;
}

/** Desired free-flow speed for an actor at its current position. */
export function cruiseSpeed(a: ActorRuntime, laneSpeedLimitMps: number): number {
  if (a.cruiseOverrideMps !== null) return a.cruiseOverrideMps;
  return laneSpeedLimitMps * a.rules.speedFactor * driverFor(a).desiredSpeedFactor;
}

/** Acceleration that converges on `vTarget` with a first-order lag. */
export function converge(a: ActorRuntime, vTarget: number, lim: MotionLimits): number {
  return clamp((vTarget - a.speedMps) * CRUISE_GAIN, -lim.brakeComfort, lim.accelMax);
}

/** PD gap-keeping acceleration toward `gapDesired` behind `leaderSpeed`. */
export function gapAccel(
  a: ActorRuntime,
  gapM: number,
  leaderSpeedMps: number,
  gapDesiredM: number,
  lim: MotionLimits,
): number {
  const error = gapM - Math.max(gapDesiredM, GAP_MIN_M);
  const raw = GAP_KP * error + GAP_KD * (leaderSpeedMps - a.speedMps);
  return clamp(raw, -lim.brakeHard, lim.accelMax);
}

/** Desired gap in metres for a `gap` command. */
export function desiredGapM(
  a: ActorRuntime,
  value: number,
  mode: 'time' | 'distance',
  scaled: boolean,
): number {
  const base = mode === 'time' ? value * a.speedMps : value;
  return scaled ? base * gapScaleFor(a.rules.aggression) : base;
}

/* ----------------------------------------------------------- longitudinal */

export interface LongitudinalInput {
  readonly actor: ActorRuntime;
  readonly t: number;
  readonly dt: number;
  readonly laneSpeedLimitMps: number;
  readonly leader: { gapM: number; speedMps: number } | null;
}

/** Commanded acceleration from the axis owner (or the default cruise law). */
export function longitudinalAccel(input: LongitudinalInput): number {
  const { actor: a, t, dt } = input;
  const lim = limitsFor(a);
  const cmd = a.longCmd;
  if (!cmd) {
    return converge(a, cruiseSpeed(a, input.laneSpeedLimitMps), lim);
  }
  if (cmd.kind === 'speed') {
    const vNext = transitionValue(cmd.dynamics, cmd.v0, cmd.target, t + dt - cmd.firedAt, cmd.duration);
    return clamp((vNext - a.speedMps) / dt, -lim.brakeHard, lim.accelMax);
  }
  // gap: the dynamics profile shapes the *approach* from the gap at fire time
  // to the commanded gap; a PD loop then tracks whatever the profile asks for.
  const gapNow = input.leader?.gapM ?? Infinity;
  const leaderV = input.leader?.speedMps ?? a.speedMps;
  if (!Number.isFinite(gapNow)) {
    return converge(a, cruiseSpeed(a, input.laneSpeedLimitMps), lim);
  }
  const gapCommanded = transitionValue(
    cmd.dynamics,
    cmd.v0,
    cmd.target,
    t + dt - cmd.firedAt,
    cmd.duration,
  );
  const accel = gapAccel(a, gapNow, leaderV, gapCommanded, lim);
  // Never exceed free flow while gap keeping.
  const vCap = cruiseSpeed(a, input.laneSpeedLimitMps);
  return a.speedMps + accel * dt > vCap ? clamp((vCap - a.speedMps) / dt, -lim.brakeHard, lim.accelMax) : accel;
}

/* --------------------------------------------------------------- governor */

export interface HazardResult {
  /** Most restrictive acceleration the governor will allow, m/s². */
  readonly accelCap: number;
  /** Decel that *would* have been required to avoid contact, m/s² (≥ 0). */
  readonly requiredDecel: number;
  /**
   * The same figure with the *car-following* term removed.
   *
   * Only the leader term can be produced by a body the caller did not author:
   * `distanceToStopLine` is map infrastructure, and the crossing-conflict term
   * already refuses to let generated traffic take priority over authored
   * choreography. Publishing the split lets the caller keep
   * `requiredDecelMax` meaning "how hard the authored scenario demanded I
   * brake" even when a generated car is physically in front.
   */
  readonly requiredDecelExcludingLeader: number;
  readonly reason: 'none' | 'leader' | 'signal' | 'conflict';
}

/** Deceleration needed to shed `dv` over `gap` metres. */
export function requiredDecelFor(dv: number, gapM: number): number {
  if (dv <= 0) return 0;
  return (dv * dv) / (2 * Math.max(gapM, 0.05));
}

/**
 * The safety governor. Returns a *cap* on acceleration; the caller takes the
 * minimum with the commanded value, so the governor can only ever brake.
 *
 * `rules.collisionAvoidance = false` bypasses the leader and conflict terms
 * entirely — this is the flag that lets a challenger commit instead of
 * chickening out. Signal compliance is separate (`rules.obeySignals`) because
 * running a red is a *rule* violation, not a safety-system failure.
 */
export function governorCap(
  a: ActorRuntime,
  leader: { gapM: number; speedMps: number } | null,
  stopLineDistM: number | null,
  conflict: { distM: number; deltaT: number; otherKind?: ActorKind } | null,
): HazardResult {
  const lim = limitsFor(a);
  let cap = Infinity;
  let required = 0;
  // The same running maximum with the car-following term never folded in.
  let requiredWithoutLeader = 0;
  let reason: HazardResult['reason'] = 'none';

  if (a.rules.collisionAvoidance && leader) {
    const driver = driverFor(a);
    // Compact IDM-style following. It preserves a real jam gap, expands with
    // speed and closing rate, and naturally propagates queues without overlap.
    const closing = a.speedMps - leader.speedMps;
    const desired = driver.minimumGapM
      + a.speedMps * driver.timeHeadwayS
      + Math.max(0, (a.speedMps * closing) / (2 * Math.sqrt(
        Math.max(0.1, lim.accelMax * driver.accelScale * lim.brakeComfort * driver.comfortBrakeScale),
      )));
    const freeSpeed = Math.max(a.cruiseSpeedMps, 0.1);
    const accel = driver.naturalistic
      ? lim.accelMax * driver.accelScale * (
          1 - Math.pow(a.speedMps / freeSpeed, 4) - Math.pow(desired / Math.max(leader.gapM, 0.2), 2)
        )
      : gapAccel(
          a,
          leader.gapM,
          leader.speedMps,
          Math.max(a.speedMps * (1.5 - a.rules.aggression), GAP_MIN_M),
          lim,
        );
    const req = requiredDecelFor(a.speedMps - leader.speedMps, leader.gapM);
    required = Math.max(required, req);
    if (accel < cap) {
      cap = accel;
      reason = 'leader';
    }
  }

  if (stopLineDistM !== null) {
    // Brake to a stop at the line: a = -v² / 2d, with a 0.5 m standoff. Inside
    // the standoff the term saturates so the actor comes to a *clean* stop
    // rather than creeping asymptotically toward the line.
    // Reserve the driver's perception distance before solving the braking
    // envelope. This starts braking earlier while retaining a clean 0.5 m
    // stand-off and the fixed-step deterministic integration.
    const d = stopLineDistM - 0.5 - a.speedMps * driverFor(a).reactionTimeS;
    const accel = d <= 0.05 || (stopLineDistM <= 6 && a.speedMps < 1.5)
      ? -lim.brakeHard
      : -(a.speedMps * a.speedMps) / (2 * d);
    required = Math.max(required, -accel);
    requiredWithoutLeader = Math.max(requiredWithoutLeader, -accel);
    const capped = Math.max(accel, -lim.brakeHard);
    if (capped < cap) {
      cap = capped;
      reason = 'signal';
    }
  }

  const yieldsToConflict = conflict
    ? conflict.otherKind === undefined
      ? a.rules.yieldToVehicles
      : isPedestrianLikeKind(conflict.otherKind)
        ? a.rules.yieldToPedestrians
        : a.rules.yieldToVehicles
    : false;
  if (a.rules.collisionAvoidance && a.rules.yield && yieldsToConflict && conflict) {
    // Give way: shed enough speed that we reach the crossing after them.
    const accel = -(a.speedMps * a.speedMps) / (2 * Math.max(conflict.distM - 2, 0.5));
    required = Math.max(required, -accel);
    requiredWithoutLeader = Math.max(requiredWithoutLeader, -accel);
    const capped = Math.max(accel, -lim.brakeComfort);
    if (capped < cap) {
      cap = capped;
      reason = 'conflict';
    }
  }

  return {
    accelCap: cap,
    requiredDecel: required,
    requiredDecelExcludingLeader: requiredWithoutLeader,
    reason,
  };
}

/* ----------------------------------------------------------------- lateral */

/** Lateral offset for this tick, rate limited. Returns `{offset, rate}`. */
export function lateralStep(
  a: ActorRuntime,
  t: number,
  dt: number,
): { offset: number; rate: number; accel: number; complete: boolean } {
  const lim = limitsFor(a);
  const cmd = a.latCmd;
  const target = cmd ? cmd.to : (a.lateralRestOffsetM ?? 0);
  let offset: number;
  let rate: number;
  let accel: number;
  let complete = false;
  if (cmd) {
    const elapsed = t + dt - cmd.firedAt;
    const sample = minimumJerkSample(cmd.from, cmd.to, elapsed, cmd.duration);
    offset = sample.offset;
    rate = sample.rate;
    accel = sample.accel;
    complete = elapsed >= cmd.duration - 1e-9;
  } else {
    // No owner: hold the completed lane-relative offset. A new command owns
    // any subsequent recentering explicitly.
    offset = target;
    rate = 0;
    accel = 0;
  }
  // These clamps should be inactive because the duration was analytically
  // bounded. Retain them as floating-point safety rails.
  rate = clamp(rate, -lim.lateralRateMax, lim.lateralRateMax);
  accel = clamp(accel, -lim.lateralAccelMax, lim.lateralAccelMax);
  return { offset, rate, accel, complete };
}

/** Full Frenet reference on the same minimum-jerk profile used by lateralStep. */
export function minimumJerkSample(
  from: number,
  to: number,
  elapsedS: number,
  durationS: number,
): { offset: number; rate: number; accel: number } {
  const duration = Math.max(durationS, 1e-9);
  const u = clamp(elapsedS / duration, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  const distance = to - from;
  return {
    offset: from + distance * (10 * u3 - 15 * u4 + 6 * u5),
    rate: distance * (30 * u2 - 60 * u3 + 30 * u4) / duration,
    accel: distance * (60 * u - 180 * u2 + 120 * u3) / (duration * duration),
  };
}

/** Position-only compatibility helper for pair prediction and tests. */
export function minimumJerkValue(from: number, to: number, elapsedS: number, durationS: number): number {
  return minimumJerkSample(from, to, elapsedS, durationS).offset;
}

/** Heading including the body slip implied by lateral motion. */
export function headingWithSlip(pathHeading: number, lateralRate: number, speed: number): number {
  return pathHeading + Math.atan2(lateralRate, Math.max(speed, 0.5));
}

/* ------------------------------------------------------- hazard detection */

/** Nearest actor ahead in the same lane corridor, on the observer's route. */
export function findLeader(
  a: ActorRuntime,
  others: readonly ActorRuntime[],
  corridorHalfWidthM = 1.6,
): { gapM: number; speedMps: number; id: string } | null {
  let best: { gapM: number; speedMps: number; id: string } | null = null;
  for (const b of others) {
    if (b.id === a.id || !b.present || b.retired) continue;
    // Ambient and authored default-route actors share one traffic model. An
    // explicit authored command may own the target speed, but collision
    // avoidance still observes every physical leader in the scene.
    const gap = alongRouteGapM(a, b);
    if (gap === null || gap <= 0) continue;
    const lateral = lateralSeparationM(a, b);
    if (lateral === null || Math.abs(lateral) > corridorHalfWidthM) continue;
    if (best === null || gap < best.gapM) best = { gapM: gap, speedMps: b.speedMps, id: b.id };
  }
  return best;
}

/**
 * Distance to the next stop line the actor must respect, or `null`.
 *
 * Only lines on lanes the route actually traverses count, and only ahead of the
 * actor. A yellow is treated as forbidding entry; the governor's `-v²/2d` cap
 * then naturally lets a car too close to stop comfortably continue through,
 * because the required decel exceeds `brakeHard` and the cap saturates.
 */
export function distanceToStopLine(
  a: ActorRuntime,
  signals: SignalBook,
  t: number,
  lookaheadM: number,
  leader: { gapM: number; speedMps: number } | null = null,
  canReleaseStop: ((controlId: string, coordinationId: string, actorId: string, t: number) => boolean) | null = null,
): number | null {
  if (!a.rules.obeySignals || signals.isEmpty || a.route.isFreeform) return null;
  let best: number | null = null;
  for (const leg of a.route.legs) {
    if (leg.sStart + leg.lengthM < a.routeS) continue;
    if (leg.sStart - a.routeS > lookaheadM) break;
    for (const line of signals.onLane(leg.rsl)) {
      if (
        line.connectingLaneRsls.length > 0 &&
        !a.route.legs.some(
          (candidate) =>
            candidate.sStart >= leg.sStart && line.connectingLaneRsls.includes(candidate.rsl),
        )
      ) {
        continue;
      }
      const laneS = leg.reversed ? leg.lengthM - line.s : line.s;
      const routeS = leg.sStart + laneS;
      const d = routeS - a.routeS;
      if (d < -0.5 || d > lookaheadM) continue;
      // Authority is resolved per tick, not per binding: a signal that is dark
      // or flashing red right now presents a stop control right now.
      const authority = signals.authorityAt(line, t);
      if (authority.kind === 'none') continue;
      if (authority.kind === 'stop') {
        const states = a.roadControlStates;
        const state = states.get(line.controlId) ?? {
          stoppedSinceS: null, released: false, arrivedAtS: null, releasedAtS: null,
          proceedAfterS: null, wasBlocked: false,
        };
        if (state.released) continue;
        // dynamic-v1 can settle a few metres upstream under its bounded brake
        // actuator; that is still a complete, compliant stop, not a reason to
        // wait forever for sub-centimetre path convergence.
        if (a.speedMps <= 0.05 && d <= 6) {
          if (state.stoppedSinceS === null) {
            state.stoppedSinceS = t;
            state.arrivedAtS = t;
          }
          if (t - state.stoppedSinceS >= authority.dwellS) {
            if (state.proceedAfterS === null && (canReleaseStop?.(line.controlId, line.coordinationId, a.id, t) ?? true)) {
              state.proceedAfterS = t + driverFor(a).startDelayS;
            }
            if (state.proceedAfterS !== null && t >= state.proceedAfterS) {
              state.released = true;
              state.releasedAtS = t;
              states.set(line.controlId, state);
              continue;
            }
          }
        } else if (a.speedMps > 0.05) {
          // Dwell must be continuous; rolling stops reset the clock.
          state.stoppedSinceS = null;
        }
        states.set(line.controlId, state);
      } else {
        const phase = line.signalId === null ? null : signals.phaseAt(line.signalId, t);
        const state = a.roadControlStates.get(line.controlId) ?? {
          stoppedSinceS: null, released: false, arrivedAtS: null, releasedAtS: null,
          proceedAfterS: null, wasBlocked: false,
        };
        if (state.released) continue;

        // A yellow is a real dilemma-zone decision, not a request for an
        // emergency stop. Once the comfort envelope says continue, remember
        // that commitment so a red transition while crossing cannot make the
        // vehicle stop inside the junction.
        if (phase === 'yellow') {
          const comfortRequired = requiredDecelFor(a.speedMps, Math.max(d - 0.5, 0.05));
          if (comfortRequired > limitsFor(a).brakeComfort) {
            state.released = true;
            a.roadControlStates.set(line.controlId, state);
            continue;
          }
        }

        // Even on green, do not enter a junction whose connecting lane and
        // immediate exit are occupied by a stopped queue. This is the compact
        // browser-native equivalent of a keep-clear/intersection-box rule.
        const connectingLeg = line.connectingLaneRsls
          .map((rsl) => a.route.legs.find((candidate) => candidate.sStart >= leg.sStart && candidate.rsl === rsl))
          .find((candidate) => candidate !== undefined);
        const blockedExit = leader !== null
          && leader.speedMps < 1.5
          && leader.gapM > d
          && leader.gapM < d + (connectingLeg?.lengthM ?? 12) + 8;
        const forbidden = blockedExit || (phase !== null && phaseForbidsEntry(phase));
        if (forbidden) {
          state.wasBlocked = true;
          state.proceedAfterS = null;
          a.roadControlStates.set(line.controlId, state);
        } else if (state.wasBlocked) {
          if (state.proceedAfterS === null) state.proceedAfterS = t + driverFor(a).startDelayS;
          a.roadControlStates.set(line.controlId, state);
          if (t >= state.proceedAfterS) {
            state.released = true;
            state.releasedAtS = t;
            continue;
          }
        } else {
          continue;
        }
      }
      if (best === null || d < best) best = Math.max(d, 0);
    }
  }
  return best;
}
