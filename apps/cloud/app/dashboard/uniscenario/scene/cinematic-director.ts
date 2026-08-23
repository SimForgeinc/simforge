import type { CameraView } from "@uniscenarios/city-renderer";
import type { DashCameraSensor } from "@uniscenarios/scenario-model";
import {
  allActorsCameraView,
  buildAllActorsCameraPlan,
  buildIncidentCameraPlan,
  dashCameraFrame,
  samplePlaybackActors,
  type IncidentCameraPlan,
  type PlaybackBundle,
  type SampledActor,
} from "@uniscenarios/playback";
import { interpolateMapView } from "./map-camera-transition";

/**
 * The list-view cinematic director.
 *
 * ## Why this is a shot list and not a camera policy
 *
 * `PlaybackController` already owns four camera policies, and every one of them
 * is a single sustained composition: `all-actors` frames the authored bounds,
 * `subject-chase` trails one actor, `dash-camera` sits in the windscreen. None
 * of them cuts. The cinematic look the mass-generation CLI produces comes from
 * somewhere else entirely — `scripts/export-render.mjs` in the UniScenarios
 * repository re-solves the camera *per frame* from the incident sightline
 * (`cameraForIncident`), freezes it at the conflict instant, and orbits the
 * azimuth through `CAMERA_SEARCH_OFFSETS` whenever the city blocks the shot.
 * The result reads as a cut sequence because the solve changes character across
 * the clip, not because a policy changed.
 *
 * So this module keeps the offline solver's geometry and discards its execution
 * model. It is a pure function of the bundle: a list of time-windowed shots,
 * each of which can be evaluated at any playhead. That makes the whole thing
 * deterministic (the same scenario always cuts identically), seekable (scrubbing
 * resolves the shot that owns the instant rather than restarting a timeline),
 * and testable in node with no viewer, no GPU, and no browser.
 *
 * ## Why it cannot reuse the offline shot selection verbatim
 *
 * `selectIncidentFrames` throws unless the trace carries
 * `metrics.revealToConflict`, which only authored-occlusion scenarios have. Most
 * saved simulations in the product do not, so the anchor instant is resolved
 * through a ladder (see `resolveAnchor`) that degrades to plain geometry. A
 * scenario with no metrics at all still gets a defensible cut sequence.
 */

export type CinematicShotKind =
  | "establishing"
  | "subject-chase"
  | "interaction-oblique"
  | "profile-pan"
  | "dash"
  | "aftermath-hold";

export type CinematicAnchorBasis =
  | "reveal-to-conflict"
  | "collision"
  | "min-ttc"
  | "min-distance"
  | "clip-midpoint";

export interface CinematicShot {
  readonly kind: CinematicShotKind;
  readonly label: string;
  readonly startT: number;
  readonly endT: number;
  /** The actor a following shot tracks; `null` for whole-scene compositions. */
  readonly subjectActorId: string | null;
  /** Actors whose bounding radius the composition must contain. */
  readonly framingActorIds: readonly string[];
  /** Rotation applied to the solved shot direction, radians. */
  readonly azimuthOffsetRad: number;
  /** Radians of drift swept across the shot; `0` holds a fixed azimuth. */
  readonly azimuthSweepRad: number;
  /** When set, poses sample this instant instead of the playhead. */
  readonly frozenAtT: number | null;
}

export interface CinematicShotList {
  readonly anchorT: number;
  readonly anchorBasis: CinematicAnchorBasis;
  /** The two actors the interaction shots frame, when the trace names a pair. */
  readonly pair: readonly string[];
  readonly startTime: number;
  readonly endTime: number;
  readonly shots: readonly CinematicShot[];
}

export interface CinematicDashMount {
  readonly actorId: string;
  readonly sensor: DashCameraSensor;
}

export interface CinematicDirectorOptions {
  /** Preferred following subject, normally the sensor-owning actor. */
  readonly subjectActorId?: string | null;
  /** In-car angle source; the dash beat is dropped when absent. */
  readonly dashMount?: CinematicDashMount | null;
}

/** Shortest shot worth cutting to. Below this a cut reads as a glitch. */
export const MIN_SHOT_SECONDS = 1.2;
/** Longest clip that still gets the full six-shot grammar. */
const MAX_SHOTS = 6;
const DASH_SHOT_SECONDS = 1.6;
const PROFILE_SWEEP_RAD = (14 * Math.PI) / 180;
const RIGHT_ANGLE_RAD = Math.PI / 2;

