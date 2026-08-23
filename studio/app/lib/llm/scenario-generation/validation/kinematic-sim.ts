/**
 * Deterministic fixed-Δt kinematic collision simulator (engine
 * `kinematic-v1`).
 *
 * Pure math, zero deps, no I/O — replays the *planned* trajectories of a
 * generated collision-scenario draft so we can assert the requested conflict
 * actually happens before the draft is ever returned to the agent or user.
 *
 * This validates the plan (planned polylines + per-actor speed / timing),
 * NOT CARLA dynamics. Modelling choices that matter:
 *
 *  - A `path` actor advances along its polyline by arc length `speed · t`.
 *    After the polyline ends it KEEPS MOVING at constant speed along the
 *    final tangent (bounded by `PATH_EXTRAPOLATION_S`). This is the single
 *    most important choice: it exposes the dominant real failure mode —
 *    one actor reaching the shared conflict point seconds before the other
 *    (e.g. a backward-walk that dead-ended into a short path) — instead of
 *    parking on the conflict point and trivially guaranteeing an overlap.
 *  - A `timed_path` actor (walkers) interpolates position linearly in time
 *    between its timed waypoints, clamping to the first/last point outside
 *    the time range — a pedestrian holds, crosses, then stays on the far
 *    curb. No extrapolation.
 *  - Bodies are oriented bounding boxes; contact is exact OBB overlap (SAT).
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface OrientedBox {
  center: Vec2;
  /** Heading in radians; +x axis is heading 0, CCW positive. */
  heading: number;
  halfLength: number;
  halfWidth: number;
}

export type KinematicMotion =
  | {
      kind: "path";
      /** World polyline in runtime meters; index 0 is the spawn point. */
      polyline: readonly Vec2[];
      speedMps: number;
      /** Seconds the actor waits at the spawn before moving. */
      startDelayS?: number;
    }
  | {
      kind: "timed_path";
      waypoints: readonly { x: number; y: number; time: number }[];
    }
  | { kind: "static"; point: Vec2; heading: number };

export interface KinematicActor {
  id: string;
  label: string;
  role: string;
  size: { lengthM: number; widthM: number };
  motion: KinematicMotion;
}

export interface KinematicSimOptions {
  durationS: number;
  fixedDeltaS: number;
  /**
   * Pairs of actor ids whose contact we care about. Each becomes one entry
   * in `contacts` (first contact only) and `minGapByPair`.
   */
  monitoredPairs: ReadonlyArray<readonly [string, string]>;
}

export interface ActorSample {
  box: OrientedBox;
  velocity: Vec2;
  /** Arc length travelled along the path so far (path motion only). */
  pathProgressM: number;
  /** True once the actor has run past the end of its defined path. */
  pastPathEnd: boolean;
}

export interface PairContact {
  timeS: number;
  point: Vec2;
  actorAId: string;
  actorBId: string;
  /** Rate the gap was closing at contact, m/s (>= 0). */
  closingSpeedMps: number;
}

export interface PairMinGap {
  gapM: number;
  timeS: number;
}

export interface KinematicSimResult {
  /** First contact for each monitored pair that collided. */
  contacts: PairContact[];
  /** Closest the boxes ever got, per monitored pair (0 when they touched). */
  minGapByPair: Map<string, PairMinGap>;
  /** Resolved path arc length per actor (0 for static / timed_path). */
  pathArcLengthByActor: Map<string, number>;
  /** Per-step actor poses used by downstream kinematic plausibility linting. */
  previewFrames: Array<{
    timestamp: number;
    actors: Array<{
      id: string;
      x: number;
      y: number;
      yaw: number;
      speed: number;
    }>;
  }>;
  finalTimeS: number;
}

/** How long a `path` actor keeps coasting past its last waypoint. */
const PATH_EXTRAPOLATION_S = 6;

const VELOCITY_EPS_S = 1e-3;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ── Polyline helpers ────────────────────────────────────────────────────────

interface ArcPolyline {
  points: readonly Vec2[];
  /** Cumulative arc length, parallel to `points`. */
  cum: readonly number[];
  totalM: number;
}

