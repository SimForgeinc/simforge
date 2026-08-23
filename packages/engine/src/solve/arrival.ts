/**
 * The arrival solver — the research doc's highest-value feature.
 *
 * `arrival(of, at, syncWith, ttc | deltaT)` back-solves **where the challenger
 * starts** so that it reaches a conflict point at a declared criticality
 * relative to a reference actor's nominal motion. Without it roughly 80 % of
 * generated scenarios are trivially non-critical.
 *
 * ## Semantics
 *
 * - `ttc: 1.5` — when `of` reaches the point, `syncWith` is **1.5 s away from
 *   it**. (Euro NCAP's T0 and Scenic's `CrossingBehavior` both read it this
 *   way.)
 * - `deltaT: -1.5` — `of` reaches the point 1.5 s **before** `syncWith`.
 *
 * They are one number with two signs: `ttc === -deltaT`, so the solver works
 * internally in `deltaT`.
 *
 * ## Method
 *
 * `t_of(δ)` — the nominal arrival time as a function of a spawn-`s` offset δ —
 * is strictly decreasing (start further along, arrive sooner). Bisection on δ
 * over `[-startS, routeLength - startS)` therefore converges monotonically.
 * The tolerance is 1 mm of spawn `s`; a fixed 80-iteration cap makes the
 * iteration count itself deterministic (the interval halves 80 times, far past
 * double precision, so the cap is never the binding constraint).
 *
 * Nothing here uses randomness or wall-clock time, and the probe is a nominal
 * 1-D integration rather than a full sim — a solve costs microseconds.
 */

import { issue, type SimIssue } from '../errors.js';
import { toSceneXZ, localFromScene } from '../frames.js';
import type { LaneGraph } from '../map/lane-graph.js';
import { buildRoute, type Route } from '../map/route.js';
import type { ArrivalSpec, SimActor, SimScenarioInput } from '../schema/input.js';
import { nominalRun, type NominalActor } from './nominal.js';

/** Spawn-`s` tolerance, metres. */
export const ARRIVAL_TOLERANCE_M = 1e-3;
const MAX_ITERATIONS = 80;
/**
 * A geometry-only point must actually lie on the route. Two metres covers
 * centre-of-carriageway conflict points between ordinary lanes without being a
 * nearest-road search radius. Wider authored offsets carry reference-frame
 * stations and are resolved by lane identity instead.
 */
const MAX_GEOMETRIC_ARRIVAL_PROJECTION_M = 2;

export interface ArrivalSolution {
  readonly interactionId: string | null;
  /** The actor whose spawn was moved. */
  readonly actorId: string;
  readonly referenceActorId: string;
  /** Signed change applied to the actor's spawn arc length, metres. */
  readonly spawnDeltaS: number;
  /** Resulting spawn arc length on the actor's route. */
  readonly spawnS: number;
  /** Requested `t_of − t_ref`, seconds. */
  readonly targetDeltaT: number;
  /** Achieved `t_of − t_ref`, seconds. */
  readonly achievedDeltaT: number;
  /** Achieved criticality in TTC form (`−achievedDeltaT`). */
  readonly achievedTtc: number;
  /** Time `of` reaches the point — the time an `arrival` trigger fires. */
  readonly fireTime: number;
  readonly iterations: number;
  readonly converged: boolean;
}

interface Prepared {
  readonly route: Route;
  readonly nominal: NominalActor;
  readonly targetS: number;
}

function prepare(
  graph: LaneGraph,
  actor: SimActor,
  point: ArrivalSpec['at'],
): Prepared | null {
  const built = buildRoute(graph, actor.behavior.route);
  if (!built.ok) return null;
  const route = built.route;

  let startS: number;
  const laneRef = actor.initial.laneRef;
  if (laneRef) {
    const s = route.sOfLaneStorage(laneRef.rsl, laneRef.s);
    startS = s ?? route.projectPoint(localFromScene(actor.initial.pose)).s;
  } else {
    startS = route.projectPoint(localFromScene(actor.initial.pose)).s;
  }

  let targetS: number | null;
  if (point.kind === 'laneS') {
    targetS = route.sOfLaneStorage(point.rsl, point.s);
  } else {
    targetS = null;
    if (point.referenceFrame && !route.isFreeform) {
      for (const station of point.referenceFrame.stations) {
        const routeS = route.sOfLaneStorage(station.rsl, station.s);
        if (routeS !== null) {
          targetS = routeS;
          break;
        }
      }
    }
    // A declared reference frame is a lane-domain proof, not a hint. Falling
    // back to nearest geometry when a lane route matches none of its stations
    // would allow a parallel/off-route carriageway to inherit the arrival.
    // Freeform crossing routes have no lane identity, so they necessarily use
    // the tightly bounded geometric test.
    if (targetS === null && (!point.referenceFrame || route.isFreeform)) {
      const proj = route.projectPoint(localFromScene(point.at));
      targetS = proj.d <= MAX_GEOMETRIC_ARRIVAL_PROJECTION_M ? proj.s : null;
    }
  }
  if (targetS === null) return null;

  return {
    route,
    targetS,
    nominal: {
      kind: actor.kind,
      route,
      startS,
      initialSpeedMps: actor.initial.speedMps,
      speedFactor: actor.behavior.rules.speedFactor,
      cruiseOverrideMps: actor.behavior.cruiseSpeedMps ?? null,
    },
  };
}

