/**
 * SUMO FCD trajectories → background timed-path actors (pure functions).
 *
 * Every function here is deterministic and side-effect free; the demo emitter
 * (apps/web/scripts/emit-sumo-ambient-demo.ts) and any future emit-knob wiring
 * compose them. Nothing in this module touches the manual editor flow.
 *
 * Dialect decisions (validated against services/carla-worker/carla_worker/
 * validation.py and packages/shared/src/scenario-editor.ts):
 *  - `placement_mode: "timed_path"` + `path_timing: "schedule"` — the times are
 *    arrival times; coincident points are a hold. SUMO trajectories are
 *    kinematically feasible by construction (car-following with bounded
 *    accel/decel), so the schedule controller's catch-up never sees the large
 *    lag that made the twin pipeline avoid this mode for real-data replays.
 *  - No `behavior` clips: a scheduled actor may not carry longitudinal clips
 *    (validation.py `_validate_scheduled_path_clips`), and the schedule already
 *    owns the path + longitudinal channels.
 *  - Stub `spawn` road anchor (the walker-emit precedent): world placement is
 *    authoritative via `spawn_point` + `timed_waypoints`; persisting road ids
 *    is forbidden by the world_anchor doctrine (UE5 renumbers them).
 *  - Ids carry the `bg-` dressing prefix, so the worker's contact metrics can
 *    never resolve a SUMO ambient as the conflict actor.
 */

import type { ScenarioEditorActorDraft, ScenarioEditorTimedWaypoint } from "@simforge/studio-shared";
import { normalizeYawDegrees } from "../../../editor-map/coordinate-frames";
import { blueprintForVtype, DEFAULT_VTYPE_LENGTHS_M } from "./blueprints";
import {
  SUMO_AMBIENT_DEFAULTS,
  SUMO_AMBIENT_ID_PREFIX,
  type DroppedTrack,
  type FrameAlignmentReport,
  type RuntimeLanePolyline,
  type SumoAmbientOptions,
  type SumoAmbientResult,
  type SumoFcdSample,
  type SumoTrajectoryFile,
  type SumoVehicleTrack,
} from "./types";

/** Mirrors the worker's `_TIMED_PATH_MIN_SEGMENT_SECONDS` teleport guard: a
 * zero-elapsed segment may move at most 0.25 m. Our resampler never emits
 * zero-elapsed segments, but the invariant is asserted in tests. */
export const TIMED_PATH_MAX_TELEPORT_M = 0.25;

/** A stationary run is collapsed to a hold pair when the vehicle moved less
 * than this between samples. */
const HOLD_EPS_M = 0.15;

// ---------------------------------------------------------------------------
// Frame + pose primitives
// ---------------------------------------------------------------------------

/** SUMO navigational angle (deg, 0 = north/+y, clockwise) → runtime yaw
 * (deg, math convention: 0 = +x east, counter-clockwise, normalized [0,360)).
 * The worker converts runtime yaw to CARLA yaw itself (`carla_yaw = -yaw`). */
export function sumoAngleToRuntimeYawDeg(angleDeg: number): number {
  return normalizeYawDegrees(90 - angleDeg);
}

/** Unit heading vector for a SUMO navigational angle, in the runtime frame. */
export function sumoAngleToHeadingVector(angleDeg: number): { x: number; y: number } {
  const yawRad = (sumoAngleToRuntimeYawDeg(angleDeg) * Math.PI) / 180;
  return { x: Math.cos(yawRad), y: Math.sin(yawRad) };
}

/** SUMO FCD positions are the FRONT-BUMPER center; CARLA transforms are the
 * body center. Shift every sample back by half the vehicle length. */
export function shiftFrontBumperToCenter(
  samples: SumoFcdSample[],
  vehicleLengthM: number,
): SumoFcdSample[] {
  const half = vehicleLengthM / 2;
  return samples.map((s) => {
    const h = sumoAngleToHeadingVector(s.angle_deg);
    return { ...s, x: s.x - h.x * half, y: s.y - h.y * half };
  });
}

// ---------------------------------------------------------------------------
// Frame verification (empirical, never assumed)
// ---------------------------------------------------------------------------

function distanceToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

function medianLaneDistance(
  points: Array<{ x: number; y: number }>,
  lanes: RuntimeLanePolyline[],
  flipY: boolean,
): number {
  const distances = points.map((p) => {
    const py = flipY ? -p.y : p.y;
    let best = Infinity;
    for (const lane of lanes) {
      for (let i = 1; i < lane.length; i += 1) {
        const d = distanceToSegmentSq(p.x, py, lane[i - 1]!.x, lane[i - 1]!.y, lane[i]!.x, lane[i]!.y);
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  });
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)] ?? Infinity;
}

/** Empirically decide whether the trajectories already sit in the runtime frame
 * (they must — netconvert ran with --offset.disable-normalization) by fitting
 * them against reference lane centerlines as-is and y-flipped. */
