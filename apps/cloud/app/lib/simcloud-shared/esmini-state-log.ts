/**
 * Convert raw esmini per-frame state samples into the shared
 * `EsminiValidationMetrics` shape that lives in `scenario_validation_jobs`
 * and on the wire to the frontend.
 *
 * The Lambda runs esmini headless with `--csv_logger <file>` (esmini v3.x).
 * That CSV is a *wide* format — one row per timestep, with every entity's
 * state concatenated horizontally:
 *
 *   - A handful of banner/metadata lines first (`esmini GIT REV: ...`,
 *     `Scenario File Name:`, `Number of Vehicles:`), then the real header.
 *   - Header columns: `Index [-], TimeStamp [s], #1 Entity_Name [-],
 *     #1 Entity_ID [-], #1 Current_Speed [m/s], ..., #1 World_Position_X [m],
 *     #1 World_Position_Y [m], ..., #1 World_Heading_Angle [rad], ...,
 *     #1 collision_ids, #2 Entity_Name [-], ...`.
 *   - Each entity carries a `collision_ids` column listing the Entity_IDs it
 *     is currently overlapping with — so collisions come straight from the
 *     CSV (no stderr scraping).
 *
 * `parseEsminiCsv` skips the banner, pivots the `#N <field>` columns into
 * per-actor trajectories keyed by the ScenarioObject @name (a UUID in our
 * drafts), and derives a deduped collision list; `summarizeMetrics` then
 * computes min-distance / min-TTC / PET. The frontend reuses the same module to
 * draw the trajectory polylines after fetching the CSV via a presigned URL.
 *
 * Dependency-free so it ships unchanged into both the Node 20 Lambda image
 * and the Next.js bundle.
 */
import type {
  EsminiActorTrajectory,
  EsminiCollisionEvent,
  EsminiExpectedOutcome,
  EsminiTrajectoryPoint,
  EsminiValidationMetrics,
} from "./scenario-validation-job";
import {
  compactLintReport,
  fromEsminiTrajectories,
  lintActorTracks,
} from "./scenario-lint";

export interface ParsedEsminiStateLog {
  /** Distinct actor ids (ScenarioObject @name) in entity order. */
  actorIds: string[];
  /** Per-actor trajectories, ascending by time. */
  trajectories: EsminiActorTrajectory[];
  /**
   * Collisions read from the per-entity `collision_ids` columns, deduped to
   * the earliest frame per unordered actor-name pair.
   */
  collisions: EsminiCollisionEvent[];
  /** Last sim time observed in the log (seconds). */
  durationS: number;
  /** Free-form non-fatal warnings (unknown columns, dropped rows). */
  warnings: string[];
}

const EMPTY_LOG: ParsedEsminiStateLog = {
  actorIds: [],
  trajectories: [],
  collisions: [],
  durationS: 0,
  warnings: [],
};

function splitCsvLine(line: string): string[] {
  // esmini's CSV is comma-separated with no quoted commas; a trailing comma
  // and padding spaces per field are normal, so trim each field.
  return line.split(",").map((s) => s.trim());
}

/** Per-entity fields we pull out of the wide header, matched by substring. */
type EntityField = "name" | "id" | "x" | "y" | "yaw" | "speed" | "collision";

function classifyEntityField(field: string): EntityField | null {
  const f = field.toLowerCase();
  if (f.includes("entity_name")) return "name";
  if (f.includes("entity_id")) return "id";
  if (f.includes("world_position_x")) return "x";
  if (f.includes("world_position_y")) return "y";
  if (f.includes("world_heading_angle")) return "yaw";
  if (f.includes("current_speed")) return "speed";
  if (f.includes("collision_ids")) return "collision";
  return null;
}

interface EntityColumns {
  n: number;
  name?: number;
  id?: number;
  x?: number;
  y?: number;
  yaw?: number;
  speed?: number;
  collision?: number;
}

function velocity(speed: number, yaw: number): { vx: number; vy: number } {
  return { vx: Math.cos(yaw) * speed, vy: Math.sin(yaw) * speed };
}

