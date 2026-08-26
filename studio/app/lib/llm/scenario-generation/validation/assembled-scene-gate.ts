/**
 * Final assembled-scene plausibility gate (codex review 2026-07-27, finding 1).
 *
 * `validateCollisionDraft` proves the PRINCIPAL conflict in a clean
 * pre-population draft; every mutation after it — path extension, background
 * population, D2 occluder insertion/relocation, parked/walker culls, walker
 * spawn hygiene — reshapes the scene WITHOUT re-validation. This pass lints the
 * final assembled actor list right before stamping:
 *
 *  a. FIRST-FRAME OVERLAP — no two bodies interpenetrate at their initial pose.
 *  b. SUBJECT CORRIDOR — no static dressing vehicle sits inside the subject's driving
 *     corridor (mirrors the worker's 2.2 m wp ambient-corridor guard).
 *  c. PATH SANITY — post-extension timed paths carry ordered times, finite
 *     coords, and no teleport jumps.
 *
 * Repair-first, reject-last (the attrition lesson — over-gating collapsed
 * conversion before): a defect on degradable dressing CULLS that actor and
 * keeps the scene; only a defect on a PRINCIPAL (subject / conflict actor /
 * occluder) rejects the site.
 */
import type { ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";
import {
  boxesOverlap,
  type OrientedBox,
} from "@/app/lib/llm/scenario-generation/validation/kinematic-sim";
import {
  pathClearsObb,
  type ObbFootprint,
} from "@/app/lib/llm/scenario-generation/occluder-clearance";

/** Static-dressing lateral keep-out around the subject's timed_waypoints polyline —
 *  the worker destroys WP-re-stamped ambient inside this band anyway; culling at
 *  authoring time just front-runs it deterministically. */
export const SUBJECT_CORRIDOR_LATERAL_M = 2.2;

/** A consecutive-waypoint jump beyond this is a teleport, not driving/walking
 *  (assertion-grade: authored paths are metres apart; extension appends lane
 *  centerline samples, never leaps). */
export const PATH_TELEPORT_JUMP_M = 20;

/** Deflate every body by this per side for the first-frame test so GRAZING
 *  contact does not count as overlap — walker spawn hygiene guarantees only
 *  0.4 m point clearance to a vehicle body (an occlusion ped deliberately hugs
 *  its van), which can put a walker-box corner exactly on the body edge. The
 *  gate is after genuine interpenetration, not kissing bumpers. */
export const OVERLAP_DEFLATE_M = 0.05;

export type AssembledSceneReject =
  | "principal_overlap"
  | "principal_path_discontinuity";

export interface AssembledSceneGateOptions {
  /** The subject draft's id (always a principal). */
  subjectId: string;
  /** Load-bearing actors — subject, conflict actor(s), occluder bodies. Defects on
   *  these reject the scene; everything else is cullable dressing. */
  principalIds: ReadonlySet<string>;
  /** Per-blueprint body footprints (m) the caller PLACED with (the generator's
   *  occluder table). Boxing with the same envelopes the placement clearances
   *  used keeps the gate consistent with them — the class table below is only
   *  the fallback and its envelopes can exceed a placement's real body. */
  vehicleFootprints?: Readonly<Record<string, { length: number; width: number }>>;
}

export interface AssembledSceneGateResult {
  /** Surviving actors, input order preserved. Equals the input when clean. */
  actors: ScenarioEditorActorDraft[];
  /** Ids culled by the lints, in cull order. */
  culled: string[];
  /** Non-null → discard the whole scene (culls are then moot). */
  reject: AssembledSceneReject | null;
}

// ── Per-class footprints ─────────────────────────────────────────────────────
// Mirrors draft-validator's blueprint footprint table (not exported there;
// keep in sync — these are conservative CARLA body envelopes, not exact).

interface Footprint {
  lengthM: number;
  widthM: number;
}

const CAR: Footprint = { lengthM: 4.5, widthM: 2.0 };
const TRUCK: Footprint = { lengthM: 8.0, widthM: 2.6 };
const VAN: Footprint = { lengthM: 5.5, widthM: 2.2 };
const BUS: Footprint = { lengthM: 12.0, widthM: 2.9 };
const BICYCLE: Footprint = { lengthM: 1.8, widthM: 0.6 };
const MOTORCYCLE: Footprint = { lengthM: 2.2, widthM: 0.8 };
const PEDESTRIAN: Footprint = { lengthM: 0.8, widthM: 0.6 };
const PROP: Footprint = { lengthM: 0.6, widthM: 0.6 };

function footprintFor(
  actor: ScenarioEditorActorDraft,
  vehicleFootprints?: AssembledSceneGateOptions["vehicleFootprints"],
): Footprint {
  // kind is the schema field; role covers partial drafts (mocked fixtures).
  if (actor.kind === "walker" || (actor.kind == null && actor.role === "pedestrian")) {
    return PEDESTRIAN;
  }
  if (actor.kind === "prop") return PROP;
  const placed = actor.blueprint ? vehicleFootprints?.[actor.blueprint] : undefined;
  if (placed) return { lengthM: placed.length, widthM: placed.width };
  const bp = (actor.blueprint ?? "").toLowerCase();
  if (/crossbike|omafiets|diamondback|gazelle|bike|bicycle|cyclist/.test(bp)) {
    return BICYCLE;
  }
  if (/harley|kawasaki|yamaha|vespa|motorbike|motorcycle|low_rider|ninja/.test(bp)) {
    return MOTORCYCLE;
  }
  if (/firetruck|truck|carlacola|sprinter|ambulance|cybertruck/.test(bp)) {
    return TRUCK;
  }
  if (/\bvan\b|t2|volkswagen\.t2/.test(bp)) return VAN;
  if (/\bbus\b|coach/.test(bp)) return BUS;
  return CAR;
}

// ── Initial pose ─────────────────────────────────────────────────────────────

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A road-anchored draft's stamped world pose, if the generator resolved one
 *  (`withWorldAnchor`). This is the pose the worker spawns at, so it is the
 *  RIGHT thing to box — road-anchored ambient used to be invisible to every
 *  overlap/corridor lint here (dib 2026-08-02 Munich review: merge-18-4's
 *  bg-veh pair emitted world anchors 2.9 m apart, unseen by this gate). */
function spawnWorldAnchor(a: ScenarioEditorActorDraft): { x: number; y: number; yaw?: number } | null {
  const anchor = (a.spawn as { world_anchor?: { x: number; y: number; yaw?: number } } | null | undefined)
    ?.world_anchor;
  return anchor && finite(anchor.x) && finite(anchor.y) ? anchor : null;
}

/** First-frame oriented box: spawn transform (the literal spawn pose), else the
 *  first timed waypoint, else the stamped road-anchor world pose; heading from
 *  the first distinct waypoint (direction of travel) else spawn_yaw else the
 *  anchor yaw. null when the draft has no authored world pose to box or the
 *  pose is non-finite. */
function initialObb(
  a: ScenarioEditorActorDraft,
  vehicleFootprints?: AssembledSceneGateOptions["vehicleFootprints"],
): OrientedBox | null {
  const wps = a.timed_waypoints ?? [];
  const anchor = spawnWorldAnchor(a);
  const at = a.spawn_point ?? wps[0] ?? anchor ?? null;
  if (!at || !finite(at.x) || !finite(at.y)) return null;
  let headingRad: number | null = null;
  for (const w of wps) {
    if (!finite(w.x) || !finite(w.y)) return null;
    if (w.x !== at.x || w.y !== at.y) {
      headingRad = Math.atan2(w.y - at.y, w.x - at.x);
      break;
    }
  }
  if (headingRad === null) {
    headingRad = finite(a.spawn_yaw)
      ? (a.spawn_yaw * Math.PI) / 180
      : anchor && finite(anchor.yaw)
        ? (anchor.yaw! * Math.PI) / 180
        : 0;
  }
  const fp = footprintFor(a, vehicleFootprints);
  return {
    center: { x: at.x, y: at.y },
    heading: headingRad,
    halfLength: Math.max(0.05, fp.lengthM / 2 - OVERLAP_DEFLATE_M),
    halfWidth: Math.max(0.05, fp.widthM / 2 - OVERLAP_DEFLATE_M),
  };
}

// ── Lints ────────────────────────────────────────────────────────────────────

/** Path sanity for one timed path: finite coords, non-decreasing times, no
 *  consecutive teleport jump. An ABSENT time is no timing claim (mocked /
 *  legacy untimed fixtures carry bare {x, y} points) and skips the time checks;
 *  a PRESENT non-finite time is corruption and flags. */
function timedPathViolation(
  wps: ReadonlyArray<{ x: number; y: number; time?: number }>,
): boolean {
  for (let i = 0; i < wps.length; i++) {
    const w = wps[i]!;
    if (!finite(w.x) || !finite(w.y)) return true;
    if (w.time != null && !finite(w.time)) return true;
    if (i === 0) continue;
    const prev = wps[i - 1]!;
    if (finite(w.time) && finite(prev.time) && w.time < prev.time) return true;
    if (Math.hypot(w.x - prev.x, w.y - prev.y) > PATH_TELEPORT_JUMP_M) return true;
  }
  return false;
}

/** Static dressing: a body that never moves — declared static, or a point-
 *  anchored non-autopilot vehicle with no path. Road-anchored autopilot ambient
 *  has no authored world pose (spawn_point null) and is excluded by the boxing
 *  requirement anyway. */
function isStaticVehicle(a: ScenarioEditorActorDraft): boolean {
  if (a.kind !== "vehicle" || !a.spawn_point) return false;
  if (a.is_static === true) return true;
  return a.autopilot !== true && (a.timed_waypoints ?? []).length === 0;
}

/** The subject's driven polyline (spawn + timed waypoints, deduped). */
function subjectPolyline(subject: ScenarioEditorActorDraft): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  const push = (p: { x: number; y: number }) => {
    const last = pts[pts.length - 1];
    if ((!last || last.x !== p.x || last.y !== p.y) && finite(p.x) && finite(p.y)) {
      pts.push({ x: p.x, y: p.y });
    }
  };
  if (subject.spawn_point) push(subject.spawn_point);
  for (const w of subject.timed_waypoints ?? []) push(w);
  return pts;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

export function validateAssembledScene(
  actors: ReadonlyArray<ScenarioEditorActorDraft>,
  opts: AssembledSceneGateOptions,
): AssembledSceneGateResult {
  const isPrincipal = (a: ScenarioEditorActorDraft): boolean =>
    a.id === opts.subjectId || opts.principalIds.has(a.id);
  const culled = new Set<string>();
  const culledOrder: string[] = [];
  const cull = (a: ScenarioEditorActorDraft) => {
    if (!culled.has(a.id)) {
      culled.add(a.id);
      culledOrder.push(a.id);
    }
  };
  const done = (reject: AssembledSceneReject | null): AssembledSceneGateResult => ({
    actors: actors.filter((a) => !culled.has(a.id)),
    culled: culledOrder,
    reject,
  });

  // c. PATH SANITY — first, so a NaN pose never reaches the OBB math below
  // (NaN defeats SAT separation and would read as overlapping everything).
  for (const a of actors) {
    const wps = a.timed_waypoints ?? [];
    if (wps.length < 2) continue;
    if (!timedPathViolation(wps)) continue;
    if (isPrincipal(a)) return done("principal_path_discontinuity");
    cull(a);
  }

  // a. FIRST-FRAME OVERLAP — pairwise interpenetration at the initial pose.
  // Principal beats non-principal; between dressing the LATER-added body (the
  // higher index — assembly order is planner → occluder → background) yields.
  const boxed = actors
    .filter((a) => !culled.has(a.id))
    .map((a) => ({ a, obb: initialObb(a, opts.vehicleFootprints) }))
    .filter((e): e is { a: ScenarioEditorActorDraft; obb: OrientedBox } => e.obb !== null);
  for (let i = 0; i < boxed.length; i++) {
    const bi = boxed[i]!;
    if (culled.has(bi.a.id)) continue;
    for (let j = i + 1; j < boxed.length; j++) {
      const bj = boxed[j]!;
      if (culled.has(bi.a.id)) break;
      if (culled.has(bj.a.id)) continue;
      if (!boxesOverlap(bi.obb, bj.obb)) continue;
      const pi = isPrincipal(bi.a);
      const pj = isPrincipal(bj.a);
      if (pi && pj) return done("principal_overlap");
      cull(pi ? bj.a : pj ? bi.a : bj.a);
    }
  }

  // b. SUBJECT CORRIDOR — static dressing whose footprint reaches within
  // SUBJECT_CORRIDOR_LATERAL_M of the subject's driven polyline blocks the route the
  // conflict depends on. Principals (occluders are deliberately placed at
  // 1.65 m edge clearance) are exempt.
  const subject = actors.find((a) => a.id === opts.subjectId && !culled.has(a.id));
  const subjectPath = subject ? subjectPolyline(subject) : [];
  if (subjectPath.length >= 2) {
    for (const a of actors) {
      if (culled.has(a.id) || isPrincipal(a) || !isStaticVehicle(a)) continue;
      const fp = footprintFor(a, opts.vehicleFootprints);
      const obb: ObbFootprint = {
        cx: a.spawn_point!.x,
        cy: a.spawn_point!.y,
        yawDeg: finite(a.spawn_yaw) ? a.spawn_yaw : 0,
        lengthM: fp.lengthM,
        widthM: fp.widthM,
      };
      if (!finite(obb.cx) || !finite(obb.cy)) continue;
      if (!pathClearsObb(subjectPath, obb, SUBJECT_CORRIDOR_LATERAL_M)) cull(a);
    }
  }

  return done(null);
}
