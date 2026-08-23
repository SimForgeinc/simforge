/**
 * Pairwise kinematic readouts — the numbers both the trigger conditions and the
 * episode metrics are built from, computed once per tick per pair.
 *
 * ## The simplifications, stated plainly
 *
 * - **Clearance** uses each actor's circumscribed radius (`hypot(l,w)/2`), not
 *   the OBB. That makes `minDistance` and `ttc` slightly conservative for
 *   non-square footprints. Collision detection uses the real OBBs, so a
 *   "distance 0" reading never disagrees with a collision flag by more than the
 *   corner slack.
 * - **TTC** is the exact constant-velocity time at which the actors'
 *   circumscribed circles first touch. Unlike `gap / closingSpeed`, it rejects
 *   near misses and remains meaningful for crossing trajectories.
 * - **Path conflict** samples the actors' actual future routes and intersects
 *   the resulting segments. It reports path-TTC when their conflict-zone
 *   occupancy windows overlap, and predicted PET when they do not. This makes
 *   crossing criticality depend on the authored mechanism rather than on the
 *   instantaneous line of centres.
 * - **Along-lane distance** is measured on the *first* actor's route. When the
 *   other actor is not on that route the reading is `null` and callers fall
 *   back to euclidean.
 */

import { actorRadius, type ActorRuntime } from './state.js';
import {
  angleDelta,
  dist,
  lerp,
  lerpAngle,
  obbCorners,
  obbOverlap,
  segmentIntersection,
  type Obb,
  type Vec2,
} from '../core/math.js';
import { transitionValue } from './dynamics.js';

const VELOCITY_EPSILON_MPS = 1e-6;
// Five metres matches the controller's conflict scan and preserves the exact
// intersections of each sampled chord while keeping per-tick pair work small.
const PATH_SAMPLE_STEP_M = 5;
const PATH_HORIZON_S = 12;
const TTC_HORIZON_S = 30;
const PATH_MIN_CROSSING_ANGLE_RAD = 0.15;
const SWEEP_CONTACT_EPSILON_M = 1e-9;
const SWEEP_MAX_ITERATIONS = 256;

export interface PairReadout {
  /** Surface-to-surface separation in metres (never negative). */
  readonly gapM: number;
  /** Centre-to-centre distance. */
  readonly centerDistM: number;
  /** Closing speed along the line of centres, m/s (negative = separating). */
  readonly closingMps: number;
  /** Constant-velocity seconds to circle contact, `Infinity` on a miss. */
  readonly ttcS: number;
}

export interface PathConflictReadout {
  /** Time until both footprints occupy the route conflict zone. */
  readonly pathTtcS: number;
  /** Predicted post-encroachment time; zero means occupancy overlaps. */
  readonly petS: number;
  /** Route intersection in xodr-local metres. */
  readonly conflictPoint: Vec2;
  /** Centre arrival times at the route intersection. */
  readonly arrivalAS: number;
  readonly arrivalBS: number;
}

export interface SweptObbResult {
  /** First contact as a fraction of the supplied motion interval. */
  readonly toi: number;
}

export type DoorName = 'left' | 'right' | 'rear';

export const DOOR_OPEN_DURATION_S = 1;
export const DOOR_MAX_OPEN_ANGLE_RAD = Math.PI * 0.39;

/**
 * Whether the actor is currently in reverse gear.
 *
 * This reads the *runtime* gear, not the spawn tag: `set motion.gear` may shift
 * an actor mid-clip, which is what makes a three-point turn or a
 * back-out-then-drive-away expressible on the timeline at all. The
 * `motion:reverse` tag survives only as the spawn-time initialiser — see
 * `initialMotionDirection`.
 */
export function isReverseMotion(a: Pick<ActorRuntime, 'motionDirection'>): boolean {
  return a.motionDirection === -1;
}