export function parseEsminiCsv(text: string): ParsedEsminiStateLog {
  const trimmed = text.replace(/^﻿/, "");
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);

  // Skip esmini's banner/metadata lines and find the real header — the first
  // row carrying the TimeStamp column and at least one entity block.
  const headerIdx = lines.findIndex(
    (l) => /timestamp/i.test(l) && /#\d+\s+entity_name/i.test(l),
  );
  if (headerIdx === -1) {
    return {
      ...EMPTY_LOG,
      warnings: ["esmini csv header not found (no TimeStamp/Entity_Name row)"],
    };
  }

  const header = splitCsvLine(lines[headerIdx]!);
  let timeIdx = -1;
  const entities = new Map<number, EntityColumns>();
  header.forEach((col, idx) => {
    if (timeIdx === -1 && /timestamp/i.test(col)) {
      timeIdx = idx;
      return;
    }
    const m = /^#(\d+)\s+(.+)$/.exec(col);
    if (!m) return;
    const n = Number(m[1]);
    const field = classifyEntityField(m[2]!);
    if (!field) return;
    let ent = entities.get(n);
    if (!ent) {
      ent = { n };
      entities.set(n, ent);
    }
    if (ent[field] === undefined) ent[field] = idx;
  });

  const entityCols = [...entities.values()]
    .filter((e) => e.name !== undefined && e.x !== undefined && e.y !== undefined)
    .sort((a, b) => a.n - b.n);

  if (timeIdx === -1 || entityCols.length === 0) {
    return {
      ...EMPTY_LOG,
      warnings: ["esmini csv header missing TimeStamp or entity position columns"],
    };
  }

  const num = (cells: string[], idx: number | undefined): number =>
    idx === undefined ? 0 : Number(cells[idx]);

  const byActor = new Map<string, EsminiTrajectoryPoint[]>();
  const actorOrder: string[] = [];
  // Earliest collision frame per unordered actor-name pair.
  const collisionByPair = new Map<string, EsminiCollisionEvent>();
  let maxT = 0;

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const t = Number(cells[timeIdx]);
    if (!Number.isFinite(t)) continue;

    // Per-frame Entity_ID -> name map so numeric collision_ids resolve back to
    // the ScenarioObject names we key trajectories by, plus this frame's state.
    const idToName = new Map<string, string>();
    const frame = new Map<
      string,
      { x: number; y: number; yaw: number; speed: number }
    >();

    for (const ent of entityCols) {
      const name = cells[ent.name!];
      if (!name) continue;
      const x = num(cells, ent.x);
      const y = num(cells, ent.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const yawRaw = num(cells, ent.yaw);
      const speedRaw = num(cells, ent.speed);
      const yaw = Number.isFinite(yawRaw) ? yawRaw : 0;
      const speed = Number.isFinite(speedRaw) ? speedRaw : 0;
      if (ent.id !== undefined && cells[ent.id]) idToName.set(cells[ent.id]!, name);
      frame.set(name, { x, y, yaw, speed });
      if (!byActor.has(name)) {
        byActor.set(name, []);
        actorOrder.push(name);
      }
      byActor.get(name)!.push({ t, x, y, yaw, speed });
    }
    if (t > maxT) maxT = t;

    // Collisions: any non-empty collision_ids cell lists the Entity_IDs this
    // entity overlaps this frame. Record the earliest frame per pair.
    for (const ent of entityCols) {
      if (ent.collision === undefined) continue;
      const raw = cells[ent.collision];
      if (!raw || !/\d/.test(raw)) continue;
      const selfName = cells[ent.name!];
      if (!selfName) continue;
      for (const tok of raw.split(/[\s;]+/).filter(Boolean)) {
        const otherName = idToName.get(tok);
        if (!otherName || otherName === selfName) continue;
        const pair = [selfName, otherName].sort();
        const key = pair.join("\0");
        if (collisionByPair.has(key)) continue;
        const a = frame.get(selfName);
        const b = frame.get(otherName);
        if (!a || !b) continue;
        const va = velocity(a.speed, a.yaw);
        const vb = velocity(b.speed, b.yaw);
        collisionByPair.set(key, {
          t,
          actor_a: pair[0]!,
          actor_b: pair[1]!,
          point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          relative_speed_mps: Math.hypot(va.vx - vb.vx, va.vy - vb.vy),
          ttc_at_trigger_s: 0,
        });
      }
    }
  }

  if (actorOrder.length === 0) {
    return { ...EMPTY_LOG, warnings: ["esmini csv contained no parseable rows"] };
  }

  const trajectories: EsminiActorTrajectory[] = actorOrder.map((actor_id) => ({
    actor_id,
    points: byActor.get(actor_id)!.sort((a, b) => a.t - b.t),
  }));
  const collisions = [...collisionByPair.values()].sort((a, b) => a.t - b.t);

  return { actorIds: actorOrder, trajectories, collisions, durationS: maxT, warnings: [] };
}