/** Kinds that never drive a composition, however close they sit to the action. */
const AMBIENT_KIND: Readonly<Record<string, true>> = { static_object: true };

const SHOT_LABELS: Readonly<Record<CinematicShotKind, string>> = {
  establishing: "Establishing",
  "subject-chase": "Trailing",
  "interaction-oblique": "Interaction",
  "profile-pan": "Profile",
  dash: "In-car",
  "aftermath-hold": "Aftermath",
};

/**
 * Resolve the instant the sequence builds toward.
 *
 * Ordered by how directly the trace states it. `revealToConflict` is an authored
 * relation, a collision is recorded fact, `minTTC` and `minDistance` are derived
 * observations, and the midpoint is the honest answer for a scenario in which
 * nothing measurable happens. The pair travels with the instant because every
 * interaction composition frames it.
 */
export function resolveAnchor(bundle: PlaybackBundle): {
  anchorT: number;
  anchorBasis: CinematicAnchorBasis;
  pair: readonly string[];
} {
  const metrics = bundle.trace.metrics;
  const clamp = (value: number) => Math.max(bundle.startTime, Math.min(bundle.endTime, value));

  const reveal = metrics?.revealToConflict;
  if (reveal && Number.isFinite(reveal.conflictT)) {
    return { anchorT: clamp(reveal.conflictT), anchorBasis: "reveal-to-conflict", pair: [...reveal.pair] };
  }

  const collisions = metrics?.collisions ?? [];
  const firstCollision = collisions
    .filter((collision) => Number.isFinite(collision.t))
    .sort((left, right) => left.t - right.t)[0];
  if (firstCollision) {
    return { anchorT: clamp(firstCollision.t), anchorBasis: "collision", pair: [firstCollision.a, firstCollision.b] };
  }

  const minTtc = metrics?.minTTC;
  if (minTtc && Number.isFinite(minTtc.t)) {
    return { anchorT: clamp(minTtc.t), anchorBasis: "min-ttc", pair: [...minTtc.pair] };
  }

  const closest = (metrics?.minDistance ?? [])
    .filter((entry) => Number.isFinite(entry.t) && Number.isFinite(entry.minDistanceM))
    .sort((left, right) => left.minDistanceM - right.minDistanceM)[0];
  if (closest) {
    return { anchorT: clamp(closest.t), anchorBasis: "min-distance", pair: [...closest.pair] };
  }

  return {
    anchorT: clamp(bundle.startTime + (bundle.endTime - bundle.startTime) * 0.62),
    anchorBasis: "clip-midpoint",
    pair: [],
  };
}

/**
 * The vendored incident solve, or `null` when it cannot run.
 *
 * `buildIncidentCameraPlan` indexes tick tracks directly and throws on evidence
 * whose tracks are shorter than its header claims. A preview camera is not worth
 * taking the scenario list down for: an unusable plan degrades this surface to
 * the pair-derived framing, and a bundle that cannot be directed at all falls
 * back to the existing single-actor pose.
 */
function incidentPlan(bundle: PlaybackBundle): IncidentCameraPlan | null {
  try {
    return buildIncidentCameraPlan(bundle);
  } catch {
    return null;
  }
}

/** Actors that may drive a composition; ambient props never shrink a shot. */
function framingActorIds(bundle: PlaybackBundle, pair: readonly string[]): readonly string[] {
  const incident = incidentPlan(bundle);
  if (incident && incident.actorIds.length > 0) return incident.actorIds;
  const present = new Set(bundle.actors.filter((actor) => !actor.static && !AMBIENT_KIND[actor.kind]).map((actor) => actor.id));
  const fromPair = pair.filter((id) => present.has(id));
  if (fromPair.length > 0) return fromPair;
  return [...present];
}

/** Fastest non-static vehicle, used when nothing designates a subject. */
function fallbackSubjectActorId(bundle: PlaybackBundle, framing: readonly string[]): string | null {
  const candidates = framing.length > 0 ? framing : bundle.actors.map((actor) => actor.id);
  const vehicles = bundle.actors.filter(
    (actor) => candidates.includes(actor.id) && !actor.static && !AMBIENT_KIND[actor.kind],
  );
  if (vehicles.length === 0) return null;
  const ranked = [...vehicles].sort((left, right) => {
    const size = Math.max(right.dims.l, right.dims.w) - Math.max(left.dims.l, left.dims.w);
    return size !== 0 ? size : left.id.localeCompare(right.id);
  });
  return ranked[0]?.id ?? null;
}