export function velocityOf(a: ActorRuntime): Vec2 {
  const direction = isReverseMotion(a) ? -1 : 1;
  return {
    x: Math.cos(a.headingRad) * a.speedMps * direction,
    y: Math.sin(a.headingRad) * a.speedMps * direction,
  };
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function readPair(a: ActorRuntime, b: ActorRuntime): PairReadout {
  const centerDist = dist(a.position, b.position);
  const clearance = actorRadius(a) + actorRadius(b);
  const gap = Math.max(0, centerDist - clearance);
  if (centerDist < 1e-9) {
    return { gapM: 0, centerDistM: 0, closingMps: 0, ttcS: 0 };
  }
  const ux = (b.position.x - a.position.x) / centerDist;
  const uy = (b.position.y - a.position.y) / centerDist;
  const va = velocityOf(a);
  const vb = velocityOf(b);
  const closing = (va.x - vb.x) * ux + (va.y - vb.y) * uy;
  // Circumscribed circles are a cheap conservative broad phase: an OBB hit is
  // impossible when the circles never meet. A circle hit still requires the
  // exact swept-footprint test below.
  const rvx = vb.x - va.x;
  const rvy = vb.y - va.y;
  const px = b.position.x - a.position.x;
  const py = b.position.y - a.position.y;
  const qa = rvx * rvx + rvy * rvy;
  const qb = 2 * (px * rvx + py * rvy);
  const qc = px * px + py * py - clearance * clearance;
  let circleCanHit = qc <= 0;
  if (!circleCanHit && qa > VELOCITY_EPSILON_MPS * VELOCITY_EPSILON_MPS) {
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant >= 0) {
      const first = (-qb - Math.sqrt(discriminant)) / (2 * qa);
      circleCanHit = first >= 0 && first <= TTC_HORIZON_S;
    }
  }
  if (!circleCanHit) {
    return { gapM: gap, centerDistM: centerDist, closingMps: closing, ttcS: Infinity };
  }
  // TTC must agree with the physical footprints. Circumscribed-circle TTC
  // turns legal opposing traffic in adjacent lanes into an immediate contact
  // whenever the two circles' corner radii overlap laterally. Sweep the actual
  // OBBs under constant velocity instead; route-aware turning conflicts remain
  // the responsibility of readPathConflict().
  const a0: Obb = {
    center: a.position,
    lengthM: a.dims.l,
    widthM: a.dims.w,
    headingRad: a.headingRad,
  };
  const b0: Obb = {
    center: b.position,
    lengthM: b.dims.l,
    widthM: b.dims.w,
    headingRad: b.headingRad,
  };
  const hit = sweptObbTimeOfImpact(
    a0,
    { ...a0, center: { x: a.position.x + va.x * TTC_HORIZON_S, y: a.position.y + va.y * TTC_HORIZON_S } },
    b0,
    { ...b0, center: { x: b.position.x + vb.x * TTC_HORIZON_S, y: b.position.y + vb.y * TTC_HORIZON_S } },
  );
  const ttc = hit === null ? Infinity : hit.toi * TTC_HORIZON_S;
  return { gapM: gap, centerDistM: centerDist, closingMps: closing, ttcS: ttc };
}

interface PathSample {
  readonly point: Vec2;
  readonly distanceM: number;
}