export interface SolveArrivalOptions {
  readonly interactionId?: string | null;
}

/**
 * Standalone solve. Returns the solution *without* mutating the input; use
 * `applyArrivalSolution` (or `resolveArrivalTriggers`) to write it back.
 */
export function solveArrival(
  input: SimScenarioInput,
  spec: ArrivalSpec,
  graph: LaneGraph,
  opts: SolveArrivalOptions = {},
): { ok: true; solution: ArrivalSolution } | { ok: false; issue: SimIssue } {
  const path = `interactions.${opts.interactionId ?? '<standalone>'}.trigger.arrival`;
  const ofActor = input.actors.find((a) => a.id === spec.of);
  const refActor = input.actors.find((a) => a.id === spec.syncWith);
  if (!ofActor || !refActor) {
    return {
      ok: false,
      issue: issue('actor_unknown', path, `arrival references an unknown actor`, {
        of: spec.of,
        syncWith: spec.syncWith,
      }),
    };
  }

  const ofPrep = prepare(graph, ofActor, spec.at);
  const refPrep = prepare(graph, refActor, spec.at);
  if (!ofPrep || !refPrep) {
    return {
      ok: false,
      issue: issue(
        'arrival_unsolvable',
        path,
        `the arrival point is not on ${!ofPrep ? spec.of : spec.syncWith}'s route`,
      ),
    };
  }

  const runOpts = {
    dt: input.dt,
    warmupSeconds: input.warmupSeconds,
    horizonSeconds: input.clipSeconds,
  };
  const refProbe = nominalRun(graph, refPrep.nominal, refPrep.targetS, runOpts);
  if (refProbe.tAtTarget === null) {
    return {
      ok: false,
      issue: issue(
        'arrival_unsolvable',
        path,
        `${spec.syncWith} never reaches the arrival point within the clip`,
      ),
    };
  }
  const tRef = refProbe.tAtTarget;
  const targetDeltaT = spec.deltaT !== undefined ? spec.deltaT : -(spec.ttc as number);
  const wantT = tRef + targetDeltaT;

  const startS = ofPrep.nominal.startS;
  const probeAt = (delta: number): number | null => {
    const s = startS + delta;
    if (s < 0 || s >= ofPrep.targetS) return null;
    return nominalRun(graph, { ...ofPrep.nominal, startS: s }, ofPrep.targetS, runOpts).tAtTarget;
  };

  // t(δ) decreases in δ. Bracket: δLo = as far back as the route allows,
  // δHi = just short of the target point.
  let lo = -startS;
  let hi = ofPrep.targetS - startS - 0.05;
  if (hi <= lo) {
    return {
      ok: false,
      issue: issue('arrival_unsolvable', path, `${spec.of} has no room to move on its route`, {
        startS,
        targetS: ofPrep.targetS,
      }),
    };
  }
  const tLo = probeAt(lo);
  const tHi = probeAt(hi);
  let converged = true;
  // `tLo === null` means the actor cannot reach the point from the far end
  // within the horizon; bisection still works — that end simply reads as
  // "arrives too late", which is the direction the search already handles.
  if ((tLo !== null && wantT > tLo) || (tHi !== null && wantT < tHi)) {
    converged = false; // requested time outside the achievable band; we clamp.
  }

  let iterations = 0;
  while (hi - lo > ARRIVAL_TOLERANCE_M && iterations < MAX_ITERATIONS) {
    iterations++;
    const mid = (lo + hi) / 2;
    const tMid = probeAt(mid);
    if (tMid === null || tMid > wantT) lo = mid;
    else hi = mid;
  }
  const delta = (lo + hi) / 2;
  const achievedT = probeAt(delta);
  if (achievedT === null) {
    return {
      ok: false,
      issue: issue('arrival_unsolvable', path, `${spec.of} never reaches the arrival point`),
    };
  }
  const achievedDeltaT = achievedT - tRef;
  if (Math.abs(achievedDeltaT - targetDeltaT) > 0.05) converged = false;

  return {
    ok: true,
    solution: {
      interactionId: opts.interactionId ?? null,
      actorId: spec.of,
      referenceActorId: spec.syncWith,
      spawnDeltaS: delta,
      spawnS: startS + delta,
      targetDeltaT,
      achievedDeltaT,
      achievedTtc: -achievedDeltaT,
      fireTime: achievedT,
      iterations,
      converged,
    },
  };
}