export function verifyFrameAlignment(
  tracks: SumoVehicleTrack[],
  referenceLanes: RuntimeLanePolyline[],
  sampleTarget = 80,
): FrameAlignmentReport {
  const points: Array<{ x: number; y: number }> = [];
  const all: Array<{ x: number; y: number }> = [];
  for (const track of tracks) {
    for (let i = 0; i < track.samples.length; i += 25) {
      all.push(track.samples[i]!);
    }
  }
  const stride = Math.max(1, Math.floor(all.length / sampleTarget));
  for (let i = 0; i < all.length; i += stride) points.push(all[i]!);
  const asIsMedianM = medianLaneDistance(points, referenceLanes, false);
  const flippedMedianM = medianLaneDistance(points, referenceLanes, true);
  let verdict: FrameAlignmentReport["verdict"] = "ambiguous";
  if (asIsMedianM < flippedMedianM / 4) verdict = "as-is";
  else if (flippedMedianM < asIsMedianM / 4) verdict = "flipped";
  return {
    asIsMedianM: Number(asIsMedianM.toFixed(3)),
    flippedMedianM: Number(flippedMedianM.toFixed(3)),
    sampledPoints: points.length,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Track filtering (window, map edge, de-overlap, cap)
// ---------------------------------------------------------------------------

function nearBoundary(
  p: { x: number; y: number },
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  marginM: number,
  boundaryPoints?: Array<{ x: number; y: number }>,
): boolean {
  if (
    p.x - bounds.minX <= marginM ||
    bounds.maxX - p.x <= marginM ||
    p.y - bounds.minY <= marginM ||
    bounds.maxY - p.y <= marginM
  ) {
    return true;
  }
  // Subnet fringes (corridor cuts): an on/off-ramp stub ends mid-bbox, and
  // appearing/vanishing there is as legitimate as at the map edge.
  if (boundaryPoints) {
    const marginSq = marginM * marginM;
    for (const b of boundaryPoints) {
      const d = (p.x - b.x) * (p.x - b.x) + (p.y - b.y) * (p.y - b.y);
      if (d <= marginSq) return true;
    }
  }
  return false;
}

/** Cut samples to [0, clipDurationS] and apply the presence + map-edge policy.
 *
 * A timed path can neither late-spawn nor despawn an actor, so:
 *  - a vehicle entering after clip start is kept only when it enters near the
 *    net boundary (it holds at the fringe, then drives in — reads as arriving
 *    traffic); an interior late entry would materialize a parked car mid-road;
 *  - a vehicle exiting before clip end is kept only when its last position is
 *    near the boundary (it holds there, mostly off-camera); an interior early
 *    exit would freeze mid-road — the exact "frozen car" review failure.
 */
export function filterTracksForWindow(
  tracks: SumoVehicleTrack[],
  opts: {
    clipDurationS: number;
    minPresenceS: number;
    edgeMarginM: number;
    netBounds?: { minX: number; minY: number; maxX: number; maxY: number };
    netBoundaryPoints?: Array<{ x: number; y: number }>;
  },
): { kept: SumoVehicleTrack[]; dropped: DroppedTrack[] } {
  const kept: SumoVehicleTrack[] = [];
  const dropped: DroppedTrack[] = [];
  const lateEntryGraceS = 0.5;
  const earlyExitGraceS = 0.5;
  for (const track of tracks) {
    const samples = track.samples.filter((s) => s.t >= 0 && s.t <= opts.clipDurationS);
    if (samples.length < 2) {
      dropped.push({ id: track.id, reason: "short_presence", detail: "under 2 samples in window" });
      continue;
    }
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const presence = last.t - first.t;
    if (presence < opts.minPresenceS) {
      dropped.push({ id: track.id, reason: "short_presence", detail: `${presence.toFixed(1)}s` });
      continue;
    }
    if (opts.netBounds) {
      if (
        first.t > lateEntryGraceS &&
        !nearBoundary(first, opts.netBounds, opts.edgeMarginM, opts.netBoundaryPoints)
      ) {
        dropped.push({ id: track.id, reason: "interior_late_entry", detail: `t=${first.t.toFixed(1)}` });
        continue;
      }
      if (
        last.t < opts.clipDurationS - earlyExitGraceS &&
        !nearBoundary(last, opts.netBounds, opts.edgeMarginM, opts.netBoundaryPoints)
      ) {
        dropped.push({ id: track.id, reason: "interior_early_exit", detail: `t=${last.t.toFixed(1)}` });
        continue;
      }
    }
    kept.push({ ...track, samples });
  }
  return { kept, dropped };
}

/** Drop tracks containing a SUMO teleport: any implied inter-sample speed
 * above `maxPlausibleSpeedMps`. SUMO teleports gridlocked vehicles (default
 * time-to-teleport 300 s); replaying the jump as a schedule segment would be a
 * physics-defying dash across the map. */
export function dropTeleportTracks(
  tracks: SumoVehicleTrack[],
  maxPlausibleSpeedMps: number,
): { kept: SumoVehicleTrack[]; dropped: DroppedTrack[] } {
  const kept: SumoVehicleTrack[] = [];
  const dropped: DroppedTrack[] = [];
  for (const track of tracks) {
    let teleport: string | null = null;
    for (let i = 1; i < track.samples.length && !teleport; i += 1) {
      const a = track.samples[i - 1]!;
      const b = track.samples[i]!;
      const dt = b.t - a.t;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (dt > 1e-9 && d / dt > maxPlausibleSpeedMps) {
        teleport = `${(d / dt).toFixed(0)} m/s at t=${b.t.toFixed(1)}`;
      }
    }
    if (teleport) dropped.push({ id: track.id, reason: "teleport_jump", detail: teleport });
    else kept.push(track);
  }
  return { kept, dropped };
}

/** Drop tracks whose CLIP-START position sits within `clearanceM` of any
 * scenario actor spawn (subject, cause, occluders, parked). Mirrors the near-field
 * ring's keep-clear seeding — prevents the physics-eject "flying car". */
export function deoverlapTracks(
  tracks: SumoVehicleTrack[],
  keepClearPoints: Array<{ x: number; y: number }>,
  clearanceM: number,
): { kept: SumoVehicleTrack[]; dropped: DroppedTrack[] } {
  if (keepClearPoints.length === 0) return { kept: tracks, dropped: [] };
  const kept: SumoVehicleTrack[] = [];
  const dropped: DroppedTrack[] = [];
  const clearanceSq = clearanceM * clearanceM;
  for (const track of tracks) {
    const p = track.samples[0];
    if (!p) {
      kept.push(track);
      continue;
    }
    const hit = keepClearPoints.find(
      (k) => (k.x - p.x) * (k.x - p.x) + (k.y - p.y) * (k.y - p.y) < clearanceSq,
    );
    if (hit) {
      dropped.push({
        id: track.id,
        reason: "spawn_overlap",
        detail: `within ${clearanceM}m of (${hit.x.toFixed(1)},${hit.y.toFixed(1)})`,
      });
    } else {
      kept.push(track);
    }
  }
  return { kept, dropped };
}

/** Centre-to-centre floor for AMBIENT-vs-AMBIENT spawn spacing.
 *
 * Sized off the vehicle mix rather than off the scenario-actor clearance: the
 * pool tops out at the carlacola box truck, whose IN-IMAGE body length is
 * 8.0 m (measured from live bbox_extent 2026-08-07 — the catalogue said 6.5),
 * so two of them need more than 8 m between centres before their bodies stop
 * intersecting. 10 m clears the worst pair with a buffer. Measured consequence
 * of undersizing: at 6 m the 2D gate reported 7-8 dressing spawn overlaps and
 * ambient collisions per scene. */
export const MUTUAL_SPAWN_CLEARANCE_FLOOR_M = 10;

/** Drop SUMO tracks that would MATERIALISE ON TOP OF EACH OTHER.
 *
 * `deoverlapTracks` only clears the SUMO population against the scripted
 * scenario actors; it never compares SUMO tracks to one another. That gap is
 * real: on a Yale medium window two ambient vehicles were emitted 0.000 m apart
 * (and 0.155 m on a heavy window), which is the physics-eject "flying car"
 * spawn overlap.
 *
 * The comparison is UNCONDITIONAL in time, and that is the subtle part. It is
 * tempting to gate it on the two entry times being close — "a car entering 5 s
 * later drives into space the first one has vacated" — but that reasoning does
 * not hold for this dialect: a `timed_path` actor cannot late-spawn (the same
 * property that forces the map-edge entry policy above). Every converted actor
 * is therefore present from t=0 at its spawn point, whatever its first waypoint
 * time says, so two tracks sharing a spawn point collide even when their
 * schedules start seconds apart. Gating on time let a real 0.000 m pair through.
 *
 * Two conflict classes are tested:
 *  1. spawn vs spawn — two clip-start positions within `clearanceM` are
 *     co-located cars at frame 0 (the physics ejection above);
 *  2. held spawn vs a moving track — while a late entrant stands at its entry
 *     point (the fringe hold), any track that passes within `clearanceM` of it
 *     before it departs drives through a parked obstacle SUMO never put there.
 *     Checked in both directions.
 *
 * Acceptance is greedy and deterministic: tracks already moving at clip start
 * win over late entrants (the hold is the conversion artifact, so the holder is
 * the one to drop), ties broken by id; emitted order stays the input order. */
export function deoverlapTracksMutually(
  tracks: SumoVehicleTrack[],
  clearanceM: number,
): { kept: SumoVehicleTrack[]; dropped: DroppedTrack[] } {
  const clearanceSq = clearanceM * clearanceM;
  const order = new Map(tracks.map((t, i) => [t.id, i] as const));
  // Early/moving tracks get priority; late entrants (which hold at their entry
  // point from t=0 — the hold is the conversion artifact) yield.
  const ranked = [...tracks].sort((a, b) => {
    const ta = a.samples[0]?.t ?? 0;
    const tb = b.samples[0]?.t ?? 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const accepted: SumoVehicleTrack[] = [];
  const dropped: DroppedTrack[] = [];
  for (const track of ranked) {
    const spawn = track.samples[0];
    if (!spawn) {
      accepted.push(track);
      continue;
    }
    // The interval this track stands still at its spawn before departing.
    const holdUntil = spawn.t;
    let conflict: string | null = null;
    for (const other of accepted) {
      const otherSpawn = other.samples[0];
      if (!otherSpawn) continue;
      // (1) co-located at t=0 — both are on the map from frame 0 whatever
      // their SUMO entry times say (a timed_path actor cannot late-spawn).
      const dSpawnSq =
        (otherSpawn.x - spawn.x) * (otherSpawn.x - spawn.x) +
        (otherSpawn.y - spawn.y) * (otherSpawn.y - spawn.y);
      if (dSpawnSq < clearanceSq) {
        conflict = `spawn ${Math.sqrt(dSpawnSq).toFixed(1)}m from ${other.id} at t=0`;
        break;
      }
      // (2) the accepted track drives through this one's held spawn point
      // while it is still standing there.
      if (holdUntil > 0.05) {
        for (const s of other.samples) {
          if (s.t > holdUntil) break;
          const d = (s.x - spawn.x) * (s.x - spawn.x) + (s.y - spawn.y) * (s.y - spawn.y);
          if (d < clearanceSq) {
            conflict =
              `held spawn crossed by ${other.id} at t=${s.t.toFixed(1)}` +
              ` (${Math.sqrt(d).toFixed(1)}m, hold until t=${holdUntil.toFixed(1)})`;
            break;
          }
        }
        if (conflict) break;
      }
      // (2b) symmetric: this track drives through an accepted track's held
      // spawn point while THAT one is still standing there.
      if (otherSpawn.t > 0.05) {
        for (const s of track.samples) {
          if (s.t > otherSpawn.t) break;
          const d =
            (s.x - otherSpawn.x) * (s.x - otherSpawn.x) +
            (s.y - otherSpawn.y) * (s.y - otherSpawn.y);
          if (d < clearanceSq) {
            conflict =
              `crosses held spawn of ${other.id} at t=${s.t.toFixed(1)}` +
              ` (${Math.sqrt(d).toFixed(1)}m, hold until t=${otherSpawn.t.toFixed(1)})`;
            break;
          }
        }
        if (conflict) break;
      }
    }
    if (conflict) {
      dropped.push({ id: track.id, reason: "mutual_spawn_overlap", detail: conflict });
    } else {
      accepted.push(track);
    }
  }
  // Restore the input order so emission stays deterministic w.r.t. the source.
  accepted.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { kept: accepted, dropped };
}

function minDistanceSqToPoint(track: SumoVehicleTrack, p: { x: number; y: number }): number {
  let best = Infinity;
  for (let i = 0; i < track.samples.length; i += 10) {
    const s = track.samples[i]!;
    const d = (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y);
    if (d < best) best = d;
  }
  return best;
}

/** Time-synchronized camera value of a track: how many of its samples sit in
 * the FRUSTUM of the moving planned subject (ahead 5-120 m, within ~4 lanes
 * laterally) at the matching scene time. Spatial closest-approach ranking was
 * measured useless twice (dib's lane-spread review): the subject OUTRUNS the
 * congested flow, so a track that passes the subject's spawn is usually behind
 * the camera by the time the subject is moving. */
export function frustumFramesForTrack(
  track: SumoVehicleTrack,
  corridor: Array<{ t: number; x: number; y: number }>,
): number {
  if (corridor.length < 2) return 0;
  const subjectAt = (t: number): { x: number; y: number; hx: number; hy: number } | null => {
    if (t <= corridor[0]!.t || t >= corridor[corridor.length - 1]!.t) {
      // outside the planned drive: no camera value
      return null;
    }
    for (let i = 1; i < corridor.length; i += 1) {
      const a = corridor[i - 1]!;
      const b = corridor[i]!;
      if (t <= b.t) {
        const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: a.x + dx * f, y: a.y + dy * f, hx: dx / len, hy: dy / len };
      }
    }
    return null;
  };
  let frames = 0;
  for (let i = 0; i < track.samples.length; i += 10) {
    const s = track.samples[i]!;
    const e = subjectAt(s.t);
    if (!e) continue;
    const dx = s.x - e.x;
    const dy = s.y - e.y;
    const fwd = dx * e.hx + dy * e.hy;
    const lat = -dx * e.hy + dy * e.hx;
    if (fwd > 5 && fwd < 120 && Math.abs(lat) < 14) frames += 1;
  }
  return frames;
}

/** Keep the `maxActors` tracks that pass closest to the SUBJECT CORRIDOR (the
 * planned drive), so the cap spends the actor budget where the CAMERA is.
 *
 * Ranking by spawn-point proximity alone was measured insufficient (dib's v0
 * review: "traffic only in 1-2 lanes"): a 300 m crow-flies bubble around the
 * subject admits parallel roads and the opposite corridor, so the budget scattered
 * off-camera while the subject's own road stayed empty — the shipped heavy window
 * held 11 vehicles that PASS the subject yet the cap kept mostly non-passers.
 * With a corridor available the rank is the track's closest approach to the
 * planned drive; the point rank is the fallback. */
export function capTracks(
  tracks: SumoVehicleTrack[],
  maxActors: number,
  priorityPoint?: { x: number; y: number },
  priorityCorridor?: Array<{ t: number; x: number; y: number }>,
): { kept: SumoVehicleTrack[]; dropped: DroppedTrack[] } {
  if (tracks.length <= maxActors) return { kept: tracks, dropped: [] };
  const ranked = priorityCorridor && priorityCorridor.length > 1
    ? [...tracks]
        .map((t) => ({ t, f: frustumFramesForTrack(t, priorityCorridor as Array<{ t: number; x: number; y: number }>), d: priorityPoint ? minDistanceSqToPoint(t, priorityPoint) : 0 }))
        .sort((a, b) => (b.f - a.f) || (a.d - b.d))
        .map((r) => r.t)
    : priorityPoint
    ? [...tracks].sort(
        (a, b) => minDistanceSqToPoint(a, priorityPoint) - minDistanceSqToPoint(b, priorityPoint),
      )
    : [...tracks];
  const kept = ranked.slice(0, maxActors);
  const keptIds = new Set(kept.map((t) => t.id));
  const dropped = tracks
    .filter((t) => !keptIds.has(t.id))
    .map<DroppedTrack>((t) => ({ id: t.id, reason: "over_cap" }));
  // Preserve input order for determinism of the emitted actor list.
  const order = new Map(tracks.map((t, i) => [t.id, i] as const));
  kept.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Waypoint resampling
// ---------------------------------------------------------------------------

function headingDeltaDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Reduce a dense (10 Hz) track to schedule waypoints:
 *  - always keep first and last samples;
 *  - keep a sample when the cadence elapses OR heading/speed change enough
 *    (turns and braking keep detail, cruising thins out);
 *  - collapse stationary runs (queue holds) to their two endpoints — a
 *    coincident pair with elapsed time IS the hold under `schedule`;
 *  - uniformly decimate interior points if still over `maxWaypoints`.
 */
export function resampleTrack(
  samples: SumoFcdSample[],
  opts: {
    cadenceS: number;
    headingEpsDeg: number;
    speedEpsMps: number;
    maxWaypoints: number;
    maxPathDeviationM?: number;
  },
): SumoFcdSample[] {
  if (samples.length <= 2) return [...samples];
  const kept: SumoFcdSample[] = [samples[0]!];
  let anchor = samples[0]!;
  for (let i = 1; i < samples.length - 1; i += 1) {
    const s = samples[i]!;
    const dt = s.t - anchor.t;
    if (
      dt >= opts.cadenceS ||
      headingDeltaDeg(s.angle_deg, anchor.angle_deg) >= opts.headingEpsDeg ||
      Math.abs(s.speed - anchor.speed) >= opts.speedEpsMps
    ) {
      kept.push(s);
      anchor = s;
    }
  }
  kept.push(samples[samples.length - 1]!);

  // Collapse stationary runs to hold pairs (first + last member of the run —
  // a coincident pair with elapsed time IS the hold under `schedule`). A run
  // that reaches the end of the track is closed there, so a vehicle queued
  // through clip end — or parked for the whole clip — keeps its terminal hold
  // point instead of degenerating to a single sample.
  const collapsed: SumoFcdSample[] = [];
  let runStart = -1;
  const isStationary = (a: SumoFcdSample, b: SumoFcdSample) =>
    Math.hypot(a.x - b.x, a.y - b.y) < HOLD_EPS_M;
  for (let i = 0; i < kept.length; i += 1) {
    if (runStart >= 0) {
      if (isStationary(kept[runStart]!, kept[i]!)) {
        if (i === kept.length - 1) collapsed.push(kept[i]!); // close at track end
        continue;
      }
      // close the run: keep its first and last members
      const runEnd = i - 1;
      if (runEnd > runStart) collapsed.push(kept[runEnd]!);
      runStart = -1;
    }
    collapsed.push(kept[i]!);
    if (i + 1 < kept.length && isStationary(kept[i]!, kept[i + 1]!)) runStart = i;
  }

  // Geometric fidelity bound: heading/speed triggers miss shallow highway
  // lane changes, and the flattened chord drives through the adjacent lane.
  // Re-insert the worst-deviating original sample per segment until the
  // polyline stays within maxPathDeviationM of the source track (or the cap
  // is reached — the cap stays the hard spawn-cost bound).
  const refined = collapsed;
  if (opts.maxPathDeviationM != null && samples.length > 2) {
    const devSq = opts.maxPathDeviationM * opts.maxPathDeviationM;
    const byTime = samples;
    let guard = 0;
    while (refined.length < opts.maxWaypoints && guard < 64) {
      guard += 1;
      let worstIdx = -1;
      let worstD = devSq;
      let insertAt = -1;
      let seg = 0;
      for (let i = 0; i < byTime.length; i += 1) {
        const s0 = byTime[i]!;
        while (seg < refined.length - 2 && refined[seg + 1]!.t <= s0.t) seg += 1;
        const a = refined[seg]!;
        const b = refined[seg + 1]!;
        if (s0.t <= a.t || s0.t >= b.t) continue;
        const d = distanceToSegmentSq(s0.x, s0.y, a.x, a.y, b.x, b.y);
        if (d > worstD) {
          worstD = d;
          worstIdx = i;
          insertAt = seg + 1;
        }
      }
      if (worstIdx < 0) break;
      refined.splice(insertAt, 0, byTime[worstIdx]!);
    }
  }

  if (refined.length <= opts.maxWaypoints) return refined;
  // Uniform interior decimation, endpoints pinned.
  const result: SumoFcdSample[] = [refined[0]!];
  const interior = refined.slice(1, -1);
  const budget = opts.maxWaypoints - 2;
  for (let i = 0; i < budget; i += 1) {
    result.push(interior[Math.floor((i * interior.length) / budget)]!);
  }
  result.push(refined[refined.length - 1]!);
  return result;
}

// ---------------------------------------------------------------------------
// Actor assembly
// ---------------------------------------------------------------------------

function meanMovingSpeedKph(samples: SumoFcdSample[]): number {
  const moving = samples.filter((s) => s.speed > 0.5);
  if (moving.length === 0) return 0;
  return (moving.reduce((acc, s) => acc + s.speed, 0) / moving.length) * 3.6;
}

/** Build ONE background timed-path actor draft from a (already centered,
 * windowed) track. Pure; exported for tests. */
export function buildAmbientActorDraft(
  track: SumoVehicleTrack,
  opts: { seed: number },
): ScenarioEditorActorDraft {
  const first = track.samples[0]!;
  // No `snap` field: absent and "free" are runtime-identical (the worker only
  // tests snap=="lane"), but the behavior compile builds the base clip's
  // waypoints WITHOUT snap while preserving the actor-level copy verbatim —
  // and the worker's compiled-field consistency check compares the two on
  // every runtime field including snap, so emitting "free" here fails every
  // spec with actor_compiled_field_mismatch.
  const waypoints: ScenarioEditorTimedWaypoint[] = track.samples.slice(1).map((s) => ({
    x: Number(s.x.toFixed(3)),
    y: Number(s.y.toFixed(3)),
    time: Number(s.t.toFixed(3)),
  }));
  // If the vehicle enters late (fringe hold), materialize the hold explicitly:
  // spawn at the entry point, first waypoint = same point at entry time.
  if (first.t > 0.05) {
    waypoints.unshift({
      x: Number(first.x.toFixed(3)),
      y: Number(first.y.toFixed(3)),
      time: Number(first.t.toFixed(3)),
    });
  }
  return {
    id: `${SUMO_AMBIENT_ID_PREFIX}${track.id}`,
    label: `SUMO ambient ${track.id}`,
    kind: "vehicle",
    role: "traffic",
    is_static: false,
    placement_mode: "timed_path",
    blueprint: blueprintForVtype(track.vtype, track.id, opts.seed),
    // Stub anchor (walker-emit precedent): world placement is authoritative;
    // persisting road ids is forbidden by the world_anchor doctrine.
    spawn: { road_id: "", s_fraction: 0.5, lane_id: null, section_id: null },
    spawn_point: { x: Number(first.x.toFixed(3)), y: Number(first.y.toFixed(3)) },
    spawn_yaw: Number(sumoAngleToRuntimeYawDeg(first.angle_deg).toFixed(2)),
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    // Ignored under schedule; stamped for humans reading the spec.
    speed_kph: Number(meanMovingSpeedKph(track.samples).toFixed(1)),
    autopilot: false,
    // Reactivity opt-in (zero new worker code). `anti_plow` alone proved
    // insufficient BY MEASUREMENT (2026-08-08): its scan is stopped-vehicles
    // only, and the dominant residual collision was a follower catching a
    // late-running SLOW lead (schedule-pursuit lateness up to ~10 s) — a
    // moving obstacle the narrow scan never sees. 15 ambient collisions/24
    // scenes with anti_plow armed; `reactive_braking` (the wide moving-target
    // scan, actor_control.py `_route_obstacle_gap`) covers it. Schedule
    // fidelity degrades only when the brake actually fires, and the schedule
    // controller's bounded catch-up + lateness telemetry report it.
    anti_plow: true,
    reactive_braking: true,
    timed_waypoints: waypoints,
    path_timing: "schedule",
    timeline: [],
    path_placement: [],
    sensors: [],
    notes: `sumo-ambient vtype=${track.vtype}`,
  } as unknown as ScenarioEditorActorDraft;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export class SumoFrameMismatchError extends Error {
  report: FrameAlignmentReport;
  constructor(report: FrameAlignmentReport) {
    super(
      `SUMO trajectory frame check failed: as-is median ${report.asIsMedianM}m, ` +
        `flipped ${report.flippedMedianM}m (verdict: ${report.verdict}). ` +
        `Expected a decisive as-is fit — was netconvert run with ` +
        `--offset.disable-normalization true against THIS map's XODR?`,
    );
    this.report = report;
  }
}

/** Thrown when a conversion is attempted without the inputs its safety gates
 * need. FAIL-CLOSED by design: skipping the frame gate would let a y-flipped
 * or wrong-map net emit traffic that drives through buildings, and skipping
 * the map-edge policy would keep interior-disappearing tracks as frozen cars
 * mid-road. A caller that cannot supply these must fall back to the
 * procedural fill instead of converting blind. */
export class SumoConversionContractError extends Error {}

/** SUMO trajectory file → background ambient actor drafts + audit report. */
export function buildSumoAmbientActors(
  file: SumoTrajectoryFile,
  options: SumoAmbientOptions,
): SumoAmbientResult {
  const opts = { ...SUMO_AMBIENT_DEFAULTS, ...options };
  const lengths = { ...DEFAULT_VTYPE_LENGTHS_M, ...(file.vtype_lengths_m ?? {}) };

  // 0. Input contract — FAIL CLOSED. Both gates exist to stop silent disasters,
  // so a conversion without their inputs must be an error, not a quieter run.
  if (!opts.referenceLanes || opts.referenceLanes.length === 0) {
    throw new SumoConversionContractError(
      "buildSumoAmbientActors requires referenceLanes: the empirical frame gate " +
        "is mandatory (a y-flipped or wrong-map net must fail, not emit).",
    );
  }
  if (!opts.netBounds) {
    throw new SumoConversionContractError(
      "buildSumoAmbientActors requires netBounds: without the map-edge policy an " +
        "interior-disappearing track is kept and freezes mid-road.",
    );
  }

  // 1. Front-bumper → center shift (before any geometry checks).
  const centered: SumoVehicleTrack[] = file.vehicles.map((v) => ({
    ...v,
    samples: shiftFrontBumperToCenter(v.samples, lengths[v.vtype] ?? opts.defaultVehicleLengthM),
  }));

  // 2. Empirical frame gate.
  const frame: FrameAlignmentReport = verifyFrameAlignment(centered, opts.referenceLanes);
  if (frame.verdict !== "as-is" || frame.asIsMedianM > opts.frameGateMaxMedianM) {
    throw new SumoFrameMismatchError(frame);
  }

  // 3. Window + map-edge policy, de-overlap, cap.
  const dejumped = dropTeleportTracks(centered, opts.maxPlausibleSpeedMps);
  const windowed = filterTracksForWindow(dejumped.kept, {
    clipDurationS: opts.clipDurationS,
    minPresenceS: opts.minPresenceS,
    edgeMarginM: opts.edgeMarginM,
    netBounds: opts.netBounds,
    ...(opts.netBoundaryPoints ? { netBoundaryPoints: opts.netBoundaryPoints } : {}),
  });
  // Streaming-bubble guard. The streamed world FOLLOWS the subject: an actor is
  // safe only while its distance to the subject stays inside the streamed radius
  // AT EVERY MOMENT — a spawn-only check let trailing actors fall once the
  // subject drove away (measured falls at 328-430 m subject distance mid-clip, after
  // the spawn-radius-only first fix). With a planned subject corridor the check
  // is time-synchronized; without one it degrades to the spawn-vs-priority
  // check (better than nothing, spawn-time only).
  // Establishment window: the guard is time-synchronized only over the first
  // seconds of the clip. Checking the WHOLE clip drops every diverging track
  // (an oncoming car recedes ~20 m/s relative and exceeds any radius by
  // mid-clip — measured: scenes fell to 0 ambient), while a departure late in
  // the clip falls far BEHIND the trailing camera, off-screen and
  // verdict-clean. Spawn plus the first seconds is what the camera can see.
  const BUBBLE_ESTABLISH_S = 6;
  let bubble = windowed.kept;
  const bubbleDropped: DroppedTrack[] = [];
  if (opts.maxSpawnDistanceM != null && (opts.subjectCorridor?.length || opts.priorityPoint)) {
    const maxSq = opts.maxSpawnDistanceM * opts.maxSpawnDistanceM;
    const corridor = opts.subjectCorridor && opts.subjectCorridor.length > 1 ? opts.subjectCorridor : null;
    const subjectAt = (t: number): { x: number; y: number } | null => {
      if (!corridor) return opts.priorityPoint ?? null;
      if (t <= corridor[0]!.t) return corridor[0]!;
      const last = corridor[corridor.length - 1]!;
      if (t >= last.t) return last;
      for (let i = 1; i < corridor.length; i += 1) {
        const a = corridor[i - 1]!;
        const b = corridor[i]!;
        if (t <= b.t) {
          const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        }
      }
      return last;
    };
    bubble = [];
    for (const track of windowed.kept) {
      // ARRIVALS ARE TRIMMED, NOT DROPPED (dib v0 review loop): an upstream
      // vehicle that enters the bubble mid-clip is exactly the traffic the
      // camera wants — dropping it emptied the med scenes (38-80 drops per
      // window measured) while its fall risk exists only OUTSIDE the bubble.
      // Trimming to the entry moment materialises it as a short hold at the
      // bubble boundary (~the guard radius from the subject, off-camera, on-road)
      // that then flows past the camera with the traffic. A track that never
      // enters the bubble — or enters with less than the minimum presence
      // left — still drops.
      let entryIdx = -1;
      let inside = true;
      for (let i = 0; i < track.samples.length; i += 5) {
        const s0 = track.samples[i]!;
        const e = subjectAt(s0.t);
        if (!e) break;
        const dSq = (s0.x - e.x) ** 2 + (s0.y - e.y) ** 2;
        if (dSq <= maxSq) {
          if (entryIdx < 0) entryIdx = i;
        } else if (s0.t <= BUBBLE_ESTABLISH_S || entryIdx < 0) {
          // outside during establishment (or has not entered yet)
          if (entryIdx < 0) inside = false;
          else if (s0.t <= BUBBLE_ESTABLISH_S) {
            // entered then left again during establishment — treat the later
            // entry as authoritative: reset and keep scanning.
            entryIdx = -1;
            inside = false;
          }
        }
        if (!corridor) break;
      }
      const last = track.samples[track.samples.length - 1]!;
      if (entryIdx < 0) {
        bubbleDropped.push({
          id: track.id,
          reason: "spawn_beyond_bubble",
          detail: `never enters ${opts.maxSpawnDistanceM}m of the subject corridor`,
        });
        continue;
      }
      const entryT = track.samples[entryIdx]!.t;
      if (last.t - entryT < opts.minPresenceS) {
        bubbleDropped.push({
          id: track.id,
          reason: "spawn_beyond_bubble",
          detail: `enters bubble at t=${entryT.toFixed(1)} with <${opts.minPresenceS}s left`,
        });
        continue;
      }
      bubble.push(
        entryIdx === 0 ? track : { ...track, samples: track.samples.slice(entryIdx) },
      );
      void inside;
    }
  }
  const cleared = deoverlapTracks(bubble, opts.keepClearPoints ?? [], opts.spawnClearanceM);
  // ...and against each other, or two ambient cars can materialise in the same
  // spot and eject on the first physics tick.
  //
  // The mutual clearance is deliberately LARGER than the scenario-actor one.
  // `spawnClearanceM` defaults to 6 m, mirroring TRAFFIC_CAUSE_CLEARANCE_M —
  // but that is a car length, and the ambient mix contains a 5.9 m van and a
  // 6.5 m truck. Two 6.5 m vehicles 6 m apart centre-to-centre are physically
  // interpenetrating, which is why a first pass at 6 m still produced 7-8
  // dressing spawn overlaps and ambient collisions in the 2D gate. The floor
  // below clears the longest pair in the mix plus a buffer.
  const mutual = deoverlapTracksMutually(
    cleared.kept,
    Math.max(opts.spawnClearanceM, MUTUAL_SPAWN_CLEARANCE_FLOOR_M),
  );
  // Emit-time subject-corridor safety: drop any ambient track that meets the
  // PLANNED subject corridor at the same scene time. The ambient is open-loop
  // toward scripted actors, so this is the converter-side guard for the
  // subject-drives-into-fixed-stream class (the 2D gate remains the backstop).
  let corridorCleared = mutual.kept;
  const corridorDropped: DroppedTrack[] = [];
  if (opts.subjectCorridor && opts.subjectCorridor.length > 1) {
    const report = corridorConflictCheck(opts.subjectCorridor, mutual.kept, {
      clearanceM: opts.subjectCorridorClearanceM ?? 5,
    });
    if (report.conflicts.length > 0) {
      const conflictById = new Map(report.conflicts.map((c) => [c.ambientId, c] as const));
      corridorCleared = mutual.kept.filter((t) => !conflictById.has(t.id));
      for (const [id, c] of conflictById) {
        corridorDropped.push({
          id,
          reason: "corridor_conflict",
          detail: `${c.minSeparationM.toFixed(1)}m from subject at t=${c.atTimeS.toFixed(1)}`,
        });
      }
    }
  }
  // Same check against every OTHER scripted trajectory (conflict NPC, conflict
  // walker, cyclist stream). In a conflict family the tune loop's only lever
  // is a time shift of the conflict actor, so an ambient track that meets a
  // scripted actor is unfixable downstream (task #76, measured: a forced
  // -3 s retime left the subject-ambient collision byte-identical). Checked before
  // the cap so a doomed track never spends an actor slot.
  let scriptedCleared = corridorCleared;
  const scriptedDropped: DroppedTrack[] = [];
  if (opts.scriptedCorridors && opts.scriptedCorridors.length > 0) {
    for (const corridor of opts.scriptedCorridors) {
      if (!corridor.samples || corridor.samples.length < 2) continue;
      const report = corridorConflictCheck(corridor.samples, scriptedCleared, {
        clearanceM: corridor.clearanceM ?? opts.subjectCorridorClearanceM ?? 5,
      });
      if (report.conflicts.length === 0) continue;
      const conflictById = new Map(report.conflicts.map((c) => [c.ambientId, c] as const));
      scriptedCleared = scriptedCleared.filter((t) => !conflictById.has(t.id));
      for (const [id, c] of conflictById) {
        scriptedDropped.push({
          id,
          reason: "scripted_corridor_conflict",
          detail:
            `${c.minSeparationM.toFixed(1)}m from ${corridor.actorId}` +
            ` at t=${c.atTimeS.toFixed(1)}`,
        });
      }
    }
  }
  const capped = capTracks(
    scriptedCleared,
    opts.maxActors,
    opts.priorityPoint,
    opts.subjectCorridor,
  );

  // 4. Resample + assemble.
  let holdSegments = 0;
  let waypointTotal = 0;
  let waypointMaxPerActor = 0;
  const actors = capped.kept.map((track) => {
    const resampled = resampleTrack(track.samples, {
      cadenceS: opts.waypointCadenceS,
      headingEpsDeg: opts.headingEpsDeg,
      speedEpsMps: opts.speedEpsMps,
      maxWaypoints: opts.maxWaypointsPerActor,
      maxPathDeviationM: opts.maxPathDeviationM,
    });
    for (let i = 1; i < resampled.length; i += 1) {
      const d = Math.hypot(
        resampled[i]!.x - resampled[i - 1]!.x,
        resampled[i]!.y - resampled[i - 1]!.y,
      );
      if (d < HOLD_EPS_M) holdSegments += 1;
    }
    waypointTotal += resampled.length;
    waypointMaxPerActor = Math.max(waypointMaxPerActor, resampled.length);
    return buildAmbientActorDraft({ ...track, samples: resampled }, { seed: opts.seed });
  });

  return {
    actors,
    dropped: [
      ...dejumped.dropped,
      ...windowed.dropped,
      ...bubbleDropped,
      ...cleared.dropped,
      ...mutual.dropped,
      ...corridorDropped,
      ...scriptedDropped,
      ...capped.dropped,
    ],
    frame,
    stats: {
      inputVehicles: file.vehicles.length,
      emitted: actors.length,
      waypointTotal,
      waypointMaxPerActor,
      holdSegments,
    },
  };
}

// ---------------------------------------------------------------------------
// Corridor conflict check (2D tune-loop companion)
// ---------------------------------------------------------------------------

export interface CorridorConflict {
  ambientId: string;
  /** Scene time of closest approach (s). */
  atTimeS: number;
  /** Time-synchronized closest approach (m). */
  minSeparationM: number;
}

export interface CorridorConflictReport {
  conflicts: CorridorConflict[];
  /** Tracks whose PATH passes within clearance of the subject path ignoring time —
   * the upper bound of "reactivity could ever matter here". */
  pathOnlyCrossingIds: string[];
}

function interpAt(samples: SumoFcdSample[], t: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (t < samples[0]!.t || t > samples[samples.length - 1]!.t) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.t - a.t;
  const f = span <= 1e-9 ? 0 : (t - a.t) / span;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Time-synchronized clearance between a (possibly retimed) scenario-actor
 * trajectory and every ambient track. Run AFTER the 2D tune loop retimes
 * scenario actors: `subjectTimeShiftS` is the retime delta, so the loop can ask
 * "does the shifted subject now meet the fixed ambient stream?" without
 * re-simulating anything. Conflicted ambient actors are droppable dressing
 * (`bg-` prefix); alternatively re-sample the SUMO window at a shifted t0. */
export function corridorConflictCheck(
  subjectSamples: Array<{ t: number; x: number; y: number }>,
  tracks: SumoVehicleTrack[],
  opts: { clearanceM?: number; subjectTimeShiftS?: number; gridS?: number } = {},
): CorridorConflictReport {
  const clearanceM = opts.clearanceM ?? 5;
  const shiftS = opts.subjectTimeShiftS ?? 0;
  const gridS = opts.gridS ?? 0.5;
  const conflicts: CorridorConflict[] = [];
  const pathOnlyCrossingIds: string[] = [];
  const clearanceSq = clearanceM * clearanceM;
  const subject = subjectSamples
    .map((s) => ({ t: s.t + shiftS, x: s.x, y: s.y, speed: 0, angle_deg: 0 }))
    .sort((a, b) => a.t - b.t);
  for (const track of tracks) {
    // Path-only crossing (time-blind upper bound).
    let crossesPath = false;
    for (let i = 0; i < track.samples.length && !crossesPath; i += 4) {
      const p = track.samples[i]!;
      for (let j = 0; j < subject.length; j += 4) {
        const q = subject[j]!;
        if ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) < clearanceSq) {
          crossesPath = true;
          break;
        }
      }
    }
    if (crossesPath) pathOnlyCrossingIds.push(track.id);

    // Time-synchronized closest approach on a common grid.
    const t0 = Math.max(subject[0]?.t ?? 0, track.samples[0]?.t ?? 0);
    const t1 = Math.min(
      subject[subject.length - 1]?.t ?? 0,
      track.samples[track.samples.length - 1]?.t ?? 0,
    );
    let best = Infinity;
    let bestT = t0;
    for (let t = t0; t <= t1; t += gridS) {
      const pe = interpAt(subject, t);
      const pa = interpAt(track.samples, t);
      if (!pe || !pa) continue;
      const d = (pe.x - pa.x) * (pe.x - pa.x) + (pe.y - pa.y) * (pe.y - pa.y);
      if (d < best) {
        best = d;
        bestT = t;
      }
    }
    if (best < clearanceSq) {
      conflicts.push({
        ambientId: track.id,
        atTimeS: Number(bestT.toFixed(2)),
        minSeparationM: Number(Math.sqrt(best).toFixed(2)),
      });
    }
  }
  return { conflicts, pathOnlyCrossingIds };
}

/** Pick the SUMO vehicle best suited to serve as the DEMO subject: present for the
 * whole clip, travels the farthest (a through-driver, not a parked queue), and
 * spends the least time at the boundary. Pure; used only by the demo emitter —
 * production scenarios keep their own generated egos. */
export function pickDemoEgoTrack(
  tracks: SumoVehicleTrack[],
  clipDurationS: number,
): SumoVehicleTrack | null {
  let best: SumoVehicleTrack | null = null;
  let bestScore = -Infinity;
  for (const track of tracks) {
    if (track.samples.length < 2) continue;
    const first = track.samples[0]!;
    const last = track.samples[track.samples.length - 1]!;
    if (first.t > 0.5 || last.t < clipDurationS - 0.5) continue; // full presence only
    let dist = 0;
    for (let i = 1; i < track.samples.length; i += 1) {
      dist += Math.hypot(
        track.samples[i]!.x - track.samples[i - 1]!.x,
        track.samples[i]!.y - track.samples[i - 1]!.y,
      );
    }
    if (dist > bestScore) {
      bestScore = dist;
      best = track;
    }
  }
  return best;
}