/**
 * Compute pairwise minimum separation, minimum TTC, and PET across the rollout.
 * Minimum separation keeps the existing common interpolation grid. TTC uses
 * finite-difference velocities at original same-time samples so its semantics
 * match restampable CARLA tracks; PET compares the sampled paths independent
 * of time.
 */
function interpolatePoint(
  points: EsminiTrajectoryPoint[],
  t: number,
): EsminiTrajectoryPoint | null {
  if (points.length === 0) return null;
  if (t <= points[0]!.t) return points[0]!;
  if (t >= points[points.length - 1]!.t) return points[points.length - 1]!;
  // Binary search for surrounding samples.
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return a;
  const f = (t - a.t) / span;
  return {
    t,
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    yaw: a.yaw + (b.yaw - a.yaw) * f,
    speed: a.speed + (b.speed - a.speed) * f,
  };
}

const RESAMPLE_HZ = 20; // 50 ms grid — matches the default writer fixed_timestep

function distance(a: EsminiTrajectoryPoint, b: EsminiTrajectoryPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

const CONFLICT_CORRIDOR_M = 4.0;

interface PlanarVelocity {
  vx: number;
  vy: number;
}

function finiteDifferenceVelocities(points: EsminiTrajectoryPoint[]): Array<PlanarVelocity | null> {
  return points.map((point, index) => {
    if (index > 0) {
      const previous = points[index - 1]!;
      const dt = point.t - previous.t;
      if (dt > 0) {
        return { vx: (point.x - previous.x) / dt, vy: (point.y - previous.y) / dt };
      }
    }
    if (index + 1 < points.length) {
      const following = points[index + 1]!;
      const dt = following.t - point.t;
      if (dt > 0) {
        return { vx: (following.x - point.x) / dt, vy: (following.y - point.y) / dt };
      }
    }
    return null;
  });
}

function timeToClosestApproach(
  a: EsminiTrajectoryPoint,
  b: EsminiTrajectoryPoint,
  velocityA: PlanarVelocity,
  velocityB: PlanarVelocity,
): number | null {
  // Semantic change from the former distance / line-of-sight closing-rate
  // approximation: project relative position under constant relative velocity
  // and report time to closest approach only when its miss distance enters the
  // conflict corridor.
  const vx = velocityB.vx - velocityA.vx;
  const vy = velocityB.vy - velocityA.vy;
  const px = b.x - a.x;
  const py = b.y - a.y;
  const speedSq = vx * vx + vy * vy;
  if (speedSq <= 1e-12) return null;
  const projection = px * vx + py * vy;
  if (projection >= 0) return null;
  const ttc = -projection / speedSq;
  const missDistance = Math.hypot(px + vx * ttc, py + vy * ttc);
  return missDistance < CONFLICT_CORRIDOR_M ? ttc : null;
}

function pathCrossing(
  a: EsminiActorTrajectory,
  b: EsminiActorTrajectory,
): { distance: number; tA: number; tB: number } | null {
  let best: { distance: number; tA: number; tB: number } | null = null;
  for (const pa of a.points) {
    for (const pb of b.points) {
      const d = distance(pa, pb);
      if (!best || d < best.distance) {
        best = { distance: d, tA: pa.t, tB: pb.t };
      }
    }
  }
  return best;
}

export function summarizeMetrics(
  log: ParsedEsminiStateLog,
  collisions: EsminiCollisionEvent[],
  extraWarnings: string[] = [],
): EsminiValidationMetrics {
  const warnings = [...log.warnings, ...extraWarnings];
  const trajectories = log.trajectories;
  const durationS = log.durationS;

  let minDistance: EsminiValidationMetrics["min_distance"] = null;
  let minTtc: EsminiValidationMetrics["min_ttc"] = null;
  let petS: number | null = null;

  if (trajectories.length >= 2 && durationS > 0) {
    const stepCount = Math.max(2, Math.round(durationS * RESAMPLE_HZ) + 1);
    for (let i = 0; i < trajectories.length; i += 1) {
      for (let j = i + 1; j < trajectories.length; j += 1) {
        const a = trajectories[i]!;
        const b = trajectories[j]!;
        const crossing = pathCrossing(a, b);
        if (crossing && crossing.distance < CONFLICT_CORRIDOR_M) {
          const pairPet = Math.abs(crossing.tB - crossing.tA);
          if (petS === null || pairPet < petS) petS = pairPet;
        }
        const velocitiesA = finiteDifferenceVelocities(a.points);
        const velocitiesB = finiteDifferenceVelocities(b.points);
        const bIndexByTime = new Map(b.points.map((point, index) => [point.t, index]));
        a.points.forEach((pa, indexA) => {
          const indexB = bIndexByTime.get(pa.t);
          const velocityA = velocitiesA[indexA];
          const velocityB = indexB === undefined ? null : velocitiesB[indexB];
          if (indexB === undefined || !velocityA || !velocityB) return;
          const pb = b.points[indexB]!;
          const ttc = timeToClosestApproach(pa, pb, velocityA, velocityB);
          if (ttc !== null && (!minTtc || ttc < minTtc.seconds)) {
            minTtc = { seconds: ttc, t: pa.t, actor_a: a.actor_id, actor_b: b.actor_id };
          }
        });
        for (let s = 0; s < stepCount; s += 1) {
          const t = (s / (stepCount - 1)) * durationS;
          const pa = interpolatePoint(a.points, t);
          const pb = interpolatePoint(b.points, t);
          if (!pa || !pb) continue;
          const d = distance(pa, pb);
          if (!minDistance || d < minDistance.meters) {
            minDistance = { meters: d, t, actor_a: a.actor_id, actor_b: b.actor_id };
          }
        }
      }
    }
  }

  return {
    duration_s: durationS,
    actor_trajectories: trajectories,
    collisions,
    lint: compactLintReport(
      lintActorTracks(fromEsminiTrajectories(trajectories)),
    ),
    min_distance: minDistance,
    min_ttc: minTtc,
    pet_s: petS,
    warnings,
  };
}

/**
 * A min-distance contact within this many metres of the ego counts as a
 * collision even when esmini's bounding-box check didn't fire — covers
 * grazing contacts and timestep "tunneling" (actors passing through each
 * other between recorded frames). ~1 m ≈ a car half-width plus a pedestrian
 * radius, i.e. bodies that would physically overlap.
 */
export const DEFAULT_CONTACT_GRACE_M = 1.0;

/**
 * For a `near_miss` scenario the conflict must come at least this close to
 * count as a genuine conflict the AV had to resolve; a wider miss means the
 * actors never really conflicted and the scenario is degenerate.
 */
export const DEFAULT_NEAR_MISS_MAX_M = 5.0;

/**
 * Judge whether a validation run matches the scenario's declared intent.
 *
 *   - `collision` (every v1 collision family): pass requires an ego contact —
 *     either an esmini collision event involving the ego, or a closest
 *     approach within `contactGraceMeters` (grazing / tunneling). A clean miss
 *     fails, which is the signal the planner's geometry/timing needs repair.
 *   - `near_miss`: pass requires the actors to come close (≤ `nearMissMaxMeters`)
 *     without contacting; an actual contact fails (avoidance was intended).
 *
 * Warnings never auto-fail. Returns "inconclusive" if metrics are degenerate
 * (e.g. the parser bailed).
 */
export function verdictFromMetrics(
  metrics: EsminiValidationMetrics,
  opts: {
    egoActorId: string;
    expectedOutcome: EsminiExpectedOutcome;
    contactGraceMeters?: number;
    nearMissMaxMeters?: number;
  },
): "pass" | "fail" | "inconclusive" {
  if (metrics.duration_s <= 0 || metrics.actor_trajectories.length === 0) {
    return "inconclusive";
  }
  const involvesEgo = (a: string, b: string): boolean =>
    a === opts.egoActorId || b === opts.egoActorId;

  const egoCollision = metrics.collisions.some((c) => involvesEgo(c.actor_a, c.actor_b));
  const md = metrics.min_distance;
  const egoMinMeters =
    md && involvesEgo(md.actor_a, md.actor_b) ? md.meters : null;

  if (opts.expectedOutcome === "near_miss") {
    if (egoCollision) return "fail"; // contact when a clean avoidance was intended
    const maxMiss = opts.nearMissMaxMeters ?? DEFAULT_NEAR_MISS_MAX_M;
    return egoMinMeters !== null && egoMinMeters <= maxMiss ? "pass" : "fail";
  }

  // expectedOutcome === "collision"
  const grace = opts.contactGraceMeters ?? DEFAULT_CONTACT_GRACE_M;
  const grazingContact = egoMinMeters !== null && egoMinMeters <= grace;
  return egoCollision || grazingContact ? "pass" : "fail";
}
