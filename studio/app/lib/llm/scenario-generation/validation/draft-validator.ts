/**
 * Draft → kinematic validation.
 *
 * Adapts a built `ScenarioEditorDraft` actor list into the pure kinematic
 * simulator's `KinematicActor` model, replays it, and produces a
 * `ScenarioValidationReport` asserting the requested conflict actually
 * happens between the intended pair, near the location the prompt asked for.
 *
 * Consumed inline by `buildCollisionScenarioDraft` after it assembles the
 * actor list (so the agent sees pass/fail in the same turn). Types-only
 * imports keep this module free of the server-only planner/geometry runtime
 * so the validator stays unit-testable.
 */
import type {
  CollisionFamilyId,
  LintViolation,
  ScenarioEditorActorDraft,
  ScenarioValidationReport,
  ValidationCheck,
  ValidationActorDiagnostic,
} from "@simforge-oss/studio-shared";
import {
  fromPreviewFrames,
  lintActorTracks,
  plannedSubjectActor,
  SCENARIO_VALIDATION_ENGINE,
} from "@simforge-oss/studio-shared";
import {
  simulate,
  pairKey,
  type KinematicActor,
  type KinematicMotion,
  type Vec2,
} from "./kinematic-sim";

export interface CollisionConflictHint {
  /** Planned conflict point (planner output), runtime meters. */
  conflictPoint: { x: number; y: number };
  /** Planned time-of-impact, seconds since scenario start. */
  arrivalTimeS: number;
  /**
   * Authoritative turn relation for the subject's planned route, when the
   * planner resolved one (Tier-0 gate-driven plans). Sourced from
   * `topology.gates[].turnRelation` — derived at topology-build time
   * from the connecting road's net heading change in the XODR
   * `<planView>`. The `maneuver_executed` validator consults this
   * instead of inferring turn type from waypoint headings (which
   * misfires when the collision happens mid-turn). Null on legacy
   * Tier-1 plans, which fall back to the heading heuristic.
   */
  subjectTurnRelation?:
    | "Left"
    | "Right"
    | "Straight"
    | "UTurnLeft"
    | "UTurnRight"
    | null;
  /**
   * Absolute accept window (seconds). When present, `collision_occurred`
   * passes iff min ≤ contact ≤ max, replacing the relative ±tolerance.
   * Ped-scoped today; other families pass undefined and keep legacy.
   */
  acceptWindowS?: { min: number; max: number };
}

export interface ValidateCollisionDraftArgs {
  family: CollisionFamilyId;
  actors: readonly ScenarioEditorActorDraft[];
  /** Intended scenario location (document/candidate center), runtime meters.
   *  Falls back to the conflict hint when the geometry had no center. */
  intendedLocation: { x: number; y: number } | null;
  /** Planner output. Null when the builder fell back to heuristic placement
   *  — the report still runs but timing/region checks soften to warnings. */
  conflict: CollisionConflictHint | null;
  durationS: number;
  fixedDeltaS: number;
}

// ── Tolerances ──────────────────────────────────────────────────────────────

/** A collision must land within this radius of the intended location. */
const REGION_RADIUS_M = 35;
/** Allowed slack between observed contact time and planned arrival time. */
const TIMING_TOLERANCE_S = 3;
/** A contact before this is a spawn overlap, not a planned collision. */
const MIN_COLLISION_TIME_S = 2;
/** A contact further than this from the planned time-of-impact is not the
 *  planned collision (wider than TIMING_TOLERANCE_S, which is a warn). */
const COLLISION_ARRIVAL_TOL_S = 4;
/** Beyond this, an actor's spawn-to-location distance is flagged (warn only —
 *  principals legitimately spawn far upstream to build speed). */
const SPAWN_OFFSET_WARN_M = 220;
/** A resolvable route needs at least this much drivable arc length. */
const MIN_ROUTE_ARC_M = 2;
/** Minimum net subject heading change for a turn family to count as a turn
 *  (~60°). A straight head-on (~0°) fails; a real left/right turn (~90°)
 *  passes. Generous lower bound so legitimate shallow-angle junctions
 *  still qualify. */