/**
 * Whether a bundle carries enough motion to direct.
 *
 * The camera is solved from sampled poses, so a trace with a single tick or with
 * tracks shorter than its tick vector has nothing to follow. Both shapes exist:
 * an interrupted compile writes the former, and imported legacy evidence has
 * produced the latter. Rejecting them here is what keeps the vendored solvers —
 * which index those arrays without checking — off a malformed trace.
 */
function directable(bundle: PlaybackBundle): boolean {
  const times = bundle.trace.ticks.t;
  if (!Array.isArray(times) || times.length < 2) return false;
  return Object.values(bundle.trace.ticks.actors).every(
    (track) => track.x.length >= times.length
      && track.z.length >= times.length
      && track.present.length >= times.length,
  );
}

/**
 * Solve the cut sequence for one bundle.
 *
 * Shots are laid out as proportions of the clip and then trimmed: anything left
 * shorter than `MIN_SHOT_SECONDS` is dropped and its time handed to the
 * neighbour, shortest first, until every surviving shot is long enough. A clip
 * too short for two shots gets one sustained interaction composition rather
 * than a sequence of flashes.
 */
export function buildCinematicShotList(
  bundle: PlaybackBundle,
  options: CinematicDirectorOptions = {},
): CinematicShotList | null {
  const startTime = bundle.startTime;
  const endTime = bundle.endTime;
  const duration = endTime - startTime;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!directable(bundle)) return null;

  const { anchorT, anchorBasis, pair } = resolveAnchor(bundle);
  const framing = framingActorIds(bundle, pair);
  if (framing.length === 0) return null;
  const subjectActorId = options.subjectActorId && framing.includes(options.subjectActorId)
    ? options.subjectActorId
    : (options.subjectActorId ?? fallbackSubjectActorId(bundle, framing));
  const dashMount = options.dashMount ?? null;

  const anchor = Math.max(startTime, Math.min(endTime, anchorT));
  // Everything before the anchor is build-up and everything after is
  // consequence, so the anchor — not the clip midpoint — is what the proportions
  // are measured against.
  const buildUp = anchor - startTime;

  type Draft = { kind: CinematicShotKind; startT: number; endT: number; subjectActorId: string | null; azimuthOffsetRad: number; azimuthSweepRad: number; frozenAtT: number | null };
  const drafts: Draft[] = [];
  const push = (kind: CinematicShotKind, startT: number, endT: number, extra: Partial<Draft> = {}) => {
    if (endT - startT <= 0) return;
    drafts.push({
      kind,
      startT,
      endT,
      subjectActorId: extra.subjectActorId ?? null,
      azimuthOffsetRad: extra.azimuthOffsetRad ?? 0,
      azimuthSweepRad: extra.azimuthSweepRad ?? 0,
      frozenAtT: extra.frozenAtT ?? null,
    });
  };

  // Build-up: establishing wide, trailing chase, side profile, then the optional
  // in-car beat immediately before the anchor. The dash window is *reserved* out
  // of the build-up rather than carved from its tail — proportional layout alone
  // left it under the cut floor on a normal-length clip, so it was absorbed by
  // its neighbour and the angle silently never appeared.
  const dashReserve = dashMount ? Math.min(DASH_SHOT_SECONDS, buildUp) : 0;
  const preAnchor = Math.max(0, buildUp - dashReserve);
  const establishingEnd = startTime + preAnchor * 0.34;
  const chaseEnd = startTime + preAnchor * 0.7;
  const dashStart = startTime + preAnchor;

  push("establishing", startTime, establishingEnd);
  push("subject-chase", establishingEnd, chaseEnd, { subjectActorId });
  push("profile-pan", chaseEnd, dashStart, {
    azimuthOffsetRad: RIGHT_ANGLE_RAD,
    azimuthSweepRad: PROFILE_SWEEP_RAD,
  });
  if (dashMount) push("dash", dashStart, anchor, { subjectActorId: dashMount.actorId });
  push("interaction-oblique", anchor, Math.min(endTime, anchor + Math.max(0, (endTime - anchor) * 0.4)));
  push("aftermath-hold", Math.min(endTime, anchor + Math.max(0, (endTime - anchor) * 0.4)), endTime, {
    frozenAtT: anchor,
  });

  const shots = trimShots(drafts, startTime, endTime).slice(0, MAX_SHOTS).map((draft) => ({
    ...draft,
    label: SHOT_LABELS[draft.kind],
    framingActorIds: framing,
  }));
  if (shots.length === 0) return null;

  return { anchorT: anchor, anchorBasis, pair, startTime, endTime, shots };
}

