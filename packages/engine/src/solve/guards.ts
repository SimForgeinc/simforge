/**
 * Pre-run feasibility guards.
 *
 * These are the checks the research doc calls out as the ones that actually
 * catch generated garbage before it wastes a simulation:
 *
 * 1. **runway over the whole clip** — reported as a quality warning because
 *    reaching a route endpoint is a supported terminal condition;
 * 2. **required decel ≤ budget** — reported as a quality warning because the
 *    longitudinal controller saturates at the actor's physical braking limit;
 * 3. **spawn OBBs disjoint** — real dimensions, not bounding circles;
 * 4. **spawn `s` within the lane** and **on the actor's route**;
 * 5. **route connected**.
 *
 * Everything comes back as `{code, severity, path, reason}` for repair loops.
 */

import { obbOverlap, type Obb } from '../core/math.js';
import { issue, type SimIssue } from '../errors.js';
import { localFromScene } from '../frames.js';
import { ENDPOINT_TOL_M, type LaneGraph } from '../map/lane-graph.js';
import { buildRoute, type Route } from '../map/route.js';
import { transitionDuration } from '../sim/dynamics.js';
import { isRoadActorKind, type SimActor, type SimScenarioInput } from '../schema/input.js';
import { actionAwareRunwayNeedM } from './nominal.js';

/** Comfort and hard deceleration budgets, m/s² (research doc §longitudinal). */
export const COMFORT_DECEL_MPS2 = 5.5;
export const HARD_DECEL_MPS2 = 8.0;

interface ResolvedActor {
  readonly spec: SimActor;
  readonly route: Route;
  readonly startS: number;
}

function resolveActor(
  graph: LaneGraph,
  spec: SimActor,
  issues: SimIssue[],
): ResolvedActor | null {
  const built = buildRoute(graph, spec.behavior.route);
  if (!built.ok) {
    issues.push(
      issue(built.error.code, `actors.${spec.id}.behavior.route`, built.error.reason, built.error.detail),
    );
    return null;
  }
  const route = built.route;
  let startS: number;
  const laneRef = spec.initial.laneRef;
  if (laneRef) {
    const geom = graph.geometry(laneRef.rsl);
    if (!geom) {
      issues.push(
        issue('route_lane_missing', `actors.${spec.id}.initial.laneRef.rsl`, `lane ${laneRef.rsl} not in topology`),
      );
      return null;
    }
    if (laneRef.s > geom.lengthM + 1e-6) {
      issues.push(
        issue(
          'spawn_off_lane',
          `actors.${spec.id}.initial.laneRef.s`,
          `spawn s=${laneRef.s.toFixed(2)} m exceeds lane ${laneRef.rsl} length ${geom.lengthM.toFixed(2)} m`,
          { s: laneRef.s, laneLengthM: geom.lengthM },
        ),
      );
      return null;
    }
    const s = route.sOfLaneStorage(laneRef.rsl, laneRef.s);
    if (s === null) {
      issues.push(
        issue(
          'spawn_lane_not_on_route',
          `actors.${spec.id}.initial.laneRef.rsl`,
          `spawn lane ${laneRef.rsl} is not on the actor's route`,
          { rsl: laneRef.rsl },
        ),
      );
      startS = route.projectPoint(localFromScene(spec.initial.pose)).s;
    } else {
      startS = s;
    }
  } else {
    startS = route.projectPoint(localFromScene(spec.initial.pose)).s;
  }
  return { spec, route, startS };
}

function checkConnectivity(graph: LaneGraph, r: ResolvedActor, issues: SimIssue[]): void {
  for (let i = 1; i < r.route.legs.length; i++) {
    const prev = r.route.legs[i - 1]!;
    const cur = r.route.legs[i]!;
    const exit = graph.endpoints(prev).exit;
    const entry = graph.endpoints(cur).entry;
    const gap = Math.hypot(exit.x - entry.x, exit.y - entry.y);
    if (gap > ENDPOINT_TOL_M) {
      issues.push(
        issue(
          'route_disconnected',
          `actors.${r.spec.id}.behavior.route`,
          `lanes ${prev.rsl} → ${cur.rsl} are ${gap.toFixed(2)} m apart (limit ${ENDPOINT_TOL_M} m)`,
          { from: prev.rsl, to: cur.rsl, gapM: gap },
        ),
      );
    }
  }
}