const MANEUVER_MIN_TURN_RAD = Math.PI / 3;

// ── Blueprint footprints ────────────────────────────────────────────────────

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

function footprintFor(actor: ScenarioEditorActorDraft): Footprint {
  if (actor.kind === "walker") return PEDESTRIAN;
  if (actor.kind === "prop") return PROP;
  const bp = actor.blueprint.toLowerCase();
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

// ── Draft actor → kinematic actor ───────────────────────────────────────────

function dedupeConsecutive(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function actorPolyline(actor: ScenarioEditorActorDraft): Vec2[] {
  const pts: Vec2[] = [];
  for (const waypoint of timedWaypointsWithSpawn(actor)) {
    pts.push({ x: waypoint.x, y: waypoint.y });
  }
  return dedupeConsecutive(pts);
}

function timedWaypointsWithSpawn(
  actor: ScenarioEditorActorDraft,
): Array<{ x: number; y: number; time: number }> {
  const timed = [...(actor.timed_waypoints ?? [])].sort((a, b) => a.time - b.time);
  if (!actor.spawn_point) return timed.map((point) => ({ x: point.x, y: point.y, time: point.time }));
  const spawn = { x: actor.spawn_point.x, y: actor.spawn_point.y, time: 0 };
  const first = timed[0];
  if (first && first.x === spawn.x && first.y === spawn.y && first.time <= 1e-9) {
    return timed.map((point) => ({ x: point.x, y: point.y, time: point.time }));
  }
  return [
    spawn,
    ...timed.map((point) => ({ x: point.x, y: point.y, time: point.time })),
  ];
}

function motionFor(actor: ScenarioEditorActorDraft): KinematicMotion {
  if (actor.placement_mode === "timed_path" && actor.timed_waypoints?.length) {
    return {
      kind: "timed_path",
      waypoints: timedWaypointsWithSpawn(actor),
    };
  }
  // Fallback / heuristic placement: no resolvable trajectory. Treat as a
  // stationary body at its best-known point so the route_resolvable check
  // can flag it rather than silently excluding it.
  const at =
    actor.spawn_point ??
    (actor.path_placement && actor.path_placement[0]) ??
    actor.destination_point ??
    null;
  return {
    kind: "static",
    point: at ? { x: at.x, y: at.y } : { x: 0, y: 0 },
    heading: actor.spawn_yaw ?? 0,
  };
}

function toKinematicActor(actor: ScenarioEditorActorDraft): KinematicActor {
  const fp = footprintFor(actor);
  return {
    id: actor.id,
    label: actor.label,
    role: actor.role,
    size: { lengthM: fp.lengthM, widthM: fp.widthM },
    motion: motionFor(actor),
  };
}

// ── Intended pair resolution ────────────────────────────────────────────────

interface IntendedPair {
  subject: ScenarioEditorActorDraft;
  target: ScenarioEditorActorDraft;
}

function resolveIntendedPair(
  actors: readonly ScenarioEditorActorDraft[],
): IntendedPair | null {
  const subject = plannedSubjectActor(actors);
  if (!subject) return null;
  // The conflicting principal: prefer a pedestrian (pedestrian_crossing),
  // then the first non-subject traffic/pedestrian vehicle the builder placed.
  const ped = actors.find((a) => a.role === "pedestrian" && a.id !== subject.id);
  const target =
    ped ??
    actors.find(
      (a) => a.id !== subject.id && (a.role === "traffic" || a.role === "pedestrian"),
    ) ??
    actors.find((a) => a.id !== subject.id);
  if (!target) return null;
  return { subject, target };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function spawnPointOf(actor: ScenarioEditorActorDraft): Vec2 | null {
  if (actor.spawn_point) return { x: actor.spawn_point.x, y: actor.spawn_point.y };
  if (actor.timed_waypoints && actor.timed_waypoints[0]) {
    return { x: actor.timed_waypoints[0].x, y: actor.timed_waypoints[0].y };
  }
  if (actor.path_placement && actor.path_placement[0]) {
    return { x: actor.path_placement[0].x, y: actor.path_placement[0].y };
  }
  return null;
}

function declaredViolating(actor: ScenarioEditorActorDraft | undefined): boolean {
  if (!actor) return false;
  const raw = actor as unknown as Record<string, unknown>;
  const metadata = raw.behaviorMetadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const behaviorClass = (metadata as Record<string, unknown>).behavior_class;
  if (typeof behaviorClass !== "string") return false;
  const normalized = behaviorClass.trim().toLowerCase();
  return normalized === "violating" || normalized === "adversarial";
}

function lintUnit(kind: LintViolation["kind"]): string {
  switch (kind) {
    case "longitudinal_acceleration":
    case "longitudinal_deceleration":
    case "lateral_acceleration":
    case "speed_discontinuity":
      return "m/s²";
    case "longitudinal_jerk":
      return "m/s³";
    case "speed":
      return "m/s";
    case "position_discontinuity":
      return "m";
    case "heading_discontinuity":
      return "rad";
  }
}

function lintLabel(kind: LintViolation["kind"]): string {
  return kind.replaceAll("_", " ");
}

// ── Contact-time classification ──────────────────────────────────────────────

/**
 * Pure helper: classify a raw contact time as "ok", "too_early", or "mistimed".
 *
 * Two modes:
 *  - **Windowed** (`acceptWindowS` present): accept iff `min ≤ contactS ≤ max`.
 *    `too_early` when below min, `mistimed` when above max.
 *  - **Legacy** (no `acceptWindowS`): `too_early` when `contactS < MIN_COLLISION_TIME_S`;
 *    `mistimed` when a `plannedArrivalS` is provided and drift exceeds
 *    `COLLISION_ARRIVAL_TOL_S`; otherwise `ok`.
 *
 * Exported so it can be unit-tested independently of the full draft simulation.
 */
export function classifyContactTime(
  contactS: number,
  opts: { acceptWindowS?: { min: number; max: number } | null; plannedArrivalS?: number | null },
): "ok" | "too_early" | "mistimed" {
  const { acceptWindowS = null, plannedArrivalS = null } = opts;
  if (acceptWindowS) {
    if (contactS < acceptWindowS.min) return "too_early";
    if (contactS > acceptWindowS.max) return "mistimed";
    return "ok";
  }
  // Legacy path
  if (contactS < MIN_COLLISION_TIME_S) return "too_early";
  if (plannedArrivalS != null && Math.abs(contactS - plannedArrivalS) > COLLISION_ARRIVAL_TOL_S) {
    return "mistimed";
  }
  return "ok";
}

// ── Report assembly ─────────────────────────────────────────────────────────

export function validateCollisionDraft(
  args: ValidateCollisionDraftArgs,
): ScenarioValidationReport {
  const now = new Date().toISOString();
  const pair = resolveIntendedPair(args.actors);
  const intendedLocation =
    args.intendedLocation ?? args.conflict?.conflictPoint ?? null;

  const baseReport: ScenarioValidationReport = {
    schemaVersion: 1,
    engine: SCENARIO_VALIDATION_ENGINE,
    verdict: "fail",
    family: args.family,
    generatedAt: now,
    simulatedDurationS: args.durationS,
    fixedDeltaS: args.fixedDeltaS,
    intendedPair: {
      subjectActorId: pair?.subject.id ?? "",
      targetActorId: pair?.target.id ?? "",
    },
    intendedLocation,
    regionRadiusM: REGION_RADIUS_M,
    collision: {
      occurred: false,
      timeS: null,
      point: null,
      closingSpeedKph: null,
      actorAId: null,
      actorBId: null,
    },
    minPairwiseDistanceM: Infinity,
    checks: [],
    actorDiagnostics: [],
    reasons: [],
    repair: null,
  };

  if (!pair) {
    baseReport.reasons = [
      "intended_pair_unresolved: draft has no subject + conflicting actor to evaluate",
    ];
    baseReport.checks = [
      {
        id: "route_resolvable",
        status: "fail",
        label: "Actors",
        detail: "Could not identify a sensor-carrying subject and a conflicting actor in the draft.",
        measuredValue: null,
        threshold: null,
      },
    ];
    return baseReport;
  }

  const kinematicActors = args.actors.map(toKinematicActor);
  const sim = simulate(kinematicActors, {
    durationS: args.durationS,
    fixedDeltaS: args.fixedDeltaS,
    monitoredPairs: [[pair.subject.id, pair.target.id]],
  });

  const key = pairKey(pair.subject.id, pair.target.id);
  const rawContact = sim.contacts.find(
    (c) => pairKey(c.actorAId, c.actorBId) === key,
  );
  // A contact at/near t=0 is a SPAWN OVERLAP (actors placed on top of each
  // other), and a contact far from the planned time-of-impact is not the
  // planned collision either — neither is a valid generated collision.
  // Gate `contact` on validity so every downstream check (occurred /
  // region / timing / report) treats these as "no collision"; keep
  // `rawContact` only to explain *why* it failed.
  const plannedArrivalS = args.conflict?.arrivalTimeS ?? null;
  const acceptWin = args.conflict?.acceptWindowS ?? null;
  const contactClass = rawContact
    ? classifyContactTime(rawContact.timeS, { acceptWindowS: acceptWin, plannedArrivalS })
    : "ok";
  const tooEarly = contactClass === "too_early";
  const mistimed = contactClass === "mistimed";
  const contact = rawContact && !tooEarly && !mistimed ? rawContact : null;
  const minGap = sim.minGapByPair.get(key);
  const minPairwiseDistanceM = minGap ? minGap.gapM : Infinity;

  const checks: ValidationCheck[] = [];
  const reasons: string[] = [];

  // route_resolvable — every principal needs a real path.
  const principals = [pair.subject, pair.target];
  const unresolved = principals.filter((a) => {
    const arc = sim.pathArcLengthByActor.get(a.id) ?? 0;
    const km = kinematicActors.find((k) => k.id === a.id)!;
    if (km.motion.kind === "timed_path") return km.motion.waypoints.length < 2;
    if (km.motion.kind === "static") return true;
    return arc < MIN_ROUTE_ARC_M;
  });
  if (unresolved.length === 0) {
    checks.push({
      id: "route_resolvable",
      status: "pass",
      label: "Routes",
      detail: "Every principal actor has a drivable planned path.",
      measuredValue: null,
      threshold: MIN_ROUTE_ARC_M,
    });
  } else {
    checks.push({
      id: "route_resolvable",
      status: "fail",
      label: "Routes",
      detail: `No resolvable trajectory for: ${unresolved
        .map((a) => a.label)
        .join(", ")}. Builder likely fell back to heuristic placement.`,
      measuredValue: null,
      threshold: MIN_ROUTE_ARC_M,
    });
    reasons.push(
      `route_resolvable: ${unresolved
        .map((a) => a.label)
        .join(", ")} has no planned path — the planner returned null and the draft used heuristic placement.`,
    );
  }

  // collision_occurred — the headline check.
  if (contact) {
    checks.push({
      id: "collision_occurred",
      status: "pass",
      label: "Collision",
      detail: `${pair.subject.label} and ${pair.target.label} make contact at t=${contact.timeS.toFixed(
        2,
      )}s (closing ${(contact.closingSpeedMps * 3.6).toFixed(1)} kph).`,
      measuredValue: contact.timeS,
      threshold: args.durationS,
    });
  } else {
    const gapStr = Number.isFinite(minPairwiseDistanceM)
      ? `${minPairwiseDistanceM.toFixed(1)} m`
      : "unknown";
    // Distinguish a rejected (invalid) contact from a genuine miss.
    let detail: string;
    let reason: string;
    let measured: number | null;
    if (tooEarly && rawContact) {
      if (acceptWin) {
        detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s — outside the accepted [${acceptWin.min},${acceptWin.max}]s window (too early).`;
        reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is outside the accepted [${acceptWin.min},${acceptWin.max}]s window (before min ${acceptWin.min}s) — not the planned collision.`;
      } else {
        detail = `${pair.subject.label} and ${pair.target.label} overlap at spawn (t=${rawContact.timeS.toFixed(2)}s) — actors placed on top of each other, not a planned collision.`;
        reason = `collision_occurred: spawn overlap at t=${rawContact.timeS.toFixed(2)}s (< ${MIN_COLLISION_TIME_S}s) — the planner did not give the actors a run-up; this is a start-state overlap, not the requested collision.`;
      }
      measured = rawContact.timeS;
    } else if (mistimed && rawContact) {
      if (acceptWin) {
        detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s — outside the accepted [${acceptWin.min},${acceptWin.max}]s window (too late).`;
        reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is outside the accepted [${acceptWin.min},${acceptWin.max}]s window (after max ${acceptWin.max}s) — not the planned collision.`;
      } else {
        detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s, far from the planned ${plannedArrivalS?.toFixed(1)}s.`;
        reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is ${Math.abs((rawContact.timeS - (plannedArrivalS ?? 0))).toFixed(1)}s off the planned ${plannedArrivalS?.toFixed(1)}s (tol ${COLLISION_ARRIVAL_TOL_S}s) — not the planned collision.`;
      }
      measured = rawContact.timeS;
    } else {
      detail = `${pair.subject.label} and ${pair.target.label} never make contact (closest approach ${gapStr}).`;
      reason = `collision_occurred: the requested conflict between ${pair.subject.label} and ${pair.target.label} did not happen — they missed by ${gapStr}. Likely a timing or geometry mismatch in the planned routes.`;
      measured = Number.isFinite(minPairwiseDistanceM) ? minPairwiseDistanceM : null;
    }
    checks.push({
      id: "collision_occurred",
      status: "fail",
      label: "Collision",
      detail,
      measuredValue: measured,
      threshold: 0,
    });
    reasons.push(reason);
  }

  // collision_in_region — contact must land near the asked-for location.
  if (contact && intendedLocation) {
    const off = distance(contact.point, intendedLocation);
    if (off <= REGION_RADIUS_M) {
      checks.push({
        id: "collision_in_region",
        status: "pass",
        label: "Location",
        detail: `Contact is ${off.toFixed(1)} m from the specified location.`,
        measuredValue: off,
        threshold: REGION_RADIUS_M,
      });
    } else {
      checks.push({
        id: "collision_in_region",
        status: "fail",
        label: "Location",
        detail: `Contact is ${off.toFixed(
          1,
        )} m from the specified location (max ${REGION_RADIUS_M} m).`,
        measuredValue: off,
        threshold: REGION_RADIUS_M,
      });
      reasons.push(
        `collision_in_region: the collision happened ${off.toFixed(
          1,
        )} m away from the location the prompt specified (tolerance ${REGION_RADIUS_M} m).`,
      );
    }
  }

  // collision_timing — observed vs planned time-of-impact (soft when no planner).
  if (contact && args.conflict) {
    const drift = Math.abs(contact.timeS - args.conflict.arrivalTimeS);
    checks.push({
      id: "collision_timing",
      status: drift <= TIMING_TOLERANCE_S ? "pass" : "warn",
      label: "Timing",
      detail: `Contact at t=${contact.timeS.toFixed(
        2,
      )}s vs planned ${args.conflict.arrivalTimeS.toFixed(2)}s (drift ${drift.toFixed(
        2,
      )}s).`,
      measuredValue: drift,
      threshold: TIMING_TOLERANCE_S,
    });
  }

  // Spawn-offset diagnostics (warn-only — moving principals spawn far upstream).
  const spawnChecks: Array<[
    "subject_spawn_offset" | "target_spawn_offset",
    ScenarioEditorActorDraft,
  ]> = [
    ["subject_spawn_offset", pair.subject],
    ["target_spawn_offset", pair.target],
  ];
  for (const [id, actor] of spawnChecks) {
    const sp = spawnPointOf(actor);
    if (!sp || !intendedLocation) continue;
    const off = distance(sp, intendedLocation);
    checks.push({
      id,
      status: off <= SPAWN_OFFSET_WARN_M ? "pass" : "warn",
      label: "Spawn",
      detail: `${actor.label} spawns ${off.toFixed(0)} m from the specified location.`,
      measuredValue: off,
      threshold: SPAWN_OFFSET_WARN_M,
    });
  }

  // maneuver_executed — the subject must actually perform the family-defining
  // maneuver. A straight head-on satisfies collision_occurred /
  // collision_in_region, so without this an `unprotected_left_turn` that
  // never turns falsely PASSes (the exact eval false-pass).
  //
  // Two modes, in priority order:
  //   1. Authoritative — when the planner resolved a `subjectTurnRelation`
  //      (Tier-0 gate-driven plans), it IS the answer. The gate's
  //      turnRelation was set by the topology builder from the
  //      connecting road's net heading change in the XODR; that's the
  //      high-resolution ground truth. We just check that the family
  //      and the gate's turn agree.
  //   2. Fallback — Tier-1 / heuristic plans don't carry a gate, so we
  //      fall back to measuring net heading change along the subject's
  //      planned waypoints. This is the brittle path (mis-fires when the
  //      collision happens mid-turn; the executed motion only covers a
  //      fraction of the planned gate arc); kept only until Tier-0
  //      solvers exist for every family.
  const TURN_FAMILIES = new Map<
    CollisionFamilyId,
    "Left" | "Right" | "Straight" | "UTurnLeft" | "UTurnRight"
  >([
    ["unprotected_left_turn", "Left"],
    ["right_turn_hook", "Right"],
  ]);
  const expectedTurn = TURN_FAMILIES.get(args.family);
  if (!expectedTurn) {
    checks.push({
      id: "maneuver_executed",
      status: "pass",
      label: "Maneuver",
      detail: `No turn maneuver required for ${args.family}.`,
      measuredValue: null,
      threshold: null,
    });
  } else if (args.conflict?.subjectTurnRelation) {
    // Authoritative gate-driven check. Match the family's expected turn
    // to the gate's `turnRelation`. No waypoint heading math.
    const planned = args.conflict.subjectTurnRelation;
    const ok = planned === expectedTurn;
    checks.push({
      id: "maneuver_executed",
      status: ok ? "pass" : "fail",
      label: "Maneuver",
      detail: ok
        ? `${pair.subject.label} traverses a ${planned} gate (XODR-authoritative; ${args.family}).`
        : `${pair.subject.label}'s planned route is a ${planned} gate, not the ${expectedTurn} ` +
          `gate the family requires.`,
      measuredValue: null,
      threshold: null,
    });
  } else {
    const poly = actorPolyline(pair.subject);
    let headingChangeRad = 0;
    if (poly.length >= 3) {
      const seg = (a: Vec2, b: Vec2) => Math.atan2(b.y - a.y, b.x - a.x);
      const start = seg(poly[0]!, poly[1]!);
      const end = seg(poly[poly.length - 2]!, poly[poly.length - 1]!);
      let d = end - start;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      headingChangeRad = Math.abs(d);
    }
    const deg = (headingChangeRad * 180) / Math.PI;
    const ok = headingChangeRad >= MANEUVER_MIN_TURN_RAD;
    checks.push({
      id: "maneuver_executed",
      status: ok ? "pass" : "fail",
      label: "Maneuver",
      detail: ok
        ? `${pair.subject.label} executes a ${deg.toFixed(0)}° turn (${args.family}; heading-fallback, no gate).`
        : `${pair.subject.label} only changes heading ${deg.toFixed(
            0,
          )}° — not a ${args.family} (a straight head-on is not a turn).`,
      measuredValue: deg,
      threshold: (MANEUVER_MIN_TURN_RAD * 180) / Math.PI,
    });
  }

  // kinematic_lint — shared physical-plausibility thresholds over the exact
  // poses produced by the fixed-dt preview simulation. Props are outside the
  // lint engine's vehicle/walker domain.
  const lintableActors = args.actors.filter((actor) => actor.kind !== "prop");
  const lintableIds = new Set(lintableActors.map((actor) => actor.id));
  const actorKinds: Record<string, "vehicle" | "walker"> = {};
  for (const actor of lintableActors) {
    actorKinds[actor.id] = actor.kind === "walker" ? "walker" : "vehicle";
  }
  // A collision draft's planned-motion plausibility is judged on the run-up
  // to first contact. Holding/clamping a scripted path after the intended
  // conflict is a preview artifact, not authored pre-contact dynamics.
  const lintEndS = rawContact?.timeS ?? sim.finalTimeS;
  const lintReport = lintActorTracks(
    fromPreviewFrames(
      sim.previewFrames
        .filter((frame) => frame.timestamp <= lintEndS)
        .map((frame) => ({
          ...frame,
          actors: frame.actors
            .filter((actor) => lintableIds.has(actor.id))
            .map(({ speed: _speed, ...actor }) => actor),
        })),
      actorKinds,
    ),
  );
  if (lintReport.violations.length === 0) {
    checks.push({
      id: "kinematic_lint",
      kind: "kinematic_lint",
      status: "pass",
      label: "Kinematics",
      detail: "Planned actor motion has no kinematic plausibility findings.",
      measuredValue: null,
      threshold: null,
    });
  } else {
    const actorsById = new Map(args.actors.map((actor) => [actor.id, actor]));
    for (const finding of lintReport.violations) {
      const actor = actorsById.get(finding.actorId);
      const isDeclared = declaredViolating(actor);
      const annotation =
        finding.severity === "violation" && isDeclared
          ? " (declared-violating)"
          : "";
      const status =
        finding.severity === "warning"
          ? "warn"
          : isDeclared
            ? "pass"
            : "fail";
      const unit = lintUnit(finding.kind);
      checks.push({
        id: "kinematic_lint",
        kind: "kinematic_lint",
        status,
        label: "Kinematics",
        detail: `${actor?.label ?? finding.actorId}: ${lintLabel(finding.kind)} ${finding.severity} peaks at ${finding.peakValue.toFixed(2)} ${unit} (threshold ${finding.threshold.toFixed(2)} ${unit})${annotation}.`,
        measuredValue: finding.peakValue,
        threshold: finding.threshold,
      });
      if (status === "fail") {
        reasons.push(
          `kinematic_lint: ${actor?.label ?? finding.actorId} has an unexplained ${lintLabel(finding.kind)} violation (peak ${finding.peakValue.toFixed(2)} ${unit}, threshold ${finding.threshold.toFixed(2)} ${unit}).`,
        );
      }
    }
  }

  // Per-actor diagnostics.
  const actorDiagnostics: ValidationActorDiagnostic[] = principals.map((a) => {
    const sp = spawnPointOf(a);
    const reachedConflict =
      contact != null && (contact.actorAId === a.id || contact.actorBId === a.id);
    return {
      actorId: a.id,
      label: a.label,
      role: a.role,
      spawnPoint: sp,
      pathArcLengthM: sim.pathArcLengthByActor.get(a.id) ?? 0,
      expectedSpeedKph: a.speed_kph,
      spawnOffsetM: sp && intendedLocation ? distance(sp, intendedLocation) : null,
      reachedConflict,
      timeToConflictS: reachedConflict && contact ? contact.timeS : null,
    };
  });

  const hardFail = checks.some(
    (c) =>
      c.status === "fail" &&
      (c.id === "collision_occurred" ||
        c.id === "collision_in_region" ||
        c.id === "route_resolvable" ||
        c.id === "maneuver_executed" ||
        c.id === "kinematic_lint"),
  );

  return {
    ...baseReport,
    verdict: hardFail ? "fail" : "pass",
    collision: contact
      ? {
          occurred: true,
          timeS: contact.timeS,
          point: contact.point,
          closingSpeedKph: contact.closingSpeedMps * 3.6,
          actorAId: contact.actorAId,
          actorBId: contact.actorBId,
        }
      : baseReport.collision,
    minPairwiseDistanceM: contact ? 0 : minPairwiseDistanceM,
    checks,
    actorDiagnostics,
    reasons,
  };
}