function buildArcPolyline(points: readonly Vec2[]): ArcPolyline {
  if (points.length === 0) {
    return { points: [{ x: 0, y: 0 }], cum: [0], totalM: 0 };
  }
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    cum.push(cum[i - 1]! + Math.hypot(dx, dy));
  }
  return { points, cum, totalM: cum[cum.length - 1]! };
}

/**
 * Pose at arc length `s` along the polyline. When `s` exceeds the polyline
 * length the pose is extrapolated along the final segment's tangent so the
 * caller can model an actor that keeps driving past its last waypoint.
 */
function poseAtArc(poly: ArcPolyline, s: number): { point: Vec2; heading: number } {
  const { points, cum, totalM } = poly;
  if (points.length === 1) {
    return { point: points[0]!, heading: 0 };
  }
  if (s <= 0) {
    const a = points[0]!;
    const b = points[1]!;
    return { point: a, heading: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  if (s >= totalM) {
    const a = points[points.length - 2]!;
    const b = points[points.length - 1]!;
    const heading = Math.atan2(b.y - a.y, b.x - a.x);
    const overshoot = s - totalM;
    return {
      point: {
        x: b.x + Math.cos(heading) * overshoot,
        y: b.y + Math.sin(heading) * overshoot,
      },
      heading,
    };
  }
  // Binary-search the cumulative arc array.
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const segLen = cum[hi]! - cum[lo]!;
  const t = segLen === 0 ? 0 : (s - cum[lo]!) / segLen;
  return {
    point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    heading: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function timedPathPose(
  waypoints: readonly { x: number; y: number; time: number }[],
  t: number,
): { point: Vec2; heading: number } {
  if (waypoints.length === 0) return { point: { x: 0, y: 0 }, heading: 0 };
  if (waypoints.length === 1) {
    return { point: { x: waypoints[0]!.x, y: waypoints[0]!.y }, heading: 0 };
  }
  const first = waypoints[0]!;
  const last = waypoints[waypoints.length - 1]!;
  const headingOf = (
    p: { x: number; y: number },
    q: { x: number; y: number },
  ): number => Math.atan2(q.y - p.y, q.x - p.x);
  // Heading for the segment ENDING at index i, skipping degenerate (hold)
  // segments: a stationary curb-hold (two colocated vertices) used to emit
  // atan2(0,0)=0 — the actor "faced east" while holding, then SNAPPED to the
  // walk direction at step-off. Any walk heading beyond ±90° read as a heading
  // DISCONTINUITY in the lint (Belmont rightped-1577: 126° in one tick). A
  // holding actor faces where it will move next (the worker's real walker does,
  // via its authored spawn yaw); fall back to the previous moving segment.
  const headingForSegment = (i: number): number => {
    for (let j = i; j < waypoints.length; j++) {
      const p = waypoints[j - 1]!;
      const q = waypoints[j]!;
      if (Math.hypot(q.x - p.x, q.y - p.y) > 1e-9) return headingOf(p, q);
    }
    for (let j = i - 1; j >= 1; j--) {
      const p = waypoints[j - 1]!;
      const q = waypoints[j]!;
      if (Math.hypot(q.x - p.x, q.y - p.y) > 1e-9) return headingOf(p, q);
    }
    return 0;
  };
  if (t <= first.time) {
    return { point: { x: first.x, y: first.y }, heading: headingForSegment(1) };
  }
  if (t >= last.time) {
    return {
      point: { x: last.x, y: last.y },
      heading: headingForSegment(waypoints.length - 1),
    };
  }
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    if (t <= b.time) {
      const span = b.time - a.time;
      const f = span <= 0 ? 0 : (t - a.time) / span;
      return {
        point: { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) },
        heading: headingForSegment(i),
      };
    }
  }
  return { point: { x: last.x, y: last.y }, heading: headingForSegment(waypoints.length - 1) };
}

// ── Per-actor sampling ──────────────────────────────────────────────────────

interface PreparedActor {
  actor: KinematicActor;
  arcPoly: ArcPolyline | null;
  totalArcM: number;
  /** Hard cap on arc length so extrapolation is bounded. */
  maxArcM: number;
}

function prepareActor(actor: KinematicActor): PreparedActor {
  if (actor.motion.kind === "path") {
    const arcPoly = buildArcPolyline(actor.motion.polyline);
    const coastM = actor.motion.speedMps * PATH_EXTRAPOLATION_S;
    return {
      actor,
      arcPoly,
      totalArcM: arcPoly.totalM,
      maxArcM: arcPoly.totalM + coastM,
    };
  }
  return { actor, arcPoly: null, totalArcM: 0, maxArcM: 0 };
}

function sampleActor(prepared: PreparedActor, t: number): ActorSample {
  const { actor } = prepared;
  const size = actor.size;
  const half = { l: size.lengthM / 2, w: size.widthM / 2 };

  const poseAt = (time: number): { point: Vec2; heading: number; progressM: number; past: boolean } => {
    if (actor.motion.kind === "static") {
      return { point: actor.motion.point, heading: actor.motion.heading, progressM: 0, past: false };
    }
    if (actor.motion.kind === "timed_path") {
      const p = timedPathPose(actor.motion.waypoints, time);
      return { point: p.point, heading: p.heading, progressM: 0, past: false };
    }
    const poly = prepared.arcPoly!;
    const delay = actor.motion.startDelayS ?? 0;
    const moving = Math.max(0, time - delay);
    const s = Math.min(prepared.maxArcM, actor.motion.speedMps * moving);
    const p = poseAtArc(poly, s);
    return { point: p.point, heading: p.heading, progressM: s, past: s >= prepared.totalArcM };
  };

  const here = poseAt(t);
  const ahead = poseAt(t + VELOCITY_EPS_S);
  const velocity: Vec2 = {
    x: (ahead.point.x - here.point.x) / VELOCITY_EPS_S,
    y: (ahead.point.y - here.point.y) / VELOCITY_EPS_S,
  };
  return {
    box: {
      center: here.point,
      heading: here.heading,
      halfLength: half.l,
      halfWidth: half.w,
    },
    velocity,
    pathProgressM: here.progressM,
    pastPathEnd: here.past,
  };
}

// ── Oriented-box geometry ───────────────────────────────────────────────────

function boxCorners(box: OrientedBox): [Vec2, Vec2, Vec2, Vec2] {
  const c = Math.cos(box.heading);
  const s = Math.sin(box.heading);
  const fx = c * box.halfLength;
  const fy = s * box.halfLength;
  const rx = -s * box.halfWidth;
  const ry = c * box.halfWidth;
  return [
    { x: box.center.x + fx + rx, y: box.center.y + fy + ry },
    { x: box.center.x + fx - rx, y: box.center.y + fy - ry },
    { x: box.center.x - fx - rx, y: box.center.y - fy - ry },
    { x: box.center.x - fx + rx, y: box.center.y - fy + ry },
  ];
}

function projectionRange(
  corners: readonly Vec2[],
  axis: Vec2,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of corners) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/** Separating Axis Theorem overlap test for two oriented boxes. */
export function boxesOverlap(a: OrientedBox, b: OrientedBox): boolean {
  const ca = boxCorners(a);
  const cb = boxCorners(b);
  const axes: Vec2[] = [
    { x: Math.cos(a.heading), y: Math.sin(a.heading) },
    { x: -Math.sin(a.heading), y: Math.cos(a.heading) },
    { x: Math.cos(b.heading), y: Math.sin(b.heading) },
    { x: -Math.sin(b.heading), y: Math.cos(b.heading) },
  ];
  for (const axis of axes) {
    const ra = projectionRange(ca, axis);
    const rb = projectionRange(cb, axis);
    if (ra.max < rb.min || rb.max < ra.min) return false;
  }
  return true;
}

function segDistSq(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number {
  const closestOnSeg = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return a;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * dx, y: a.y + t * dy };
  };
  const candidates: Array<[Vec2, Vec2]> = [
    [p1, closestOnSeg(p1, p3, p4)],
    [p2, closestOnSeg(p2, p3, p4)],
    [p3, closestOnSeg(p3, p1, p2)],
    [p4, closestOnSeg(p4, p1, p2)],
  ];
  let best = Infinity;
  for (const [u, v] of candidates) {
    const d = (u.x - v.x) ** 2 + (u.y - v.y) ** 2;
    if (d < best) best = d;
  }
  return best;
}

/** Euclidean gap between two oriented boxes; 0 when they overlap. */
export function boxGap(a: OrientedBox, b: OrientedBox): number {
  if (boxesOverlap(a, b)) return 0;
  const ca = boxCorners(a);
  const cb = boxCorners(b);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a1 = ca[i]!;
    const a2 = ca[(i + 1) % 4]!;
    for (let j = 0; j < 4; j++) {
      const b1 = cb[j]!;
      const b2 = cb[(j + 1) % 4]!;
      const d = segDistSq(a1, a2, b1, b2);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// ── Simulation loop ─────────────────────────────────────────────────────────

export function simulate(
  actors: readonly KinematicActor[],
  options: KinematicSimOptions,
): KinematicSimResult {
  const prepared = new Map<string, PreparedActor>();
  for (const a of actors) prepared.set(a.id, prepareActor(a));

  const monitored = options.monitoredPairs.filter(
    ([a, b]) => prepared.has(a) && prepared.has(b),
  );

  const contacts: PairContact[] = [];
  const contactedKeys = new Set<string>();
  const minGapByPair = new Map<string, PairMinGap>();
  const previewFrames: KinematicSimResult["previewFrames"] = [];

  const dt = options.fixedDeltaS > 0 ? options.fixedDeltaS : 0.05;
  const steps = Math.max(1, Math.ceil(options.durationS / dt));
  let finalTimeS = 0;

  for (let step = 0; step <= steps; step++) {
    const t = Math.min(options.durationS, step * dt);
    finalTimeS = t;
    const sampleCache = new Map<string, ActorSample>();
    const sampleOf = (id: string): ActorSample => {
      let s = sampleCache.get(id);
      if (!s) {
        s = sampleActor(prepared.get(id)!, t);
        sampleCache.set(id, s);
      }
      return s;
    };

    for (const [idA, idB] of monitored) {
      const key = pairKey(idA, idB);
      const sa = sampleOf(idA);
      const sb = sampleOf(idB);
      const gap = boxGap(sa.box, sb.box);
      const prevGap = minGapByPair.get(key);
      if (!prevGap || gap < prevGap.gapM) {
        minGapByPair.set(key, { gapM: gap, timeS: t });
      }
      if (gap <= 0 && !contactedKeys.has(key)) {
        contactedKeys.add(key);
        const relVx = sa.velocity.x - sb.velocity.x;
        const relVy = sa.velocity.y - sb.velocity.y;
        const sep = {
          x: sb.box.center.x - sa.box.center.x,
          y: sb.box.center.y - sa.box.center.y,
        };
        const sepLen = Math.hypot(sep.x, sep.y) || 1;
        const closing = (relVx * sep.x + relVy * sep.y) / sepLen;
        contacts.push({
          timeS: t,
          point: {
            x: (sa.box.center.x + sb.box.center.x) / 2,
            y: (sa.box.center.y + sb.box.center.y) / 2,
          },
          actorAId: idA,
          actorBId: idB,
          closingSpeedMps: Math.max(0, closing),
        });
      }
    }

    previewFrames.push({
      timestamp: t,
      actors: actors.map((actor) => {
        const sample = sampleOf(actor.id);
        return {
          id: actor.id,
          x: sample.box.center.x,
          y: sample.box.center.y,
          yaw: sample.box.heading,
          speed: Math.hypot(sample.velocity.x, sample.velocity.y),
        };
      }),
    });

    if (t >= options.durationS) break;
  }

  const pathArcLengthByActor = new Map<string, number>();
  for (const [id, p] of prepared) pathArcLengthByActor.set(id, p.totalArcM);

  return {
    contacts,
    minGapByPair,
    pathArcLengthByActor,
    previewFrames,
    finalTimeS,
  };
}