function checkRunway(
  graph: LaneGraph,
  input: SimScenarioInput,
  r: ResolvedActor,
  issues: SimIssue[],
): void {
  // Pedestrians and freeform paths legitimately end mid-clip (a crossing is
  // *supposed* to finish), so the whole-clip runway rule applies to vehicles on
  // lane routes only.
  if (r.spec.static || !isRoadActorKind(r.spec.kind) || r.route.isFreeform) return;
  // An actor the scenario explicitly despawns is allowed to run out of route.
  const despawned = input.interactions.some(
    (it) => it.actorId === r.spec.id && it.verb === 'exist' && it.target.state === 'absent',
  );
  if (despawned) return;

  const need = actionAwareRunwayNeedM(
    graph,
    {
      kind: r.spec.kind,
      route: r.route,
      startS: r.startS,
      initialSpeedMps: r.spec.initial.speedMps,
      speedFactor: r.spec.behavior.rules.speedFactor,
      cruiseOverrideMps: r.spec.behavior.cruiseSpeedMps ?? null,
    },
    r.spec.id,
    input.interactions,
    { dt: input.dt, warmupSeconds: input.warmupSeconds, clipSeconds: input.clipSeconds },
  );
  const available = r.route.lengthM - r.startS;
  if (available < need) {
    issues.push(
      issue(
        'runway_insufficient',
        `actors.${r.spec.id}.behavior.route`,
        `route provides ${available.toFixed(1)} m ahead of the spawn but the actor covers ${need.toFixed(1)} m in ${input.clipSeconds} s`,
        { availableM: available, neededM: need, clipSeconds: input.clipSeconds },
        'warning',
      ),
    );
  }
}

function checkDecelBudget(input: SimScenarioInput, issues: SimIssue[]): void {
  for (const it of input.interactions) {
    if (it.verb !== 'speed') continue;
    const actor = input.actors.find((a) => a.id === it.actorId);
    if (!actor) continue;
    const v0 = actor.initial.speedMps;
    let vTarget: number;
    switch (it.target.mode) {
      case 'absolute':
        vTarget = it.target.value;
        break;
      case 'delta':
        vTarget = Math.max(0, v0 + it.target.value);
        break;
      case 'factor':
        vTarget = v0 * it.target.value;
        break;
      case 'stop':
        vTarget = 0;
        break;
      default:
        continue; // `match` depends on a runtime speed; the run reports it.
    }
    const dv = vTarget - v0;
    if (dv >= 0) continue;
    const duration = transitionDuration(it.dynamics, dv, Math.max(v0, 0.1));
    const implied = Math.abs(dv) / Math.max(duration, 1e-6);
    if (implied > HARD_DECEL_MPS2) {
      issues.push(
        issue(
          'decel_budget_exceeded',
          `interactions.${it.id}.dynamics`,
          `implies ${implied.toFixed(2)} m/s² of braking, above the ${HARD_DECEL_MPS2} m/s² hard limit`,
          { impliedDecel: implied, budget: HARD_DECEL_MPS2 },
          'warning',
        ),
      );
    } else if (implied > COMFORT_DECEL_MPS2) {
      issues.push(
        issue(
          'decel_budget_exceeded',
          `interactions.${it.id}.dynamics`,
          `implies ${implied.toFixed(2)} m/s² of braking, above the ${COMFORT_DECEL_MPS2} m/s² comfort limit`,
          { impliedDecel: implied, budget: COMFORT_DECEL_MPS2 },
          'warning',
        ),
      );
    }
  }
}

function spawnObb(r: ResolvedActor): Obb {
  const pose = r.route.poseAt(r.startS);
  const lateral = r.spec.initial.laneRef
    ? r.spec.initial.laneRef.tFrac * r.route.widthAt(r.startS)
    : r.route.lateralOffsetAt(r.startS, localFromScene(r.spec.initial.pose));
  return {
    center: r.route.pointWithOffset(r.startS, lateral),
    lengthM: r.spec.dims.l,
    widthM: r.spec.dims.w,
    headingRad: pose.headingRad,
  };
}

function checkSpawnOverlap(resolved: readonly ResolvedActor[], issues: SimIssue[]): void {
  const present = resolved.filter((r) => r.spec.presentAtStart);
  const boxes = present.map(spawnObb);
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      if (!obbOverlap(boxes[i]!, boxes[j]!)) continue;
      const a = present[i]!.spec.id;
      const b = present[j]!.spec.id;
      issues.push(
        issue('spawn_overlap', `actors.${a}.initial`, `spawn footprint overlaps ${b}`, { a, b }),
      );
    }
  }
}

/**
 * Run every guard. Returns issues sorted by `(path, code)` so the list itself
 * is deterministic.
 */
export function checkFeasibility(input: SimScenarioInput, graph: LaneGraph): SimIssue[] {
  const issues: SimIssue[] = [];
  const resolved: ResolvedActor[] = [];
  for (const spec of [...input.actors].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const r = resolveActor(graph, spec, issues);
    if (r) resolved.push(r);
  }
  for (const r of resolved) {
    checkConnectivity(graph, r, issues);
    checkRunway(graph, input, r, issues);
  }
  checkDecelBudget(input, issues);
  checkSpawnOverlap(resolved, issues);
  return issues.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}