/** Rewrite an actor's spawn pose / laneRef to the solved arc length. */
export function applyArrivalSolution(
  input: SimScenarioInput,
  solution: ArrivalSolution,
  graph: LaneGraph,
): SimScenarioInput {
  const actors = input.actors.map((a) => {
    if (a.id !== solution.actorId) return a;
    const built = buildRoute(graph, a.behavior.route);
    if (!built.ok) return a;
    const route = built.route;
    const oldPoint = localFromScene(a.initial.pose);
    const oldRouteS = a.initial.laneRef
      ? (route.sOfLaneStorage(a.initial.laneRef.rsl, a.initial.laneRef.s) ?? route.projectPoint(oldPoint).s)
      : route.projectPoint(oldPoint).s;
    const oldRoutePose = route.poseAt(oldRouteS);
    const headingOffset = Math.atan2(
      Math.sin(a.initial.pose.headingRad - oldRoutePose.headingRad),
      Math.cos(a.initial.pose.headingRad - oldRoutePose.headingRad),
    );
    const lateralM = a.initial.laneRef
      ? a.initial.laneRef.tFrac * route.widthAt(solution.spawnS)
      : route.lateralOffsetAt(oldRouteS, oldPoint);
    const pose = route.poseAt(solution.spawnS);
    const scene = toSceneXZ(route.pointWithOffset(solution.spawnS, lateralM));
    return {
      ...a,
      initial: {
        ...a.initial,
        pose: { x: scene.x, z: scene.z, headingRad: pose.headingRad + headingOffset },
        laneRef:
          pose.rsl === null
            ? a.initial.laneRef
            : { rsl: pose.rsl, s: pose.storageS, tFrac: a.initial.laneRef?.tFrac ?? 0 },
      },
    };
  });
  return { ...input, actors };
}

/**
 * Pre-sim resolution pass: solve every `arrival` trigger, move the challengers'
 * spawns, and rewrite the triggers into fixed `at(t)` times.
 *
 * Solves are applied in sorted interaction-id order and each one sees the
 * document produced by the previous, so chained arrivals are reproducible.
 */
export function resolveArrivalTriggers(
  input: SimScenarioInput,
  graph: LaneGraph,
): { input: SimScenarioInput; solutions: ArrivalSolution[]; issues: SimIssue[] } {
  const arrivals = input.interactions
    .filter((it) => it.trigger.kind === 'arrival')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (arrivals.length === 0) return { input, solutions: [], issues: [] };

  let current = input;
  const solutions: ArrivalSolution[] = [];
  const issues: SimIssue[] = [];
  const fireTimes = new Map<string, number>();

  for (const it of arrivals) {
    if (it.trigger.kind !== 'arrival') continue;
    const result = solveArrival(current, it.trigger.arrival, graph, { interactionId: it.id });
    if (!result.ok) {
      issues.push(result.issue);
      continue;
    }
    solutions.push(result.solution);
    if (!result.solution.converged) {
      issues.push(
        issue(
          'arrival_unsolvable',
          `interactions.${it.id}.trigger.arrival`,
          `clamped: achieved Δt ${result.solution.achievedDeltaT.toFixed(3)} s vs requested ${result.solution.targetDeltaT.toFixed(3)} s`,
          { achievedDeltaT: result.solution.achievedDeltaT, targetDeltaT: result.solution.targetDeltaT },
          'warning',
        ),
      );
    }
    current = applyArrivalSolution(current, result.solution, graph);
    fireTimes.set(it.id, result.solution.fireTime);
  }

  const interactions = current.interactions.map((it) => {
    const t = fireTimes.get(it.id);
    if (t === undefined || it.trigger.kind !== 'arrival') return it;
    return { ...it, trigger: { kind: 'at' as const, t: Math.max(t, 0) } };
  });

  return { input: { ...current, interactions }, solutions, issues };
}