function pathBounds(path: readonly PathSample[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of path) {
    minX = Math.min(minX, sample.point.x);
    minY = Math.min(minY, sample.point.y);
    maxX = Math.max(maxX, sample.point.x);
    maxY = Math.max(maxY, sample.point.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Predict the lateral coordinate at a future point on an actor's current
 * route.  Pair metrics used to hold `lateralOffsetM` constant, which made an
 * actor that was already executing an authored lane change appear to continue
 * straight into a channelizer.  Anchor the command profile at the measured
 * current offset (rather than recomputing the past) and advance the same
 * shape/duration the lateral controller owns.  This retains any tiny
 * controller-rate lag at the current tick while making the prediction follow
 * the active command's target and time profile deterministically.
 */
function predictedLateralOffset(a: ActorRuntime, nowS: number, futureS: number): number {
  const cmd = a.latCmd;
  if (!cmd || cmd.done) return a.lateralOffsetM;
  const elapsedNow = Math.max(0, nowS - cmd.firedAt);
  const atNow = transitionValue(cmd.dynamics, cmd.from, cmd.to, elapsedNow, cmd.duration);
  const atFuture = transitionValue(
    cmd.dynamics,
    cmd.from,
    cmd.to,
    elapsedNow + Math.max(0, futureS),
    cmd.duration,
  );
  const predicted = a.lateralOffsetM + (atFuture - atNow);
  // A profile cannot carry the actor beyond its authored target, even when a
  // physical rate limit left its current offset a fraction behind the ideal
  // profile at the observation tick.
  return cmd.to >= cmd.from
    ? Math.min(predicted, cmd.to)
    : Math.max(predicted, cmd.to);
}

function futurePath(a: ActorRuntime, horizonS: number, nowS = 0): PathSample[] {
  const maxDistance = Math.min(a.route.lengthM - a.routeS, a.speedMps * horizonS);
  if (maxDistance <= 0) return [{ point: a.position, distanceM: 0 }];
  const samples: PathSample[] = [{ point: a.position, distanceM: 0 }];
  for (let d = PATH_SAMPLE_STEP_M; d < maxDistance; d += PATH_SAMPLE_STEP_M) {
    samples.push({
      point: a.route.pointWithOffset(
        a.routeS + d,
        predictedLateralOffset(a, nowS, d / Math.max(a.speedMps, VELOCITY_EPSILON_MPS)),
      ),
      distanceM: d,
    });
  }
  samples.push({
    point: a.route.pointWithOffset(
      a.routeS + maxDistance,
      predictedLateralOffset(a, nowS, maxDistance / Math.max(a.speedMps, VELOCITY_EPSILON_MPS)),
    ),
    distanceM: maxDistance,
  });
  return samples;
}

/**
 * Predict the nearest crossing of the actors' sampled future routes.
 *
 * Each footprint occupies the intersection during
 * `arrival +/- circumscribedRadius/speed`. Overlapping windows produce a
 * finite path-TTC; disjoint windows produce a positive predicted PET. Parallel
 * following paths deliberately return `null` because `readPair().ttcS` owns
 * rear-end and head-on conflicts.
 */
export function readPathConflict(
  a: ActorRuntime,
  b: ActorRuntime,
  horizonS = PATH_HORIZON_S,
  nowS = 0,
): PathConflictReadout | null {
  if (a.speedMps <= VELOCITY_EPSILON_MPS || b.speedMps <= VELOCITY_EPSILON_MPS) return null;
  const aa = futurePath(a, horizonS, nowS);
  const bb = futurePath(b, horizonS, nowS);
  const ab = pathBounds(aa);
  const boundsB = pathBounds(bb);
  if (
    ab.maxX < boundsB.minX ||
    boundsB.maxX < ab.minX ||
    ab.maxY < boundsB.minY ||
    boundsB.maxY < ab.minY
  ) {
    return null;
  }
  let best: PathConflictReadout | null = null;

  for (let i = 0; i + 1 < aa.length; i++) {
    const a0 = aa[i]!;
    const a1 = aa[i + 1]!;
    const adx = a1.point.x - a0.point.x;
    const ady = a1.point.y - a0.point.y;
    const ah = Math.atan2(ady, adx);
    for (let j = 0; j + 1 < bb.length; j++) {
      const b0 = bb[j]!;
      const b1 = bb[j + 1]!;
      const bdx = b1.point.x - b0.point.x;
      const bdy = b1.point.y - b0.point.y;
      if (
        Math.max(a0.point.x, a1.point.x) < Math.min(b0.point.x, b1.point.x) ||
        Math.max(b0.point.x, b1.point.x) < Math.min(a0.point.x, a1.point.x) ||
        Math.max(a0.point.y, a1.point.y) < Math.min(b0.point.y, b1.point.y) ||
        Math.max(b0.point.y, b1.point.y) < Math.min(a0.point.y, a1.point.y)
      ) {
        continue;
      }
      const bh = Math.atan2(bdy, bdx);
      const crossingAngle = Math.abs(angleDelta(ah, bh));
      if (
        crossingAngle < PATH_MIN_CROSSING_ANGLE_RAD ||
        Math.abs(Math.PI - crossingAngle) < PATH_MIN_CROSSING_ANGLE_RAD
      ) {
        continue;
      }
      const ta = segmentIntersection(a0.point, a1.point, b0.point, b1.point);
      if (ta === null) continue;
      const tb = segmentIntersection(b0.point, b1.point, a0.point, a1.point);
      if (tb === null) continue;

      const distanceA = lerp(a0.distanceM, a1.distanceM, ta);
      const distanceB = lerp(b0.distanceM, b1.distanceM, tb);
      const arrivalA = distanceA / a.speedMps;
      const arrivalB = distanceB / b.speedMps;
      if (arrivalA > horizonS || arrivalB > horizonS) continue;

      const occupancyA = actorRadius(a) / a.speedMps;
      const occupancyB = actorRadius(b) / b.speedMps;
      const entryA = Math.max(0, arrivalA - occupancyA);
      const exitA = arrivalA + occupancyA;
      const entryB = Math.max(0, arrivalB - occupancyB);
      const exitB = arrivalB + occupancyB;
      const overlap = Math.min(exitA, exitB) >= Math.max(entryA, entryB);
      const pathTtcS = overlap ? Math.max(entryA, entryB) : Infinity;
      const petS = overlap
        ? 0
        : entryA > exitB
          ? entryA - exitB
          : entryB - exitA;
      const candidate: PathConflictReadout = {
        pathTtcS,
        petS,
        conflictPoint: {
          x: lerp(a0.point.x, a1.point.x, ta),
          y: lerp(a0.point.y, a1.point.y, ta),
        },
        arrivalAS: arrivalA,
        arrivalBS: arrivalB,
      };
      const candidateCriticality = Math.max(arrivalA, arrivalB);
      const bestCriticality = best ? Math.max(best.arrivalAS, best.arrivalBS) : Infinity;
      if (candidateCriticality < bestCriticality) best = candidate;
    }
  }
  return best;
}

/** Ground-plane OBB for a vehicle door at a normalized opening fraction. */
export function articulatedDoorObb(a: ActorRuntime, name: DoorName, openness: number): Obb {
  const open = Math.max(0, Math.min(1, openness));
  const forward = { x: Math.cos(a.headingRad), y: Math.sin(a.headingRad) };
  const left = { x: -forward.y, y: forward.x };
  if (name === 'rear') {
    const panelWidth = a.dims.w * 0.82;
    const extension = Math.max(0.025, a.dims.h * 0.62 * Math.sin(open * DOOR_MAX_OPEN_ANGLE_RAD));
    return {
      center: {
        x: a.position.x - forward.x * (a.dims.l / 2 + extension / 2),
        y: a.position.y - forward.y * (a.dims.l / 2 + extension / 2),
      },
      lengthM: panelWidth,
      widthM: extension,
      headingRad: a.headingRad + Math.PI / 2,
    };
  }
  const side = name === 'left' ? 1 : -1;
  if (a.kind === 'bus') {
    // Transit entrance doors fold/slide in the body envelope; modelling them
    // as a passenger-car leaf invents an outward sweep into the alighting
    // path. Keep a thin, longitudinal panel flush with the bus side and slide
    // it rearward as it opens. This remains collidable without fabricating a
    // generic hinged-car-door hazard.
    const length = Math.min(1.35, a.dims.l * 0.14);
    const thickness = Math.max(0.025, a.dims.w * 0.012);
    const longitudinal = a.dims.l * 0.3 - open * length * 0.8;
    return {
      center: {
        x: a.position.x + forward.x * longitudinal + left.x * side * (a.dims.w / 2 + thickness / 2),
        y: a.position.y + forward.y * longitudinal + left.y * side * (a.dims.w / 2 + thickness / 2),
      },
      lengthM: length,
      widthM: thickness,
      headingRad: a.headingRad,
    };
  }
  const length = a.dims.l * 0.34;
  const thickness = Math.max(0.025, a.dims.w * 0.018);
  const doorHeading = a.headingRad - side * open * DOOR_MAX_OPEN_ANGLE_RAD;
  const doorForward = { x: Math.cos(doorHeading), y: Math.sin(doorHeading) };
  const hinge = {
    x: a.position.x + forward.x * (a.dims.l * 0.16) + left.x * (side * (a.dims.w / 2 + thickness / 2)),
    y: a.position.y + forward.y * (a.dims.l * 0.16) + left.y * (side * (a.dims.w / 2 + thickness / 2)),
  };
  return {
    center: { x: hinge.x - doorForward.x * (length / 2), y: hinge.y - doorForward.y * (length / 2) },
    lengthM: length,
    widthM: thickness,
    headingRad: doorHeading,
  };
}

/** Route-aware OBB TTC from one moving actor to one static collidable. */
export function readStaticPathConflict(
  moving: ActorRuntime,
  fixed: ActorRuntime,
  horizonS = PATH_HORIZON_S,
  nowS = 0,
): { pathTtcS: number; conflictPoint: Vec2 } | null {
  return readStaticObbPathConflict(moving, {
    center: fixed.position,
    lengthM: fixed.dims.l,
    widthM: fixed.dims.w,
    headingRad: fixed.headingRad,
  }, horizonS, nowS);
}

/** Route-aware OBB TTC from one moving actor to a fixed collision shape. */
export function readStaticObbPathConflict(
  moving: ActorRuntime,
  fixedObb: Obb,
  horizonS = PATH_HORIZON_S,
  nowS = 0,
): { pathTtcS: number; conflictPoint: Vec2 } | null {
  if (moving.speedMps <= VELOCITY_EPSILON_MPS) return null;
  const path = futurePath(moving, horizonS, nowS);
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const fromPose = moving.route.poseAt(moving.routeS + from.distanceM);
    const toPose = moving.route.poseAt(moving.routeS + to.distanceM);
    const movingFrom: Obb = {
      center: from.point,
      lengthM: moving.dims.l,
      widthM: moving.dims.w,
      headingRad: fromPose.headingRad,
    };
    const movingTo: Obb = {
      center: to.point,
      lengthM: moving.dims.l,
      widthM: moving.dims.w,
      headingRad: toPose.headingRad,
    };
    const hit = sweptObbTimeOfImpact(movingFrom, movingTo, fixedObb, fixedObb);
    if (!hit) continue;
    const distanceM = lerp(from.distanceM, to.distanceM, hit.toi);
    return {
      pathTtcS: distanceM / moving.speedMps,
      conflictPoint: {
        x: lerp(from.point.x, to.point.x, hit.toi),
        y: lerp(from.point.y, to.point.y, hit.toi),
      },
    };
  }
  return null;
}

function projectionRadius(obb: Obb, ax: number, ay: number): number {
  const c = Math.cos(obb.headingRad);
  const s = Math.sin(obb.headingRad);
  return (
    Math.abs(c * ax + s * ay) * (obb.lengthM / 2) +
    Math.abs(-s * ax + c * ay) * (obb.widthM / 2)
  );
}

function fixedOrientationSweep(a0: Obb, a1: Obb, b0: Obb, b1: Obb): SweptObbResult | null {
  let enter = 0;
  let leave = 1;
  const axes: Array<[number, number]> = [
    [Math.cos(a0.headingRad), Math.sin(a0.headingRad)],
    [-Math.sin(a0.headingRad), Math.cos(a0.headingRad)],
    [Math.cos(b0.headingRad), Math.sin(b0.headingRad)],
    [-Math.sin(b0.headingRad), Math.cos(b0.headingRad)],
  ];
  const rel0 = { x: b0.center.x - a0.center.x, y: b0.center.y - a0.center.y };
  const relDelta = {
    x: (b1.center.x - b0.center.x) - (a1.center.x - a0.center.x),
    y: (b1.center.y - b0.center.y) - (a1.center.y - a0.center.y),
  };
  for (const [ax, ay] of axes) {
    const radius = projectionRadius(a0, ax, ay) + projectionRadius(b0, ax, ay);
    const p = rel0.x * ax + rel0.y * ay;
    const v = relDelta.x * ax + relDelta.y * ay;
    if (Math.abs(v) < 1e-15) {
      if (Math.abs(p) > radius) return null;
      continue;
    }
    const t0 = (-radius - p) / v;
    const t1 = (radius - p) / v;
    const axisEnter = Math.min(t0, t1);
    const axisLeave = Math.max(t0, t1);
    enter = Math.max(enter, axisEnter);
    leave = Math.min(leave, axisLeave);
    if (enter > leave) return null;
  }
  return enter <= 1 && leave >= 0 ? { toi: Math.max(0, enter) } : null;
}

function obbAt(from: Obb, to: Obb, t: number): Obb {
  return {
    center: { x: lerp(from.center.x, to.center.x, t), y: lerp(from.center.y, to.center.y, t) },
    lengthM: lerp(from.lengthM, to.lengthM, t),
    widthM: lerp(from.widthM, to.widthM, t),
    headingRad: lerpAngle(from.headingRad, to.headingRad, t),
  };
}

/** Maximum separating-axis gap. Non-positive means the OBBs overlap. */
function obbSeparation(a: Obb, b: Obb): number {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes: Array<[number, number]> = [
    [Math.cos(a.headingRad), Math.sin(a.headingRad)],
    [-Math.sin(a.headingRad), Math.cos(a.headingRad)],
    [Math.cos(b.headingRad), Math.sin(b.headingRad)],
    [-Math.sin(b.headingRad), Math.cos(b.headingRad)],
  ];
  let separation = -Infinity;
  for (const [ax, ay] of axes) {
    let alo = Infinity;
    let ahi = -Infinity;
    let blo = Infinity;
    let bhi = -Infinity;
    for (const p of ca) {
      const v = p.x * ax + p.y * ay;
      alo = Math.min(alo, v);
      ahi = Math.max(ahi, v);
    }
    for (const p of cb) {
      const v = p.x * ax + p.y * ay;
      blo = Math.min(blo, v);
      bhi = Math.max(bhi, v);
    }
    separation = Math.max(separation, Math.max(blo - ahi, alo - bhi));
  }
  return separation;
}

/**
 * Continuous OBB collision over one integration interval.
 *
 * Translation with fixed headings uses an exact swept SAT. Rotating boxes use
 * deterministic conservative advancement with a bound on corner velocity, so
 * an overlap cannot be stepped over. The returned value is stable for the same
 * IEEE-754 inputs and does not depend on wall-clock iteration budgets.
 */
export function sweptObbTimeOfImpact(
  a0: Obb,
  a1: Obb,
  b0: Obb,
  b1: Obb,
): SweptObbResult | null {
  if (obbOverlap(a0, b0)) return { toi: 0 };
  const da = angleDelta(a0.headingRad, a1.headingRad);
  const db = angleDelta(b0.headingRad, b1.headingRad);
  const dimensionsStable =
    Math.abs(a1.lengthM - a0.lengthM) < 1e-12 &&
    Math.abs(a1.widthM - a0.widthM) < 1e-12 &&
    Math.abs(b1.lengthM - b0.lengthM) < 1e-12 &&
    Math.abs(b1.widthM - b0.widthM) < 1e-12;
  if (Math.abs(da) < 1e-12 && Math.abs(db) < 1e-12 && dimensionsStable) {
    return fixedOrientationSweep(a0, a1, b0, b1);
  }

  const relativeTravel = Math.hypot(
    (b1.center.x - b0.center.x) - (a1.center.x - a0.center.x),
    (b1.center.y - b0.center.y) - (a1.center.y - a0.center.y),
  );
  const speedBound =
    relativeTravel +
    Math.abs(da) * Math.hypot(a0.lengthM, a0.widthM) / 2 +
    Math.abs(db) * Math.hypot(b0.lengthM, b0.widthM) / 2 +
    Math.hypot(a1.lengthM - a0.lengthM, a1.widthM - a0.widthM) / 2 +
    Math.hypot(b1.lengthM - b0.lengthM, b1.widthM - b0.widthM) / 2;
  if (speedBound <= 0) return null;

  let t = 0;
  for (let iteration = 0; iteration < SWEEP_MAX_ITERATIONS && t <= 1; iteration++) {
    const a = obbAt(a0, a1, t);
    const b = obbAt(b0, b1, t);
    const separation = obbSeparation(a, b);
    if (separation <= SWEEP_CONTACT_EPSILON_M || obbOverlap(a, b)) return { toi: t };
    const step = separation / speedBound;
    if (step <= 1e-14) return { toi: t };
    t += step;
  }
  if (t <= 1 && obbOverlap(obbAt(a0, a1, t), obbAt(b0, b1, t))) return { toi: t };
  return null;
}

/**
 * Signed along-route distance from `observer` to `other`, measured on the
 * observer's route. Positive = ahead. `null` when `other` is not on the route.
 */
export function alongRouteDistance(observer: ActorRuntime, other: ActorRuntime): number | null {
  if (observer.route.isFreeform) return null;
  const otherPose = other.route.poseAt(other.routeS);
  if (otherPose.rsl === null) return null;
  const s = observer.route.sOfLaneStorage(otherPose.rsl, otherPose.storageS);
  if (s === null) return null;
  return s - observer.routeS;
}

/** Bumper-to-bumper along-route gap, or `null`. */
export function alongRouteGapM(observer: ActorRuntime, other: ActorRuntime): number | null {
  const d = alongRouteDistance(observer, other);
  if (d === null) return null;
  const halves = observer.dims.l / 2 + other.dims.l / 2;
  return d - Math.sign(d || 1) * halves;
}

/** Time headway `gap / v` from `observer` to `other`, or `null`. */
export function headwayS(observer: ActorRuntime, other: ActorRuntime): number | null {
  const gap = alongRouteGapM(observer, other);
  if (gap === null) return null;
  if (observer.speedMps < 1e-3) return gap <= 0 ? 0 : Infinity;
  return gap / observer.speedMps;
}

/**
 * Lateral separation between two actors measured on the observer's route —
 * used to decide "is this actor in my lane?" without a lane-identity join.
 */
export function lateralSeparationM(observer: ActorRuntime, other: ActorRuntime): number | null {
  const d = alongRouteDistance(observer, other);
  if (d === null) return null;
  const s = observer.routeS + d;
  return observer.route.lateralOffsetAt(s, other.position) - observer.lateralOffsetM;
}