/**
 * Drop shots that cannot hold the screen, giving their time to the previous
 * survivor so the sequence stays gapless and still covers the clip exactly.
 */
function trimShots<T extends { startT: number; endT: number }>(
  drafts: readonly T[],
  startTime: number,
  endTime: number,
): T[] {
  const ordered = [...drafts].sort((left, right) => left.startT - right.startT);
  const kept: T[] = [];
  for (const draft of ordered) {
    const previous = kept[kept.length - 1];
    const from = previous ? previous.endT : startTime;
    const span = draft.endT - from;
    if (span < MIN_SHOT_SECONDS && previous) {
      // Absorb into the predecessor rather than cutting to a flash frame.
      kept[kept.length - 1] = { ...previous, endT: draft.endT };
      continue;
    }
    kept.push({ ...draft, startT: from });
  }
  if (kept.length === 0) return [];
  const last = kept[kept.length - 1]!;
  kept[kept.length - 1] = { ...last, endT: endTime };
  return kept;
}

/** The shot that owns an instant; the final shot owns the clip's end. */
export function shotAt(shotList: CinematicShotList, time: number): CinematicShot {
  const shots = shotList.shots;
  for (const shot of shots) {
    if (time >= shot.startT && time < shot.endT) return shot;
  }
  return time < shots[0]!.startT ? shots[0]! : shots[shots.length - 1]!;
}

/** Normalized progress through the owning shot, `0..1`. */
export function shotProgress(shot: CinematicShot, time: number): number {
  const span = shot.endT - shot.startT;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (time - shot.startT) / span));
}

function presentPoses(
  actors: readonly SampledActor[],
  ids: readonly string[],
): SampledActor[] {
  const wanted = new Set(ids);
  const present = actors.filter((actor) => actor.present && wanted.has(actor.id));
  return present.length > 0 ? present : actors.filter((actor) => actor.present);
}

function centroid(poses: readonly SampledActor[]): { x: number; z: number; radius: number } {
  const x = poses.reduce((sum, pose) => sum + pose.x, 0) / poses.length;
  const z = poses.reduce((sum, pose) => sum + pose.z, 0) / poses.length;
  const radius = Math.max(...poses.map((pose) => Math.hypot(pose.x - x, pose.z - z)));
  return { x, z, radius };
}

/**
 * Direction the interaction shots look from, unit length.
 *
 * `buildIncidentCameraPlan` already derives this from the complete verified
 * trace, which is the same quantity `cameraForIncident` calls the sightline. The
 * pair fallback recomputes it from two poses, and a lone actor is shot from
 * behind its own heading.
 */
function shotDirection(
  bundle: PlaybackBundle,
  shotList: CinematicShotList,
  poses: readonly SampledActor[],
): { x: number; z: number } {
  const plan = incidentPlan(bundle);
  if (plan && Number.isFinite(plan.direction.x) && Number.isFinite(plan.direction.z)) {
    const length = Math.hypot(plan.direction.x, plan.direction.z);
    if (length > 1e-6) return { x: plan.direction.x / length, z: plan.direction.z / length };
  }
  const [first, second] = shotList.pair
    .map((id) => poses.find((pose) => pose.id === id))
    .filter((pose): pose is SampledActor => Boolean(pose));
  if (first && second) {
    const length = Math.hypot(first.x - second.x, first.z - second.z);
    if (length > 1e-6) return { x: (first.x - second.x) / length, z: (first.z - second.z) / length };
  }
  const lead = poses[0];
  if (lead) return { x: -Math.cos(lead.headingRad), z: Math.sin(lead.headingRad) };
  return { x: 1, z: 0 };
}

function rotate(direction: { x: number; z: number }, radians: number): { x: number; z: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: direction.x * cos - direction.z * sin, z: direction.x * sin + direction.z * cos };
}

/**
 * The oblique interaction composition.
 *
 * A direct port of the offline `cameraForClip` solve: the stand-off comes from
 * the vertical half-angle with margin so every framing actor projects well
 * inside the viewport, and the elevation is a fixed fraction of that stand-off.
 * Keeping the same arithmetic is the point — it is what makes the in-app shot
 * read like the CLI's output rather than merely similar to it.
 */
