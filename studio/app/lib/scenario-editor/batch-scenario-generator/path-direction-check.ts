/**
 * Wrong-way path validator for authored (timed-path) VEHICLE actors.
 *
 * Why: the collision route planner authored a "left turn" whose exit leg drove
 * 100+ m SOUTH down the subject's northbound lane (dirosa left-686-0 / left-935-2,
 * dib review 2026-07-17) — a head-on "drunk driver" no metric caught: the 2D
 * wrong_way signal watches the SUBJECT only. Root cause class: lanes whose stored
 * centerline yaw disagrees with real traffic direction poison any planner that
 * trusts one source; instead of patching each picker, this validator rejects
 * any draft whose vehicle path runs counter to the nearest lane's stored travel
 * yaw for a sustained stretch. FAIL-CLOSED at emit — a rejected draft is
 * skipped and resampled, never persisted.
 *
 * Ped/walker actors are exempt (crossing a lane is their job). Short opposed
 * runs (lane changes clipping an opposing edge, junction sweeps) are tolerated
 * via the sustained-run thresholds.
 */
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";

/** Lateral capture radius for "this leg is ON that lane" (m). Half a lane
 * width plus jitter; tight enough not to grab the adjacent opposing lane. */
const CAPTURE_RADIUS_M = 2.5;
/** A leg opposes its lane when headings differ by more than this (deg). */
const OPPOSED_DEG = 120;
/** Reject when the cumulative opposed run exceeds this many meters… */
const MAX_OPPOSED_RUN_M = 15;
/** …or this fraction of the path length, whichever is smaller. */
const MAX_OPPOSED_FRACTION = 0.25;

interface Vertex {
  x: number;
  y: number;
  yaw: number; // degrees, frontend basis (stored centerline yaw)
}

/** Coarse spatial hash of every drivable-lane centerline vertex. */
export interface LaneDirectionIndex {
  cell: number;
  grid: Map<string, Vertex[]>;
}

export function buildLaneDirectionIndex(
  segments: readonly RuntimeRoadSegment[],
  cell = 12,
): LaneDirectionIndex {
  const grid = new Map<string, Vertex[]>();
  for (const seg of segments) {
    const laneType = String(
      (seg as { lane_type?: string }).lane_type ?? "",
    ).toLowerCase();
    if (laneType && laneType !== "driving" && laneType !== "bidirectional") {
      continue;
    }
    for (const p of seg.centerline ?? []) {
      if (
        !Number.isFinite(p?.x) ||
        !Number.isFinite(p?.y) ||
        !Number.isFinite(p?.yaw)
      ) {
        continue;
      }
      const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push({ x: p.x, y: p.y, yaw: p.yaw });
    }
  }
  return { cell, grid };
}

function nearestVertex(
  index: LaneDirectionIndex,
  x: number,
  y: number,
): { v: Vertex; dist: number } | null {
  const cx = Math.floor(x / index.cell);
  const cy = Math.floor(y / index.cell);
  let best: Vertex | null = null;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.grid.get(`${cx + dx}:${cy + dy}`);
      if (!bucket) continue;
      for (const v of bucket) {
        const d = Math.hypot(v.x - x, v.y - y);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
  }
  return best ? { v: best, dist: bestD } : null;
}

function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

export interface WrongWayVerdict {
  opposedRunM: number;
  pathLengthM: number;
  /** Longest single contiguous opposed stretch (m) — the reject driver. */
  longestOpposedM: number;
  rejected: boolean;
}

/**
 * Measure how much of a waypoint path runs AGAINST the nearest lane's stored
 * travel yaw. Legs with no lane within CAPTURE_RADIUS_M are neutral (junction
 * interiors are sparsely covered — they neither accumulate nor reset the
 * contiguous run).
 */
export function wrongWayVerdictForPath(
  index: LaneDirectionIndex,
  waypoints: ReadonlyArray<{ x: number; y: number }>,
): WrongWayVerdict {
  let opposed = 0;
  let length = 0;
  let run = 0;
  let longestRun = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const legLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (legLen < 1e-3) continue;
    length += legLen;
    const heading = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const near = nearestVertex(index, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (!near || near.dist > CAPTURE_RADIUS_M) continue; // neutral
    if (angleDiffDeg(heading, near.v.yaw) > OPPOSED_DEG) {
      opposed += legLen;
      run += legLen;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  const limit = Math.min(MAX_OPPOSED_RUN_M, MAX_OPPOSED_FRACTION * length || Infinity);
  return {
    opposedRunM: opposed,
    pathLengthM: length,
    longestOpposedM: longestRun,
    rejected: longestRun > limit,
  };
}

// NOTE (2026-08-02, negative result worth keeping): a rotation/winding verdict
// over the authored subject path was prototyped here to catch authored U-turn/loop
// routes and REMOVED after empirical tuning on the allfam-avoid corpus. The
// full-plan or 20 s-prefix rotation cannot separate defects from good scenes
// (40-75/126 rendered-clean controls carry ±180°+ in the authored tail — two
// sequential legit turns, or a post-conflict continuation the yielding subject
// never reaches), and the pre-conflict slice inverts it (1/10 defect recall).
// The workable levers are (a) the lane-direction check below applied to the
// SUBJECT's driven-window prefix — every 2026-08-01 wrong-way/U-turn ledger row
// opposes the lane index somewhere in its driven prefix — and (b) the
// CHAIN-level net-turn/winding guard at route-build time (approach+gate only,
// no wandering tail), which lives in `buildGatePolyline` on the
// `dib/crosswalk-turn-yield-fixes` branch.