function obliqueView(
  poses: readonly SampledActor[],
  direction: { x: number; z: number },
  ground: number,
  fov: number,
): CameraView {
  const { x, z, radius } = centroid(poses);
  const halfAngle = (fov / 2) * (Math.PI / 180);
  const fitDistance = (radius + 6) / (Math.tan(halfAngle) * 0.8);
  const distance = Math.max(16, fitDistance);
  const height = ground + Math.max(7, distance * 0.42);
  const side = { x: -direction.z, z: direction.x };
  return {
    position: [
      x + direction.x * distance + side.x * (distance * 0.12),
      height,
      z + direction.z * distance + side.z * (distance * 0.12),
    ],
    target: [x, ground + 1.35, z],
    fov,
  };
}

/** Trailing rig scaled to the subject's own box. */
function chaseView(subject: SampledActor, ground: number): CameraView {
  const size = Math.max(subject.dims.l, subject.dims.w);
  const distance = Math.max(10, Math.min(17, size * 2.1));
  const height = Math.max(4.6, Math.min(9, size * 1.15));
  const forwardX = Math.cos(subject.headingRad);
  const forwardZ = Math.sin(subject.headingRad);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  return {
    position: [
      subject.x - forwardX * distance + rightX * distance * 0.32,
      ground + height,
      subject.z - forwardZ * distance + rightZ * distance * 0.32,
    ],
    target: [subject.x + forwardX * 6, ground + 1.4, subject.z + forwardZ * 6],
    fov: 50,
  };
}

function dashView(subject: SampledActor, ground: number, sensor: DashCameraSensor): CameraView {
  const frame = dashCameraFrame(subject, ground, sensor);
  return { position: frame.position, target: frame.target, fov: frame.verticalFovDeg };
}

export interface CinematicViewInput {
  readonly bundle: PlaybackBundle;
  readonly shotList: CinematicShotList;
  readonly time: number;
  /** Terrain height under a point; the flat-world fallback is `0`. */
  readonly sampleGround: (x: number, z: number) => number | null;
  readonly dashMount?: CinematicDashMount | null;
  /** Extra azimuth the clearance search settled on, radians. */
  readonly azimuthBiasRad?: number;
}

/**
 * Evaluate the active shot at a playhead.
 *
 * Pure and total: any finite time yields a view, so the caller can drive this
 * from a render loop or a scrub without special-casing shot boundaries.
 */
export function cinematicViewAt(input: CinematicViewInput): CameraView | null {
  const { bundle, shotList, sampleGround, dashMount } = input;
  const time = Math.max(shotList.startTime, Math.min(shotList.endTime, input.time));
  const shot = shotAt(shotList, time);
  const sampleT = shot.frozenAtT ?? time;
  const actors = samplePlaybackActors(bundle, sampleT);
  const poses = presentPoses(actors, shot.framingActorIds);
  if (poses.length === 0) return null;
  const bias = input.azimuthBiasRad ?? 0;
  const progress = shotProgress(shot, time);

  const groundAt = (x: number, z: number) => sampleGround(x, z) ?? 0;

  if (shot.kind === "subject-chase" || shot.kind === "dash") {
    const subject = actors.find((actor) => actor.id === shot.subjectActorId && actor.present);
    if (subject) {
      const ground = groundAt(subject.x, subject.z);
      if (shot.kind === "dash" && dashMount && dashMount.actorId === subject.id) {
        return dashView(subject, ground, dashMount.sensor);
      }
      if (shot.kind === "subject-chase") return chaseView(subject, ground);
    }
    // A despawned or missing subject must not freeze the camera on empty road.
  }

  const direction = rotate(
    shotDirection(bundle, shotList, poses),
    shot.azimuthOffsetRad + shot.azimuthSweepRad * (progress - 0.5) + bias,
  );
  const { x, z } = centroid(poses);
  const ground = groundAt(x, z);
  const base = obliqueView(poses, direction, ground, shot.kind === "establishing" ? 45 : 42);
  if (shot.kind !== "establishing") return base;
  // Slow push-in: the establishing shot starts wider than its solved framing so
  // the sequence opens with movement instead of a cut into a static plate.
  const plan = buildAllActorsCameraPlan(bundle, shot.framingActorIds);
  const wide = plan ? allActorsCameraView(plan, ground) : base;
  return interpolateMapView(wide, base, progress);
}
