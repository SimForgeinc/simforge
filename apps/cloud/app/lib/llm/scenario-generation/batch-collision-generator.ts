/**
 * `generateCollisionScenarioBatch` — the deterministic batch generation service
 * (stage-1 Phase 2). Turns a structured `ScenarioRequest` into N validated,
 * ready-to-render scenario drafts, with NO LLM in the loop:
 *
 *   findCollisionSites (fit-ranked top-N)  ──▶  per site:
 *     plan actors  ──▶  draft  ──▶  runtime-road snap  ──▶  kinematic gate
 *   ──▶  GeneratedScenario (actors + seeded generation provenance)
 *
 * This is the reusable core the emit harnesses + a future dataset API both call.
 * It does NOT persist — the caller wraps each draft as a render job / dataset
 * row. The kinematic gate ensures only convergent plans are returned (the
 * Phase 2 finding: fit-rank alone floated degenerate roomy sites).
 */
import {
  plannedSubjectActor,
  type GeneratedScenarioMetadata,
  type MapTopologyIndex,
  type ScenarioEditorActorDraft,
  type ScenarioIntention,
} from "@simcloud/shared";
import {
  findCollisionSites,
  type JunctionConstraintIndex,
} from "@/app/lib/llm/scenario-generation/site-search/find-collision-sites";
import { planPedestrianCrossingForSite } from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-topology-planner";
import { isMidblockGateId } from "@/app/lib/llm/scenario-generation/planner/midblock-ped-site-selector";
import { planTurnPedCrosswalkForSite } from "@/app/lib/llm/scenario-generation/planner/turn-ped-crosswalk-planner";
import {
  draftTimeAtConflict,
  plannedCollisionToDraftActors,
  type SubjectTurn,
} from "@/app/lib/llm/scenario-generation/validation/planned-to-draft";
import type { PlannedActor } from "@/app/lib/llm/scenario-generation/collision-route-planner";
import { validateCollisionDraft } from "@/app/lib/llm/scenario-generation/validation/draft-validator";
import {
  snapDraftActorsToRuntimeRoads,
  type RuntimeRoadSegment,
} from "@/app/lib/llm/scenario-generation/runtime-road-snap";
import {
  CAR_OCCLUDER_FOOTPRINT,
  populateBackgroundScene,
  resolvePopulation,
  stripWorldPartitionAmbientVehicles,
  VAN_OCCLUDER_BLUEPRINT,
  VAN_OCCLUDER_FOOTPRINT,
  WORLD_PARTITION_MAPS,
  type ParkingBayRef,
  type SightlineOccluderKind,
} from "@/app/lib/llm/scenario-generation/scene-population";
import {
  pathClearsObb,
  PED_OCCLUDER_CLEARANCE_M,
  resolveWalkerSpawnClearOfVehicles,
  segmentIntersectsObb,
  type ObbFootprint,
  type WalkPath,
} from "@/app/lib/llm/scenario-generation/occluder-clearance";
import { parkingLanesFromTopology } from "@/app/lib/maps/topology/parking-lanes";
import {
  isTunnelMultilevelSite,
  TUNNEL_MULTILEVEL_GATE_REASON,
} from "@/app/lib/llm/scenario-generation/multilevel-site-gate";
import { extendActorPathsBeyondConflict } from "@/app/lib/llm/scenario-generation/extend-actor-paths";
import { validateAssembledScene } from "@/app/lib/llm/scenario-generation/validation/assembled-scene-gate";
import { retimeConflictActor } from "@/app/lib/scenario-validation/repair/deterministic";
import type {
  ProjectedCrosswalk,
  ProjectedSidewalk,
} from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-geometry";
import type {
  ProjectedOccluder,
  ProjectedParkingLot,
} from "@/app/lib/llm/scenario-generation/load-pedestrian-regions";
import type { Vec2 } from "@simcloud/shared";
import type { ScenarioRequest } from "./scenario-request";
import { stampCollisionGeneratedOutput } from "@/app/lib/scenario-generation/scenario-intention";
import { finalizeGeneratedActorBehaviors } from "@/app/lib/scenario-generation/generated-actor-behavior";

const DEFAULT_MIN_TIME_S = 5;
// Turn-family runway (operator 2026-07-28, 5 scenes: "we don't need so much
// runway for turn scenarios — 2-3 seconds is good enough since the turn itself
// with the wait takes 12-15 seconds"). The approach run-up floors at ~2.5 s of
// travel; the P-3 spawn-on-approach floor still guarantees the subject spawns
// BEFORE the junction arc, and the through-junction time dominates the clip.
// Raised 2.5 -> 3.5 and 3 -> 4 (dib 2026-07-30: "at least 3-4 seconds of
// runway"). These are the REQUEST; the absolute floor on what the geometry must
// afford is TURN_MIN_APPROACH_TIME_S in the gated planner. A floor above the
// request rejects every site however good, so the request must clear it.
const TURN_MIN_TIME_S = 3.5;
const TURN_ARRIVAL_TIME_S = 4;
/** Families whose subject drives a junction ARC. `bicycle_merge` is deliberately
 *  absent: a straight-lane merge inheriting the turn arrival is what put its
 *  conflicts 1-2 s after spawn. */
const TURN_FAMILIES: ReadonlySet<string> = new Set([
  "unprotected_left_turn",
  "right_turn_hook",
  "left_turn_ped_crosswalk",
  "right_turn_ped_crosswalk",
]);
/**
 * Turn families can't hold a fast schedule THROUGH the junction arc: the
 * timed-path subject lags (measured on Yale — the subject↔NPC closest approach lands at
 * ~8 s vs the planned 6 s, a ~2-3 s turn delay), so the kinematic gate's
 * on-time assumption breaks and the straight NPC has already passed → 7-8 m
 * misses. Capping the turn approach speed makes the schedule trackable (a ~6 m/s
 * turn the controller can follow vs a ~10 m/s one it can't), so the subject arrives
 * on schedule and the gate + sim agree. Pedestrian crossings are unaffected.
 */
// 2026-07-10 (dib: "speeds seemed much slower" at real-time playback — 22 kph was
// ~35-50% of the 40-64 kph posted limits): raised 22 -> 40. The 22 cap predates
// curvature retiming; the APPROACH now runs near-arterial speed and
// retimeWithCurvature alone slows the arc to the 2.0 m/s^2 comfort envelope
// (8-17 kph through the turn). Conflict timing re-solves off the higher speed
// (longer run-ups; the placement runway gate absorbs it). Validated via the 2D
// loop before any render batch.
const TURN_APPROACH_SPEED_CAP_KPH = 40;
const DEFAULT_IDEAL_TIME_S = 8;
const DEFAULT_ARRIVAL_TIME_S = 6;
/**
 * AVOIDED (subjectReactive) variant: how many seconds the vehicle conflict actor is
 * advanced so it reaches the crossing BEFORE the subject. The measured subject-vs-plan
 * skew in the 2026-08-01 corpus was 0.4-2.4 s early (mean ~1.2 s) and every
 * intended_collision loss had the NPC arriving 0.2-1.8 s AFTER the subject — 2.0 s
 * lands the NPC comfortably first across that whole spread. The per-scene
 * refinement (measured `conflict_lead_s` → target −1.5 s) belongs to the
 * avoid-mode 2D repair loop; this is the emit-time prior.
 */
const AVOID_CONFLICT_LEAD_S = 2.0;
const DRAFT_DURATION_S = 20;
const DRAFT_FIXED_DELTA_S = 0.05;

const NPC_BLUEPRINT: Record<NonNullable<ScenarioRequest["npcVehicleType"]>, string> = {
  car: "vehicle.lincoln.mkz",
  bicycle: "vehicle.bh.crossbike",
  motorcycle: "vehicle.yamaha.yzf",
};

// Workstream J — bicyclist conflict (the classic right-hook is a cyclist on the
// subject's right continuing straight). CARLA's stock bicycles, varied per scene
// (seeded) for blueprint diversity rather than a single model everywhere.
// vehicle.gazelle.omafiets is DROPPED (dib 2026-08-02 Munich review,
// merge-17-5 rated 1): its baked-in rider was the one observed shredding into
// the giant "paraglider" cloth artifact on 0.10, and the rider skin cannot be
// controlled from our stack (no rider-attach path in the worker — the bike
// blueprint spawns as-is). Restore after a re-cook proves the mesh stable.
const CYCLIST_BLUEPRINTS = [
  "vehicle.bh.crossbike",
  "vehicle.diamondback.century",
] as const;
// A realistic urban cyclist cruising speed — a bike swapped onto a 30 kph
// adjacent-lane vehicle would arrive far too fast for the planned conflict.
// Used as the NPC speed default when npcVehicleType is "bicycle" and the
// request didn't pin npcSpeedKph.
const CYCLIST_SPEED_KPH = 16;

// ── Occlusion occluder (workstream D2) ──────────────────────────────────────
// Image-native ids (UE5.5/0.10 live probe 2026-07-09 — the old 0.9 list ALL
// substituted to lincoln.mkz, flattening the fleet's variety). SUV included:
// a taller body occludes better than a sedan.
const OCCLUDER_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.sprinter.mercedes",
];
/** Context-appropriate occluders by occlusion subtype: a BUS at a bus stop, a
 *  LARGE vehicle (box truck / semi) at street-parking-near-conflict + commercial
 *  delivery bays, else a generic parked car. A bigger body blocks the subject's
 *  sightline to the emerging pedestrian more realistically. */
const BUS_OCCLUDER_BLUEPRINTS = ["vehicle.fuso.mitsubishi"]; // city bus / coach
const LARGE_OCCLUDER_BLUEPRINTS = [
  "vehicle.carlacola.actors", // box delivery truck
  "vehicle.firetruck.actors", // largest spawn-verified UE5 heavy body
];
/** MEDIUM occluder class (dib 2026-07-17): the large bodies frequently fail to
 *  spawn in 3D at tight sites — the carlacola box truck came back `null_handle`
 *  x8 across many spots (spawn-space too tight for a 6.5x2.4m body), silently
 *  dropping the occlusion the scene is about. The Sprinter is the boxiest/
 *  tallest (~2.4m) spawn-verified UE5 body under truck size: less occlusion
 *  than a truck but far more believable than none, and much likelier to spawn
 *  (it already spawns reliably from the generic OCCLUDER_BLUEPRINTS pool).
 *  Selected per-request via `occluderClass: "medium"` (default "large" keeps
 *  existing batches byte-identical). */
const MEDIUM_OCCLUDER_BLUEPRINTS = [
  "vehicle.sprinter.mercedes", // boxy panel van — canonical medium occluder
];
/** Occluder footprint (m) used to scale placement so a longer/wider body still
 *  sits between the subject and the ped without clipping the driving lane. Cars fall
 *  through to the default, which reproduces the historical 2.85m / 2.6m constants
 *  exactly, so existing car-occluder scenes stay byte-identical. */
const OCCLUDER_FOOTPRINT_M: Readonly<Record<string, { length: number; width: number }>> = {
  "vehicle.fuso.mitsubishi": { length: 12.0, width: 2.5 },
  "vehicle.firetruck.actors": { length: 10.0, width: 2.6 },
  "vehicle.carlacola.actors": { length: 6.5, width: 2.4 },
  // Medium class: Sprinter body ~5.9x2.0m — the placement clearance scales off
  // this, so the van sits closer to the kerb than a truck and fits sites the
  // 6.5x2.4m carlacola body can't spawn at.
  "vehicle.sprinter.mercedes": { length: 5.9, width: 2.0 },
};
const DEFAULT_OCCLUDER_FOOTPRINT = { length: 4.7, width: 1.9 } as const;
const OCCLUDER_COLOR = "55,58,64"; // muted "parked" body
/** Nudge the occluder this far off the sidewalk toward the road (into the parking
 *  strip) so it actually blocks the subject's sightline; capped per-site + guarded. */
const OCCLUDER_ROAD_INSET_M = 2.0;
/** Keep the occluder's road-side EDGE at least this far from the subject path.
 *  Enforced against the body's OBB CORNERS/EDGE SAMPLES, not its centre: the
 *  centre-distance heuristic assumed the body sits perfectly parallel to a
 *  straight path, but the yaw comes from a multi-point approach CHORD — a 10 m
 *  firetruck with a few degrees of chord error has corners ~0.5-0.9 m closer to
 *  the lane than its centre, which is how "occluder in the subject corridor" scenes
 *  shipped (2026-08-01 corpus: easterbrook ped-62651-0/-4, munich ped-midblock-4,
 *  rightped-150-0 — the reactive subject rested against the occluder body edge and
 *  stalled to clip end).
 *  TODO(ped-399-6): this fixed value is INSIDE a wide lane's half-width → the
 *  occluder body reads as in-lane on wide roads. The correct fix uses the ACTUAL
 *  runtime lane half-width at the site (max(1.65, laneHalfWidth)); plumbing the
 *  lane width into buildOccluderCar is a deferred follow-up. A blanket raise here
 *  over-rejects narrow office-park lanes (drops valid occluders). */
const OCCLUDER_MIN_EDGE_CLEARANCE_M = 1.65;
/** LOS verifier: the subject's sightline is taken from ~this far before the conflict
 *  (where it would first see the ped) to the ped, and the occluder body must
 *  straddle it. Guards the "occluder placed but the gap is too large to block
 *  anything" defect (ped-18257-6). */
const OCCLUDER_LOS_SIGHT_M = 15;
/** Slack added to the occluder half-width when checking it covers the sightline. */
const OCCLUDER_LOS_MARGIN_M = 0.6;
/** Centre clearance for a car occluder (= edge clearance + car half-width = 2.6m,
 *  the historical value). Used by the cyclist right-hook occluder, which is always
 *  a car. */
const OCCLUDER_MIN_SUBJECT_CLEARANCE_M =
  OCCLUDER_MIN_EDGE_CLEARANCE_M + DEFAULT_OCCLUDER_FOOTPRINT.width / 2;

/** OBB footprint of a POINT-ANCHORED vehicle draft (occluder / parked dressing /
 *  any spawned vehicle body): known blueprint footprints, else the default car.
 *  null for drafts without an explicit spawn point (road-anchored ambient — no
 *  authored world pose to box). */
function vehicleObbOf(a: ScenarioEditorActorDraft): ObbFootprint | null {
  if (!a.spawn_point) return null;
  const fp =
    OCCLUDER_FOOTPRINT_M[a.blueprint] ??
    (a.blueprint === VAN_OCCLUDER_BLUEPRINT ? VAN_OCCLUDER_FOOTPRINT : DEFAULT_OCCLUDER_FOOTPRINT);
  return {
    cx: a.spawn_point.x,
    cy: a.spawn_point.y,
    yawDeg: a.spawn_yaw ?? 0,
    lengthM: fp.length,
    widthM: fp.width,
  };
}

/** A walker draft's walk polyline: spawn + timed waypoints, in order. */
function walkPathOf(a: ScenarioEditorActorDraft): Array<{ x: number; y: number }> {
  return [
    ...(a.spawn_point ? [{ x: a.spawn_point.x, y: a.spawn_point.y }] : []),
    ...(a.timed_waypoints ?? []).map((w) => ({ x: w.x, y: w.y })),
  ];
}

// ── P-1: occluder relocate-or-substitute (dib 2026-07-27 US turn-occlusion) ──
// The A2 occluder↔walk-path clearance pass used to DROP an occluder that
// overlapped the conflict ped's walk path. Because the sightline placement
// deliberately hugs the ped spawn, MOST bodies failed the 0.6 m clearance and
// vanished silently — 9/12 reviewed "van-occlusion" scenes had no van (RC-1).
// Instead: slide the body along its own curb line looking for a position that
// still occludes the subject→ped sightline AND clears the walk path; if no van-size
// slot fits, substitute a CAR-class footprint ("a regular vehicle is better
// than no occluder at all"); only then drop — with honest metadata.

/** Slide step + span along the curb line for the relocation search. */
const OCCLUDER_RELOCATE_STEP_M = 0.75;
const OCCLUDER_RELOCATE_MAX_OFFSET_M = 6;
/** CAR-class substitution pool: the regular parked-car bodies from
 *  OCCLUDER_BLUEPRINTS (the Sprinter van is the body being substituted AWAY). */
const CAR_CLASS_OCCLUDER_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
];

/** Sightline occluder ids from the population step (van or the P-1.4 car). */
function isSightlineOccluderId(id: string): boolean {
  return id.startsWith("occluder-van") || id.startsWith("occluder-car");
}

/** Slide offsets in preference order: closest-to-optimal first, both sides. */
function relocationOffsetsM(): number[] {
  const out: number[] = [0];
  for (let m = OCCLUDER_RELOCATE_STEP_M; m <= OCCLUDER_RELOCATE_MAX_OFFSET_M + 1e-9; m += OCCLUDER_RELOCATE_STEP_M) {
    out.push(m, -m);
  }
  return out;
}

/**
 * The subject's "eye" ~OCCLUDER_LOS_SIGHT_M upstream of the conflict along its
 * approach — the origin of the sightline the occluder must straddle. Mirrors
 * the chord logic in buildOccluderCar so both agree on the approach direction.
 */
function subjectEyeForPedSightline(subjectPath: ReadonlyArray<Vec2>, pedSpawn: Vec2): Vec2 | null {
  if (subjectPath.length < 2) return null;
  let ci = 0;
  let cBest = Infinity;
  for (let i = 0; i < subjectPath.length; i++) {
    const d2 = (subjectPath[i]!.x - pedSpawn.x) ** 2 + (subjectPath[i]!.y - pedSpawn.y) ** 2;
    if (d2 < cBest) {
      cBest = d2;
      ci = i;
    }
  }
  const from = subjectPath[Math.max(0, ci - 3)]!;
  const to = subjectPath[ci]!;
  const dl = Math.hypot(to.x - from.x, to.y - from.y);
  if (dl < 1e-3) return null;
  const ex = (to.x - from.x) / dl;
  const ey = (to.y - from.y) / dl;
  return { x: to.x - ex * OCCLUDER_LOS_SIGHT_M, y: to.y - ey * OCCLUDER_LOS_SIGHT_M };
}

export interface OccluderRelocationInput {
  /** The occluder body that failed the walk-path clearance (position + yaw + blueprint). */
  occluder: ScenarioEditorActorDraft;
  /** The conflict ped's walk polyline the body must clear (PED_OCCLUDER_CLEARANCE_M). */
  conflictPedPath: WalkPath;
  /** The subject's approach polyline — lane-clearance guard + the sightline origin. */
  subjectPath: ReadonlyArray<Vec2>;
  /** The ped's reveal point (its curb spawn) — the sightline's far end. */
  pedSpawn: Vec2;
  /** P-1.4: World-Partition (Munich) narrow streets try the CAR-class body FIRST. */
  preferCarFirst?: boolean;
  /** Deterministic car-blueprint pick for the substitution. */
  blueprintIndex?: number;
}

/**
 * P-1.1/P-1.2: search alternative occluder positions along the SAME curb line
 * (0.75 m slides up to ±6 m from the sightline-optimal spot, closest first) for
 * one that still occludes the subject→ped sightline (the eye→reveal segment must
 * intersect the body OBB) AND clears the conflict ped's walk path AND stays out
 * of the subject's lane. If no position fits the original body class, retry with a
 * CAR-class footprint (regular parked car). Returns the relocated/substituted
 * draft (a clone — the input is not mutated), or null when nothing fits.
 */
export function relocateOccluderClearOfWalkPath(
  input: OccluderRelocationInput,
): ScenarioEditorActorDraft | null {
  const body = input.occluder;
  if (!body.spawn_point) return null;
  const yawDeg = body.spawn_yaw ?? 0;
  const rad = (yawDeg * Math.PI) / 180;
  const axis = { x: Math.cos(rad), y: Math.sin(rad) };
  const eye = subjectEyeForPedSightline(input.subjectPath, input.pedSpawn);
  if (!eye) return null;

  const ownFootprint =
    OCCLUDER_FOOTPRINT_M[body.blueprint] ??
    (body.blueprint === VAN_OCCLUDER_BLUEPRINT ? VAN_OCCLUDER_FOOTPRINT : DEFAULT_OCCLUDER_FOOTPRINT);
  const carBlueprint =
    CAR_CLASS_OCCLUDER_BLUEPRINTS[(input.blueprintIndex ?? 0) % CAR_CLASS_OCCLUDER_BLUEPRINTS.length]!;
  const own = { footprint: ownFootprint, blueprint: body.blueprint, substituted: false };
  const car = { footprint: CAR_OCCLUDER_FOOTPRINT, blueprint: carBlueprint, substituted: true };
  const ownIsCarSized = ownFootprint.length <= CAR_OCCLUDER_FOOTPRINT.length + 0.05;
  const classes = ownIsCarSized ? [own] : input.preferCarFirst ? [car, own] : [own, car];

  for (const cls of classes) {
    const minSubjectClearanceM = OCCLUDER_MIN_EDGE_CLEARANCE_M + cls.footprint.width / 2;
    for (const off of relocationOffsetsM()) {
      const cx = body.spawn_point.x + axis.x * off;
      const cy = body.spawn_point.y + axis.y * off;
      const obb: ObbFootprint = {
        cx,
        cy,
        yawDeg,
        lengthM: cls.footprint.length,
        widthM: cls.footprint.width,
      };
      // 1. The conflict ped's crossing stays clear of the (inflated) body.
      if (
        input.conflictPedPath.length > 0 &&
        !pathClearsObb(input.conflictPedPath, obb, PED_OCCLUDER_CLEARANCE_M)
      ) {
        continue;
      }
      // 2. Still an occluder: the subject-eye→reveal-point sightline crosses the body.
      if (!segmentIntersectsObb(eye, input.pedSpawn, obb)) continue;
      // 3. Never in the subject's lane (measured to path SEGMENTS, like the builders).
      if (
        input.subjectPath.length >= 2 &&
        distanceToPolyline({ x: cx, y: cy }, input.subjectPath) < minSubjectClearanceM
      ) {
        continue;
      }
      return {
        ...body,
        blueprint: cls.blueprint,
        label: cls.substituted ? "Parked car (occluder)" : body.label,
        spawn_point: { x: Math.round(cx * 1000) / 1000, y: Math.round(cy * 1000) / 1000 },
      };
    }
  }
  return null;
}

/**
 * P-1.5: orient a parked occluder body to FACE the travel direction of its
 * nearest driving lane (the lane the curb belongs to). The builders yaw the
 * body along the SUBJECT's approach direction, which faces AGAINST traffic whenever
 * the body parks on the oncoming side's curb (RC-5, dib review: "the van should
 * face the direction of traffic"). The body stays parallel to the curb — this
 * only FLIPS it 180° when it opposes the adjacent lane's heading, so the OBB
 * (symmetric) and every clearance/LOS check are unchanged. Mutates in place.
 */
export function orientOccluderWithTraffic(
  occluder: ScenarioEditorActorDraft,
  segments: ReadonlyArray<RuntimeRoadSegment>,
): void {
  if (!occluder.spawn_point || occluder.spawn_yaw == null) return;
  const p = occluder.spawn_point;
  let best: { d2: number; yawDeg: number } | null = null;
  for (const seg of segments) {
    const laneType = (seg.lane_type ?? "").toLowerCase();
    if (laneType !== "driving" && laneType !== "bidirectional") continue;
    const line = seg.centerline ?? [];
    for (let i = 0; i < line.length; i++) {
      const v = line[i]!;
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      const d2 = (v.x - p.x) ** 2 + (v.y - p.y) ** 2;
      if (best && d2 >= best.d2) continue;
      // Lane travel heading at this vertex: the stored runtime yaw (degrees),
      // else the direction to the next/previous vertex.
      let yawDeg: number | null = Number.isFinite(v.yaw) ? (v.yaw as number) : null;
      if (yawDeg == null) {
        const nb = line[i + 1] ?? line[i - 1];
        if (nb) {
          const sign = line[i + 1] ? 1 : -1;
          const dx = (nb.x - v.x) * sign;
          const dy = (nb.y - v.y) * sign;
          if (Math.hypot(dx, dy) > 1e-6) yawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        }
      }
      if (yawDeg == null) continue;
      best = { d2, yawDeg };
    }
  }
  if (!best) return;
  const wrap = (d: number): number => (((d + 180) % 360) + 360) % 360 - 180;
  if (Math.abs(wrap(best.yawDeg - occluder.spawn_yaw)) > 90) {
    occluder.spawn_yaw = Math.round(wrap(occluder.spawn_yaw + 180) * 100) / 100;
  }
}

/** Result of the M-4 walker-spawn hygiene pass (see applyWalkerSpawnHygiene). */
export interface WalkerSpawnHygieneResult {
  /** Primary actors with unshiftable companion walkers dropped + shifts applied. */
  actors: ScenarioEditorActorDraft[];
  /** Background actors with unshiftable background walkers dropped + shifts applied. */
  background: ScenarioEditorActorDraft[];
  /** True when the CONFLICT ped ("ped") spawn cannot be cleared — reject the site. */
  rejectSite: boolean;
  /** Walker ids whose spawn was laterally shifted clear of a vehicle body. */
  shiftedIds: string[];
  /** Companion/background walker ids dropped (spawn unshiftable). */
  droppedIds: string[];
}

/**
 * M-4 (dib 2026-07-27 Munich review): walker SPAWN hygiene — no pedestrian may
 * spawn inside any vehicle body's OBB footprint (parked dressing, occluders,
 * the NPC/subject spawn pose). A walker materializing ON a parked car either
 * sky-drops at clip start when physics grounds it (the reviewed visual) or
 * wedges against the body and never walks. Resolution per walker:
 *   1. spawn already clear → untouched (byte-identical drafts);
 *   2. lateral shifts ±1.0 / ±1.5 m perpendicular to the walk direction — the
 *      first that clears EVERY vehicle body moves the spawn (and its coincident
 *      first timed waypoint, so the walker doesn't step back into the body);
 *   3. no candidate clears → drop the walker (companion/background) or flag the
 *      SITE for rejection (the conflict ped is the scene — it cannot be dropped).
 * Mutates the shifted walker drafts in place (generator convention); exported
 * for unit tests.
 */
export function applyWalkerSpawnHygiene(input: {
  actors: ReadonlyArray<ScenarioEditorActorDraft>;
  background: ReadonlyArray<ScenarioEditorActorDraft>;
  occluder?: ScenarioEditorActorDraft | null;
}): WalkerSpawnHygieneResult {
  const obbs = [
    ...input.actors,
    ...(input.occluder ? [input.occluder] : []),
    ...input.background,
  ]
    .filter((a) => a.kind === "vehicle")
    .map(vehicleObbOf)
    .filter((o): o is ObbFootprint => o !== null);
  const shiftedIds: string[] = [];
  const droppedIds: string[] = [];
  let rejectSite = false;
  /** Returns whether to KEEP the walker; applies shifts in place. */
  const resolveWalker = (a: ScenarioEditorActorDraft): boolean => {
    if (a.kind !== "walker" || !a.spawn_point) return true;
    const spawn = { x: a.spawn_point.x, y: a.spawn_point.y };
    // Walk direction: spawn → first distinct path point.
    const path = walkPathOf(a);
    let walkDir: { x: number; y: number } | null = null;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i]!.x - spawn.x;
      const dy = path[i]!.y - spawn.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        walkDir = { x: dx, y: dy };
        break;
      }
    }
    const resolved = resolveWalkerSpawnClearOfVehicles(spawn, walkDir, obbs);
    if (resolved === spawn) return true; // already clear (identity-preserving contract)
    if (resolved) {
      const shifted = {
        x: Math.round(resolved.x * 1000) / 1000,
        y: Math.round(resolved.y * 1000) / 1000,
      };
      // A walker's first timed waypoint IS its spawn (pedestrianActor / the
      // planner's crossing start): move it with the spawn so the first stride
      // doesn't step straight back into the vehicle body.
      const first = a.timed_waypoints?.[0];
      if (first && Math.hypot(first.x - spawn.x, first.y - spawn.y) <= 0.25) {
        first.x = shifted.x;
        first.y = shifted.y;
      }
      a.spawn_point = shifted;
      shiftedIds.push(a.id);
      return true;
    }
    if (a.id === "ped") {
      rejectSite = true; // the conflict ped is the scene — reject the whole site
      return true;
    }
    droppedIds.push(a.id);
    return false;
  };
  const actors = input.actors.filter(resolveWalker);
  const background = input.background.filter(resolveWalker);
  return { actors, background, rejectSite, shiftedIds, droppedIds };
}

type OccluderKind = "bus" | "large" | "medium" | "car";
/** Request-level occluder class: which body the truck-warranting subtypes draw.
 *  Mirrors `ScenarioRequestSchema.occluderClass`. */
type OccluderClass = "large" | "medium" | "car";

/** Occluder vehicle class for an occlusion subtype (from the ped-region detector).
 *  `occluderClass: "medium"` swaps the truck-class sites (street parking near the
 *  conflict, commercial delivery bays) to the medium van — the DISTINCT variation
 *  for tight sites where the large bodies null_handle. Bus stops keep the bus
 *  (context-appropriate, and bus pull-outs are purpose-built spawn space); plain
 *  parked-car sites keep the car either way. */
function occluderKindForSubtype(
  subtype: string | undefined,
  occluderClass: OccluderClass,
): OccluderKind {
  // `occluderClass: "car"` overrides the site's own class everywhere, bus stops
  // included (dib 2026-07-29). For "child emerges from behind an obstruction" a
  // kerbside car IS the canonical occluder, and it is also the SMALLEST body:
  // placement scales its clearance off the footprint (`minSubjectClearanceM =
  // OCCLUDER_MIN_EDGE_CLEARANCE_M + width/2`) and sits it `length/2 + 0.5`
  // upstream, so a 4.7x1.9 m car needs ~1.2 m less longitudinal room and ~0.05 m
  // less lateral room than the 5.9x2.0 m Sprinter — which is why widening the
  // pool also lifts the fraction of sites that get any occluder at all.
  if (occluderClass === "car") return "car";
  if (subtype === "BUS_STOP_OCCLUSION") return "bus";
  if (subtype === "PARKING_NEAR_CONFLICT_POINT" || subtype === "COMMERCIAL_DELIVERY_OCCLUSION") {
    return occluderClass === "medium" ? "medium" : "large";
  }
  return "car";
}

function occluderBlueprintForKind(kind: OccluderKind, index: number): string {
  const pool =
    kind === "bus"
      ? BUS_OCCLUDER_BLUEPRINTS
      : kind === "large"
        ? LARGE_OCCLUDER_BLUEPRINTS
        : kind === "medium"
          ? MEDIUM_OCCLUDER_BLUEPRINTS
          : OCCLUDER_BLUEPRINTS;
  return pool[index % pool.length]!;
}

/** Ordered world path of an actor draft: spawn_point then timed_waypoints. */
function actorPath(actor: ScenarioEditorActorDraft): Vec2[] {
  const pts: Vec2[] = [];
  if (actor.spawn_point) pts.push({ x: actor.spawn_point.x, y: actor.spawn_point.y });
  for (const w of actor.timed_waypoints ?? []) pts.push({ x: w.x, y: w.y });
  return pts;
}

/** Perpendicular distance from p to the SEGMENT ab (not to its endpoints). */
function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** Distance from p to a polyline, measured to its SEGMENTS. */
function distanceToPolyline(p: Vec2, pts: ReadonlyArray<Vec2>): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = distanceToSegment(p, pts[i]!, pts[i + 1]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The corridor the subject will actually drive, for keeping obstacles out of its lane.
 *
 * A `timed_path` subject (the pedestrian families) carries its polyline in
 * `timed_waypoints`. A `road` subject (the TURN families) carries NOTHING — `route` is
 * empty and there are no waypoints, so {@link actorPath} returns just the single
 * spawn_point. Measuring clearance against that one point silently degrades "keep the
 * occluder off the subject's path" into "keep it off the subject's spawn", which is no guard at
 * all: measured on r6, right-hook occluders were parked 46 m down the subject's own lane
 * (occluder at 830.5,1654.8 vs subject spawn at 826.4,1701.1 — the guard saw 46 m of
 * clearance and passed). The subject drove up, hard-braked, stopped, and never reached the
 * junction: 5 of 19 right-turn subjects ended `observed_maneuver: stop`.
 *
 * With no polyline, the subject still has a spawn and a conflict point, and it drives from
 * one to the other — that segment IS its approach corridor. Use it.
 */
function subjectApproachCorridor(
  subject: ScenarioEditorActorDraft,
  conflictPoint: Vec2 | null,
): Vec2[] {
  const path = actorPath(subject);
  if (path.length >= 2) return path;
  if (path.length === 1 && conflictPoint) return [path[0]!, conflictPoint];
  return path;
}

/**
 * A static parked car positioned to occlude the conflict pedestrian until it
 * emerges into the AV path. Built from the POST-SNAP subject + walker drafts (so it
 * aligns with what the worker actually spawns): find where the subject path passes
 * closest to the walker's curb spawn (≈ the conflict), take the subject's APPROACH
 * direction there from a multi-point chord (robust vs a noisy single segment),
 * and park the car one car-length UPSTREAM of the walker along that approach —
 * between the oncoming subject and the pedestrian. Returns null when geometry is
 * unavailable or the car would intrude on the subject's path.
 */
function buildOccluderCar(
  actors: ReadonlyArray<ScenarioEditorActorDraft>,
  subtype: string | undefined,
  index: number,
  occluderClass: OccluderClass = "large",
  conflictPoint: Vec2 | null = null,
): ScenarioEditorActorDraft | null {
  const subject = plannedSubjectActor(actors);
  const walker = actors.find((a) => a.id === "ped" && a.role === "pedestrian");
  if (!subject || !walker?.spawn_point) return null;
  // A `road`-mode subject — what the COLLISION turn-ped variant uses, since it drives
  // the CARLA-native turn primitive — carries no waypoints, so actorPath() returns
  // only its spawn point and this bailed out. That is why turn-across-crosswalk
  // scenes could never carry a placed occluder. subjectApproachCorridor supplies the
  // spawn→conflict segment the subject actually drives (dib 2026-07-29).
  //
  // On a turn that chord is a straight line across a junction the subject really takes
  // as an arc, so the approach direction derived from it is approximate. It does
  // not need to be exact: the LOS verifier at the end of this function requires the
  // placed body to sit within a half-width of the subject→ped sightline and returns
  // null otherwise, so a mis-derived direction drops the occluder — and, under
  // requireOccluder, the scene — rather than shipping a body that occludes nothing.
  // The approximation costs yield here, never correctness.
  const path = subjectApproachCorridor(subject, conflictPoint);
  if (path.length < 2) return null;
  // Context-appropriate occluder + footprint-scaled placement.
  const kind = occluderKindForSubtype(subtype, occluderClass);
  const blueprint = occluderBlueprintForKind(kind, index);
  const footprint = OCCLUDER_FOOTPRINT_M[blueprint] ?? DEFAULT_OCCLUDER_FOOTPRINT;
  // Sit one half-length (+0.5m) upstream so the body's downstream end is at the
  // ped and the rest extends back toward the subject — the ped stays hidden until it
  // clears the occluder. (car → 2.85m, box truck → 3.75m, bus → 6.5m.)
  const upstreamM = footprint.length / 2 + 0.5;
  const label =
    kind === "bus"
      ? "Bus at stop (occluder)"
      : kind === "large"
        ? "Large vehicle (occluder)"
        : kind === "medium"
          ? "Medium vehicle (occluder)"
          : "Parked car (occluder)";
  const s = { x: walker.spawn_point.x, y: walker.spawn_point.y };
  // Closest subject-path index to the walker spawn ≈ the conflict.
  let ci = 0;
  let cBest = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d2 = (path[i]!.x - s.x) ** 2 + (path[i]!.y - s.y) ** 2;
    if (d2 < cBest) {
      cBest = d2;
      ci = i;
    }
  }
  // Approach direction from a chord ending at the conflict (≥3 pts back, or the
  // whole prefix) — the subject is moving toward the conflict in this direction.
  const from = path[Math.max(0, ci - 3)]!;
  const to = path[ci]!;
  const dl = Math.hypot(to.x - from.x, to.y - from.y);
  if (dl < 1e-3) return null;
  const ex = (to.x - from.x) / dl;
  const ey = (to.y - from.y) / dl;
  // Nudge the car off the sidewalk into the parking strip (toward the road, i.e.
  // toward the conflict the walker crosses to) so the subject's sightline to the
  // emerging ped is actually blocked. Capped to a fraction of the curb→conflict
  // distance and guarded below so it never reaches the driving lane.
  const toRoadX = to.x - s.x;
  const toRoadY = to.y - s.y;
  const trl = Math.hypot(toRoadX, toRoadY) || 1;
  const insetMax = Math.min(OCCLUDER_ROAD_INSET_M, 0.35 * trl);
  const nx = toRoadX / trl;
  const ny = toRoadY / trl;
  // Base position at the kerb (no road-ward nudge). The upstream offset is ALONG the
  // approach, so it doesn't change the perpendicular distance to the subject path.
  const baseX = s.x - ex * upstreamM;
  const baseY = s.y - ey * upstreamM;
  // Never place the body in the subject's lane. The clearance is measured on the
  // BODY, not its centre: the OBB's four corners plus the road-side edge
  // midpoints, each against the path segments (distanceToPolyline measures to
  // SEGMENTS, not vertices — a vertex-only check lets an occluder sit in-lane
  // between waypoints). The old centre-distance form (centre ≥ edge + width/2)
  // is exact only for a zero-yaw body beside a straight path; the yaw comes
  // from an approach CHORD, and a long body with chord error put its corners
  // deep into the corridor (the 2026-08-01 occluder-in-lane stalls). Wide/long
  // bodies are therefore pushed out exactly as far as their WORST sample needs.
  // Rather than reject when the road-ward nudge would intrude, nudge only as
  // far as the edge-clearance allows (≈linear in the nudge → interpolate),
  // pulling wide bodies back toward the kerb — same recovery as the UE5 #348
  // wide-body fix.
  const bodyYawRad = Math.atan2(ey, ex);
  const bodyCos = Math.cos(bodyYawRad);
  const bodySin = Math.sin(bodyYawRad);
  const halfL = footprint.length / 2;
  const halfW = footprint.width / 2;
  const bodyEdgeClearanceAt = (cx: number, cy: number): number => {
    let min = Infinity;
    for (const [dl, dw] of [
      [halfL, halfW],
      [halfL, -halfW],
      [-halfL, halfW],
      [-halfL, -halfW],
      [0, halfW],
      [0, -halfW],
    ] as const) {
      const qx = cx + dl * bodyCos - dw * bodySin;
      const qy = cy + dl * bodySin + dw * bodyCos;
      const d = distanceToPolyline({ x: qx, y: qy }, path);
      if (d < min) min = d;
    }
    return min;
  };
  const dKerb = bodyEdgeClearanceAt(baseX, baseY);
  if (dKerb < OCCLUDER_MIN_EDGE_CLEARANCE_M) return null; // in-lane even at the kerb — bad site
  let inset = insetMax;
  const dFull = bodyEdgeClearanceAt(baseX + nx * inset, baseY + ny * inset);
  if (dFull < OCCLUDER_MIN_EDGE_CLEARANCE_M && dFull < dKerb) {
    inset *= Math.max(0, (OCCLUDER_MIN_EDGE_CLEARANCE_M - dKerb) / (dFull - dKerb));
  }
  const px = baseX + nx * inset;
  const py = baseY + ny * inset;
  // Safety net for the piecewise-linear interpolation on curved approaches.
  if (bodyEdgeClearanceAt(px, py) < OCCLUDER_MIN_EDGE_CLEARANCE_M - 1e-3) return null;
  // LOS verifier: the occluder must sit ON the subject's sightline to the ped, not
  // beside it. Take the sightline from where the subject is ~OCCLUDER_LOS_SIGHT_M
  // before the conflict to the ped, and require the occluder centre within a body
  // half-width (+ slack) of that line — else it blocks nothing (ped-18257-6).
  const lx = to.x - ex * OCCLUDER_LOS_SIGHT_M; // subject eye ON ITS PATH, sight-dist upstream
  const ly = to.y - ey * OCCLUDER_LOS_SIGHT_M;
  const vx = s.x - lx; // sightline: subject eye (on the road) -> ped (on the curb)
  const vy = s.y - ly;
  const vlen = Math.hypot(vx, vy) || 1;
  // perpendicular distance from the occluder centre (px,py) to the sightline.
  const perpDist = Math.abs((px - lx) * vy - (py - ly) * vx) / vlen;
  if (perpDist > footprint.width / 2 + OCCLUDER_LOS_MARGIN_M) return null;
  const yawDeg = (Math.atan2(ey, ex) * 180) / Math.PI;
  return {
    id: `occluder-${index}`,
    label,
    kind: "vehicle",
    role: "traffic",
    is_static: true,
    placement_mode: "point",
    blueprint,
    color: OCCLUDER_COLOR,
    spawn: { road_id: "", section_id: null, lane_id: null, s_fraction: 0 },
    spawn_point: { x: Math.round(px * 1000) / 1000, y: Math.round(py * 1000) / 1000 },
    spawn_yaw: Math.round(yawDeg * 100) / 100,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    path_placement: [],
    speed_kph: 0,
    autopilot: false,
    timeline: [],
    sensors: [],
  } as ScenarioEditorActorDraft;
}

/** How far upstream of the conflict (along the through-actor's approach) the
 *  right-hook occluder sits — about a car length, so the cyclist riding up in
 *  the bike lane is hidden behind the parked car until just before the conflict. */
const OCCLUDER_CYCLIST_UPSTREAM_M = 7.0;
/** The right-hook occluder must sit BESIDE the through-actor's lane, never in
 *  it (frozen-NPC review 2026-07-28: the occluder was placed ON the NPC's
 *  approach line, so the worker's car-following stopped the conflict NPC 9 m
 *  behind its own occluder for the whole clip — 4/4 occluded right-hook scenes).
 *  Curb-side lateral offset + minimum clearance to the NPC path. */
const OCCLUDER_CYCLIST_LATERAL_M = 2.4;
const OCCLUDER_NPC_PATH_CLEARANCE_M = 2.0;

/**
 * Right-hook occluder (workstream D for bikes): a parked car just upstream of
 * the conflict on the through-actor's (cyclist's) approach, so the cyclist the
 * subject turns across is hidden until the last moment. Unlike {@link buildOccluderCar}
 * (keyed off a walker spawn), this keys off the conflict point + the conflicting
 * NPC's approach heading. Guarded off the subject's path like the pedestrian case.
 */
function buildCyclistOccluderCar(
  actors: ReadonlyArray<ScenarioEditorActorDraft>,
  conflictPoint: { x: number; y: number },
  index: number,
): ScenarioEditorActorDraft | null {
  const subject = plannedSubjectActor(actors);
  const npc = actors.find(
    (actor) =>
      actor.id !== subject?.id &&
      actor.role !== "pedestrian" &&
      actor.placement_mode === "timed_path",
  );
  if (!subject || !npc) return null;
  const npcPath = actorPath(npc);
  if (npcPath.length < 2) return null;
  // Closest NPC-path index to the conflict ≈ where the cyclist meets the subject.
  let ci = 0;
  let cBest = Infinity;
  for (let i = 0; i < npcPath.length; i++) {
    const d2 = (npcPath[i]!.x - conflictPoint.x) ** 2 + (npcPath[i]!.y - conflictPoint.y) ** 2;
    if (d2 < cBest) {
      cBest = d2;
      ci = i;
    }
  }
  const from = npcPath[Math.max(0, ci - 3)]!;
  const to = npcPath[ci]!;
  const dl = Math.hypot(to.x - from.x, to.y - from.y);
  if (dl < 1e-3) return null; // no approach heading
  const ux = (to.x - from.x) / dl;
  const uy = (to.y - from.y) / dl;
  // One car-length back along the cyclist's approach: the bike rides up from
  // behind this parked car into the conflict — parked at the CURB BESIDE the
  // lane, never in it (a body on the NPC's own line stops the NPC behind it —
  // the frozen-conflict-NPC review class). Curb side = the side AWAY from the
  // subject's corridor.
  const corridor = subjectApproachCorridor(subject, conflictPoint);
  if (corridor.length < 2) return null; // no corridor to verify against -> fail CLOSED
  const bx = conflictPoint.x - ux * OCCLUDER_CYCLIST_UPSTREAM_M;
  const by = conflictPoint.y - uy * OCCLUDER_CYCLIST_UPSTREAM_M;
  // Perpendicular to the NPC approach; pick the sign pointing AWAY from the subject
  // corridor (the curb side of the through lane).
  const cand = [
    { x: bx - uy * OCCLUDER_CYCLIST_LATERAL_M, y: by + ux * OCCLUDER_CYCLIST_LATERAL_M },
    { x: bx + uy * OCCLUDER_CYCLIST_LATERAL_M, y: by - ux * OCCLUDER_CYCLIST_LATERAL_M },
  ].sort(
    (a, b) => distanceToPolyline(b, corridor) - distanceToPolyline(a, corridor),
  );
  let placed: Vec2 | null = null;
  for (const c of cand) {
    if (distanceToPolyline(c, corridor) < OCCLUDER_MIN_SUBJECT_CLEARANCE_M) continue;
    if (distanceToPolyline(c, npcPath) < OCCLUDER_NPC_PATH_CLEARANCE_M) continue;
    placed = c;
    break;
  }
  if (!placed) return null; // no curb slot clears BOTH lanes — drop the occluder
  const px = placed.x;
  const py = placed.y;
  const yawDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
  return {
    id: `occluder-${index}`,
    label: "Parked car (occluder)",
    kind: "vehicle",
    role: "traffic",
    is_static: true,
    placement_mode: "point",
    blueprint: OCCLUDER_BLUEPRINTS[index % OCCLUDER_BLUEPRINTS.length]!,
    color: OCCLUDER_COLOR,
    spawn: { road_id: "", section_id: null, lane_id: null, s_fraction: 0 },
    spawn_point: { x: Math.round(px * 1000) / 1000, y: Math.round(py * 1000) / 1000 },
    spawn_yaw: Math.round(yawDeg * 100) / 100,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    path_placement: [],
    speed_kph: 0,
    autopilot: false,
    timeline: [],
    sensors: [],
  } as ScenarioEditorActorDraft;
}

/**
 * The subject's junction maneuver for a site. Prefers the planner's solved gate
 * (`subjectGate.turnRelation`, present on Tier-0 gated turn plans), falling back to
 * the family name so legacy/heuristic turn plans still get the primitive.
 * Non-turn families (pedestrian_crossing, rear_end, sideswipe, cut_in) → null.
 * The turn-across-crosswalk families carry a subjectGate.turnRelation of Left/Right,
 * so they get the primitive via the gate branch above.
 */
function subjectTurnForSite(
  family: ScenarioRequest["scenarioFamily"],
  turnRelation: string | undefined,
): SubjectTurn {
  if (turnRelation === "Left") return "left";
  if (turnRelation === "Right") return "right";
  if (turnRelation === "Straight") return null;
  if (family === "unprotected_left_turn") return "left";
  if (family === "right_turn_hook") return "right";
  return null;
}

/** Families whose conflicting principal is a CROSSING PEDESTRIAN (walker), so the
 *  planner produces a walker and the draft gets companion peds + a ped
 *  collision_target_id. Covers the straight pedestrian_crossing AND the two
 *  turn-across-crosswalk families (which add a turning subject on top). */
function isPedCrossingFamily(family: ScenarioRequest["scenarioFamily"]): boolean {
  return (
    family === "pedestrian_crossing" ||
    family === "left_turn_ped_crosswalk" ||
    family === "right_turn_ped_crosswalk"
  );
}

/** True for the turn-across-crosswalk families (subject turns onto the ped's leg). */
function isTurnPedCrosswalkFamily(family: ScenarioRequest["scenarioFamily"]): boolean {
  return family === "left_turn_ped_crosswalk" || family === "right_turn_ped_crosswalk";
}

/** Families whose SUBJECT must physically turn through a junction — the P-3
 *  net-heading fail-closed assertion applies to these. */
function isSubjectTurnFamily(family: ScenarioRequest["scenarioFamily"]): boolean {
  return (
    isTurnPedCrosswalkFamily(family) ||
    family === "unprotected_left_turn" ||
    family === "right_turn_hook"
  );
}

// ── P-3.3 fail-closed turn-route assertion (dib 2026-07-27) ─────────────────
// rightped-849-1 shipped an authored subject path with 0° net heading change over
// 109 waypoints — a "turn" scene with no turn (the run-up was consumed inside a
// 55 m junction connector, so the route began PAST the arc). The planner fix
// removes the cause; this assertion makes the CLASS unshippable: any turn-family
// draft whose authored subject route nets < 45° of heading change is rejected with
// a countable reason.
export const TURN_ROUTE_STRAIGHT_REASON = "turn_route_straight";
const TURN_ROUTE_MIN_NET_HEADING_DEG = 45;

// ── Driveway map-edge floor (operator round 2 — richmond rightped-279-0:
// "driveway too close to edge of map") ───────────────────────────────────────
// A driveway scene points the camera INTO the parcel at the stub's end, so the
// world edge shows far sooner than for a through-street scene (the general
// 30 m site-edge gate was not enough: 279's authored geometry reached 53.6 m
// from the drivable hull). Every authored point of the DRIVEWAY scene's
// principals (subject route incl. the stub, walker crossing) must sit at least
// this far inside the drivable network's bounding hull.
export const DRIVEWAY_MAP_EDGE_REASON = "entrance_map_edge";
const DRIVEWAY_MAP_EDGE_FLOOR_M = 60;

/** Bounding box of the DRIVING runtime road network (the CARLA-truth hull). */
function drivableSegmentBounds(
  segments: ReadonlyArray<RuntimeRoadSegment>,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const seg of segments) {
    const laneType = (seg.lane_type ?? "").toLowerCase();
    if (laneType && laneType !== "driving" && laneType !== "bidirectional") continue;
    for (const p of seg.centerline ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return Number.isFinite(minX) && Number.isFinite(minY) && maxX > minX && maxY > minY
    ? { minX, maxX, minY, maxY }
    : null;
}

/** True when every authored point of the principal actors sits at least
 *  `floorM` inside `bounds`. Exported for tests. */
export function actorsInsideMapEdgeFloor(
  actors: ReadonlyArray<ScenarioEditorActorDraft>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  floorM: number = DRIVEWAY_MAP_EDGE_FLOOR_M,
): boolean {
  const inset = (p: { x: number; y: number }): number =>
    Math.min(p.x - bounds.minX, bounds.maxX - p.x, p.y - bounds.minY, bounds.maxY - p.y);
  for (const a of actors) {
    if (a.spawn_point && inset(a.spawn_point) < floorM) return false;
    for (const w of a.timed_waypoints ?? []) {
      if (inset(w) < floorM) return false;
    }
  }
  return true;
}
/** Chord length (m) for the entry/exit heading measure — long enough to be
 *  immune to per-vertex polyline noise. */
const TURN_ROUTE_CHORD_M = 3;

/** Heading (rad) of the ~TURN_ROUTE_CHORD_M chord at the start/end of `pts`. */
function chordHeading(pts: ReadonlyArray<Vec2>, fromStart: boolean): number | null {
  const idx = fromStart ? 0 : pts.length - 1;
  const a = pts[idx]!;
  const step = fromStart ? 1 : -1;
  let j = idx;
  let acc = 0;
  while (j + step >= 0 && j + step < pts.length && acc < TURN_ROUTE_CHORD_M) {
    acc += Math.hypot(pts[j + step]!.x - pts[j]!.x, pts[j + step]!.y - pts[j]!.y);
    j += step;
  }
  const b = pts[j]!;
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) return null;
  // fromStart: heading a→b (entering the route); else b→a (leaving it).
  return fromStart ? Math.atan2(b.y - a.y, b.x - a.x) : Math.atan2(a.y - b.y, a.x - b.x);
}

/**
 * Net heading change (deg, absolute) of a planned subject ROUTE — the run-up arc
 * plus the post-conflict continuation (which completes the turn). Null when the
 * route is too short to measure (kept — the kinematic gate judges those).
 */
export function plannedRouteNetHeadingDeg(planned: PlannedActor): number | null {
  // Defensive: synthetic fixtures may omit the arrays — unmeasurable → null (kept).
  const raw = [...(planned.waypoints ?? []), ...(planned.postConflictWaypoints ?? [])];
  const pts: Vec2[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  if (pts.length < 3) return null;
  const entry = chordHeading(pts, true);
  const exit = chordHeading(pts, false);
  if (entry == null || exit == null) return null;
  let d = exit - entry;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs((d * 180) / Math.PI);
}

export interface BatchMapData {
  mapAssetId: string;
  /** CARLA/runtime map name (e.g. "Munich_Phase_1A"). Used to strip ambient VEHICLES on
   *  World-Partition maps unconditionally in the generator, so no emit path can ship the
   *  flying/damaged-car spawns (dib 2026-07-25 — the strip was only wired in some callers).
   *  Optional so older fixtures/callers still compile; absent → no strip (US maps keep theirs). */
  carlaMapName?: string;
  topology: MapTopologyIndex;
  segments: RuntimeRoadSegment[];
  regions: {
    crosswalks: ProjectedCrosswalk[];
    sidewalks: ProjectedSidewalk[];
    poiPoints: Vec2[];
    /** Kind-tagged POIs for `nearPoi` constraint filtering. */
    poiTyped: Array<{ kind: string; point: Vec2 }>;
    /** Roadside parked-vehicle occlusion sites (workstream D). Optional so older
     *  callers/fixtures that don't supply them still compile. */
    occluders?: ProjectedOccluder[];
    /** Curated combined parking-lot polygons — used to down-rank parking-lot
     *  aisle junctions so street unprotected-lefts dominate. Optional. */
    parkingLots?: ProjectedParkingLot[];
    /** RoadRunner ParkingSpace bay centroids (runtime meters) — driveway
     *  classifier evidence (a stub feeding bays = a lot entrance). Optional. */
    parkingSpacePoints?: Vec2[];
    /** The SAME bays with their head-in heading — the second parked-car source
     *  for scene dressing (XODR `parking` lanes are near-absent: 1 on belmont, 0
     *  on the Saratoga school map, so `population.parked` all but no-opped).
     *  Optional; omitted → curb lanes only, unchanged. */
    parkingBays?: ParkingBayRef[];
  };
  /**
   * Per-junction corpus facts/tags for `locationConstraints` filtering, built
   * from the shared map-search corpus (`buildJunctionConstraintIndex`). Omit to
   * disable constraint filtering (the request's `locationConstraints` are then
   * inert — sites are ranked but not pre-filtered).
   */
  junctionIndex?: JunctionConstraintIndex;
}

/** One generated, kinematically-validated scenario draft with provenance. */
export interface GeneratedScenario {
  scenarioId: string;
  actors: ScenarioEditorActorDraft[];
  scenarioIntention: ScenarioIntention;
  scenarioMetadata: GeneratedScenarioMetadata;
  /** Seeded, auditable provenance — what was generated and from where. */
  generation: {
    mapAssetId: string;
    family: ScenarioRequest["scenarioFamily"];
    siteId: string;
    fitScore: number;
    plannedOutcome: ScenarioRequest["outcome"];
    /** Planned time-of-conflict (s) — feeds the draft's validationIntent. */
    conflictTimeS: number;
    seed: number;
    /** Turn-ped-crosswalk families only: the destination leg is a DRIVEWAY-like
     *  stub (ped crosses the mouth; subject stops, then pulls in). Persisted so
     *  batch reporting can count the driveway category (dib 2026-07-23: report
     *  how many driveway sites emitted AND survived). */
    drivewayExit?: boolean;
    /** Entrance turn-in subtype (operator re-scope 2026-07-28): "lot" =
     *  parking beyond the throat, "apron" = parking-free dead-end stub. Present
     *  only for entrance sites (formerly mis-labeled "driveway"). */
    entranceTurnIn?: "lot" | "apron";
    /** P-1.3 honest coverage (dib 2026-07-27): present when the request asked
     *  for a sightline occluder. The body class that actually SURVIVED placement
     *  ("van" / the P-1.2 "car" substitution), or "none" when relocation +
     *  substitution both failed and the scene ships un-occluded — so no emit
     *  layer can keep calling an occluder-less scene "-van". */
    occlusion?: "van" | "car" | "none";
  };
}

export interface BatchGenerationResult {
  scenarios: GeneratedScenario[];
  /** How many fit-ranked sites were considered to fill the request. */
  sitesConsidered: number;
  /** Sites dropped by the kinematic gate (non-convergent plans). */
  rejectedByGate: number;
  /** Countable per-reason rejection tallies for the NAMED site gates (currently
   *  only "tunnel_multilevel_site", M-6). Reasons here are ALSO counted in
   *  rejectedByGate, so existing accounting is unchanged. */
  rejectedByReason: Record<string, number>;
}

/**
 * Generate up to `request.count` validated scenario drafts for the request's
 * family. Walks the fit-ranked sites in order, planning + gating each, until
 * the count is met or the sites are exhausted.
 */
export function generateCollisionScenarioBatch(
  request: ScenarioRequest,
  map: BatchMapData,
): BatchGenerationResult {
  // Cap the turn approach speed so the subject can actually track the junction arc
  // on schedule (see TURN_APPROACH_SPEED_CAP_KPH). Pedestrian crossings keep the
  // requested speed.
  //
  // Name the families that actually turn rather than negating the one that does
  // not. Written as `!== "pedestrian_crossing"` this swept in `bicycle_merge` — a
  // straight-lane merge with no junction arc — and handed it the turn timing
  // (TURN_ARRIVAL_TIME_S 3 s / TURN_MIN_TIME_S 2.5 s instead of the 6 s / 5 s
  // default). Both rationales here are specifically about tracking a junction
  // arc, so neither applies to a merge, and that tight arrival is a large part of
  // why bike scenes made contact 1-2 s after spawn (dib 2026-07-30). A negation
  // also silently adopts every family added later.
  const isTurnFamily = TURN_FAMILIES.has(request.scenarioFamily);
  // The AVOIDED (subjectReactive) variant approaches slower: an unprotected left is
  // not arterial cruise — a real driver decelerates into the turn — and the
  // reactive yield envelope (detect → hard-brake → hold → resume) was validated
  // at ~22-30 kph. At 40 kph the 2D yield rate collapsed (r6/r7 2026-07-10:
  // 45%→41% GOOD, contacts 25-29% — side-entry threats got inside braking
  // distance). Pure collision turns keep the 40 kph arterial cap.
  const approachCapKph = request.subjectReactive
    ? Math.min(TURN_APPROACH_SPEED_CAP_KPH, 30)
    : TURN_APPROACH_SPEED_CAP_KPH;
  const subjectSpeedKph = isTurnFamily
    ? Math.min(request.subjectSpeedKph, approachCapKph)
    : request.subjectSpeedKph;
  // `bicycle_merge` is a bicycle-BY-DEFINITION family — the planner enumerates
  // (driving, biking) lane pairs and puts the NPC on the bike lane — so a caller
  // that omits npcVehicleType must still get a bicycle (blueprint, speed, and the
  // extra-cyclist stream), not the default car. An explicit npcVehicleType wins.
  const resolvedNpcVehicleType: ScenarioRequest["npcVehicleType"] =
    request.npcVehicleType ??
    (request.scenarioFamily === "bicycle_merge" ? "bicycle" : undefined);
  // Cyclists default to a realistic cruising speed (not the subject/adjacent-car
  // speed) so the right-hook bike doesn't blow through the conflict point.
  const requestedNpcSpeedKph =
    request.npcSpeedKph ??
    (resolvedNpcVehicleType === "bicycle" ? CYCLIST_SPEED_KPH : undefined);
  const npcSpeedKph = isTurnFamily
    ? Math.min(requestedNpcSpeedKph ?? subjectSpeedKph, TURN_APPROACH_SPEED_CAP_KPH)
    : requestedNpcSpeedKph ?? request.subjectSpeedKph;
  const sites = findCollisionSites({
    family: request.scenarioFamily,
    entranceOnly: request.entranceOnly ?? request.drivewayOnly,
    topology: map.topology,
    subjectSpeedKph,
    npcSpeedKph,
    minTimeS: isTurnFamily ? TURN_MIN_TIME_S : DEFAULT_MIN_TIME_S,
    arrivalTimeS: isTurnFamily ? TURN_ARRIVAL_TIME_S : DEFAULT_ARRIVAL_TIME_S,
    // Pedestrian sites resolve their crossing line from regions; right-hook
    // sites use regions to match a roadside occluder; unprotected-left sites use
    // regions' curated parking-lot polygons to down-rank parking-lot aisle
    // junctions (so street lefts dominate). Straight/other turns: none.
    regions:
      request.scenarioFamily === "pedestrian_crossing" ||
      request.scenarioFamily === "right_turn_hook" ||
      request.scenarioFamily === "unprotected_left_turn" ||
      // Turn-across-crosswalk families resolve their destination-leg crossing
      // line + rank crossing quality from the pedestrian regions.
      isTurnPedCrosswalkFamily(request.scenarioFamily)
        ? map.regions
        : undefined,
    constraints: request.locationConstraints,
    junctionIndex: map.junctionIndex,
    poiIndex: map.regions.poiTyped,
  });

  // Annotated Parking lanes for static curb-parked cars (scene dressing). Read
  // once from the topology index — the slimmed runtime bundle omits them. Empty
  // when the request asks for no parking, so it's a no-op cost.
  const parkingLanes =
    resolvePopulation(request.population).parked > 0
      ? parkingLanesFromTopology(map.topology)
      : [];

  const scenarios: GeneratedScenario[] = [];
  let rejectedByGate = 0;
  const rejectedByReason: Record<string, number> = {};
  // Driveway map-edge floor: computed once per batch (only consulted for
  // drivewayExit sites).
  const drivableBounds = drivableSegmentBounds(map.segments);

  for (const site of sites) {
    if (scenarios.length >= request.count) break;

    // Require-occluder gate: for VRU families, drop conflicts with no matched
    // roadside occluder so the ped/cyclist emerges from behind a body (low
    // time-to-react) instead of being visible the whole approach — the "no
    // occlusion, implausible" reviews. Only pre-filters when the caller asks.
    if (
      request.requireOccluder &&
      (isPedCrossingFamily(site.family) || site.family === "right_turn_hook") &&
      !site.occluder
    ) {
      rejectedByGate += 1;
      rejectedByReason["require_occluder_no_match"] =
        (rejectedByReason["require_occluder_no_match"] ?? 0) + 1;
      continue;
    }

    // Build the planner result: pedestrian sites are planned here (walker
    // placement needs the regions); turn sites already carry their solved plan
    // (no walker — the conflicting principal is an NPC vehicle/bike).
    let plannerResult: Parameters<typeof plannedCollisionToDraftActors>[0];
    // Turn-ped-crosswalk provenance: is this site's destination a driveway-like
    // stub? (undefined for every other family.)
    let drivewayExit: boolean | undefined;
    // Entrance subtype label ("lot" | "apron") for entrance turn-in sites.
    let entranceTurnIn: "lot" | "apron" | undefined;
    if (site.family === "pedestrian_crossing") {
      const plan = planPedestrianCrossingForSite(site.pedSite, {
        topology: map.topology,
        // A CHILD crosses at 1.1 m/s vs the 1.3 adult default, so the hold and
        // the subject's arrival are RE-SOLVED from the profile rather than inherited
        // — reusing adult timing would land the walker at the conflict late and
        // quietly turn a staged collision into a miss.
        walkerProfile: request.walkerProfile,
        // GAIT re-solves the same way stature does, and by more: a running child
        // reaches the lane centre in 55% of the walking time, so the curb hold
        // grows and the subject's post-reveal window shrinks with it. Euro NCAP
        // CPNCO-50 is explicitly a child RUNNING from behind the obstruction.
        walkerGait: request.walkerGait,
        subjectSpeedKph: request.subjectSpeedKph,
        idealTimeS: DEFAULT_IDEAL_TIME_S,
        minTimeS: DEFAULT_MIN_TIME_S,
        crosswalks: map.regions.crosswalks,
        sidewalks: map.regions.sidewalks,
        poiPoints: map.regions.poiPoints,
      });
      if (!plan) continue;
      plannerResult = { collision: plan.collision, walker: plan.walker };
    } else if (
      site.family === "left_turn_ped_crosswalk" ||
      site.family === "right_turn_ped_crosswalk"
    ) {
      // Turn-across-crosswalk: the subject turns onto the ped's leg. Use the CAPPED
      // turn approach speed (subjectSpeedKph) so the arc is trackable — same reason
      // the vehicle turn families cap it.
      const plan = planTurnPedCrosswalkForSite(site.turnSite, {
        topology: map.topology,
        walkerProfile: request.walkerProfile,
        walkerGait: request.walkerGait,
        subjectSpeedKph,
        idealTimeS: DEFAULT_IDEAL_TIME_S,
        // Turn runway (operator 2026-07-28): a ~2.5 s approach suffices — the
        // turn + yield dominate the clip. The kinematic runway cap and the
        // spawn-on-approach floor still bound it from both sides.
        minTimeS: TURN_MIN_TIME_S,
        // Kinematic runway cap: size the run-up so the slowed turn + the
        // pedestrian-yield aftermath finish inside the eval clip (single source
        // of truth for the clip length).
        clipLenS: DRAFT_DURATION_S,
        crosswalks: map.regions.crosswalks,
        sidewalks: map.regions.sidewalks,
        poiPoints: map.regions.poiPoints,
        // P6: enables the curbside park ending when a Parking lane runs along
        // the exit leg (subject pulls in + stops after the maneuver).
        parkingLanes,
      });
      if (!plan) continue;
      plannerResult = { collision: plan.collision, walker: plan.walker };
      drivewayExit = site.turnSite.drivewayExit;
      entranceTurnIn = site.turnSite.entranceKind ?? undefined;
    } else {
      // RankedTurnSite (unprotected_left_turn / right_turn_hook / bicycle_merge):
      // the plan is pre-solved. `"plan" in site` narrows the union member (the
      // discriminant-alias narrowing across the `||` above isn't enough on its own).
      if (!("plan" in site)) continue;
      plannerResult = { collision: site.plan, walker: null };
    }
    const conflictPoint = plannerResult.collision.conflictPoint;
    const arrivalTimeS = plannerResult.collision.arrivalTimeS;

    // P-3.3 fail-closed: a TURN-family draft whose authored subject route (run-up +
    // post-conflict continuation) nets < 45° of heading change is NOT a turn —
    // reject it with a countable reason so the rightped-849-1 class (a "turn"
    // scene whose route is a straight through-tail) can never ship silently.
    if (isSubjectTurnFamily(request.scenarioFamily)) {
      const netHeadingDeg = plannedRouteNetHeadingDeg(plannerResult.collision.subject);
      if (netHeadingDeg !== null && netHeadingDeg < TURN_ROUTE_MIN_NET_HEADING_DEG) {
        rejectedByGate += 1;
        rejectedByReason[TURN_ROUTE_STRAIGHT_REASON] =
          (rejectedByReason[TURN_ROUTE_STRAIGHT_REASON] ?? 0) + 1;
        continue;
      }
    }

    // M-6 (dib 2026-07-27): tunnel / multi-level placement gate. A conflict site
    // whose road z sits > 2 m BELOW another road within 15 m XY is the tunnel-
    // under-surface signature (reviewed ped-midblock-1: the subject drove INTO the
    // tunnel while the authored interaction played on the surface street above).
    // Unrepairable by timing — discard the site with a countable reason.
    if (isTunnelMultilevelSite(conflictPoint, map.segments)) {
      rejectedByGate += 1;
      rejectedByReason[TUNNEL_MULTILEVEL_GATE_REASON] =
        (rejectedByReason[TUNNEL_MULTILEVEL_GATE_REASON] ?? 0) + 1;
      continue;
    }

    const npcBlueprint = resolvedNpcVehicleType
      ? resolvedNpcVehicleType === "bicycle"
        ? CYCLIST_BLUEPRINTS[(request.seed + scenarios.length) % CYCLIST_BLUEPRINTS.length]!
        : NPC_BLUEPRINT[resolvedNpcVehicleType]
      : undefined;
    // Author the subject's junction maneuver as a CARLA-native turn primitive for
    // turn families (the affordance fix for the "drunk driving" turns). The turn
    // direction comes from the planner's solved gate when present, else the
    // family name. Pedestrian crossings and straight families keep the plain
    // timed_path subject (subjectTurn = null).
    // AVOIDED variant (subjectReactive): keep the subject as a worker-stepped timed_path
    // arc-follower (subjectTurn = null) rather than the road-mode CARLA-native turn.
    // The road-mode TM turn can't be cleanly interrupted+resumed for a yield (dib
    // 2026-07-08: it freezes at a partial yaw), whereas the timed_path arc lets
    // the worker's reactive braking stop for the conflict and the kinematic
    // profile RESUME through the extended arc — the "recover after avoiding" the
    // reviewer asked for (same shape as the stop-subject lead-resume). The arc is
    // extended past the conflict by extendActorPathsBeyondConflict below.
    const subjectTurn = request.subjectReactive
      ? null
      : subjectTurnForSite(
          request.scenarioFamily,
          plannerResult.collision.subjectGate?.turnRelation,
        );
    const actors = plannedCollisionToDraftActors(plannerResult, {
      npcBlueprint,
      subjectTurn,
      // Stature of the CONFLICT walker only. Companions stay mixed-age (a kid
      // beside an adult is ordinary street life) — this selects who the scene
      // is actually about.
      walkerProfile: request.walkerProfile,
      // Pedestrian crossings: the conflict ped plus a SEEDED 0-2 companions
      // (1-3 peds total, roughly uniform across a batch). The fixed trio was a
      // contact-probability crutch from before the 0.10 timing fixes; with the
      // walker accel + step-off delay landed, a single ped reliably meets the
      // subject, so group size is now a variety axis (dib, 2026-07-03). Deterministic
      // per seed+index — replays reproduce the same group. Other families: single
      // conflict actor.
      extraPedestrians: isPedCrossingFamily(request.scenarioFamily)
        ? (Math.imul(request.seed + scenarios.length, 2654435761) >>> 16) % 3
        : 0,
      // CONFLICT GROUP (2-3 kids crossing as one). Only meaningful where there
      // is a crossing walker; it supersedes the seeded bystander companions
      // above inside plannedCollisionToDraftActors.
      walkerGroupSize: isPedCrossingFamily(request.scenarioFamily) ||
      isTurnPedCrosswalkFamily(request.scenarioFamily)
        ? request.walkerGroupSize
        : 1,
      // The adult who waits, then runs after the child.
      reactiveCompanion:
        request.reactiveCompanion &&
        (isPedCrossingFamily(request.scenarioFamily) ||
          isTurnPedCrosswalkFamily(request.scenarioFamily)),
      // P-2.1b: companions' stationary spawn/hold snaps onto mapped sidewalks.
      sidewalks: map.regions.sidewalks,
      // Cyclist conflicts (right-hook / merge) CAN carry a realistically-spaced
      // stream of trailing riders, so the conflict point stays occupied over a
      // wider window and the repair loop gets more contact chances (dib).
      //
      // DEFAULT 0 (schema default; the emit harness resolves EMIT_EXTRA_CYCLISTS
      // into the REQUEST so the replay sidecar carries it — generation stays a
      // pure function of request + map). The companion schedule fails the
      // kinematic jerk lint and takes the whole site with it. MEASURED
      // 2026-08-01 on munich/bikemergeavoid, 32 candidate sites:
      //
      //     extraCyclists = 2  ->  0 accepted. 20 of 32 rejected with
      //                            `kinematic_lint_cyclist_2_has_an_unexplained
      //                            _longitudinal_jerk`; the rest on contact timing.
      //     extraCyclists = 0  ->  3 accepted from 3 requested.
      //
      // The stream had never actually run before the two-wheeler image, because it
      // only exists for bicycle NPCs and those had no blueprints — so this cost
      // nothing until bikes were unshelved, and then it cost every bike site.
      // Restore the default to 2 once the companion re-timing lands.
      extraCyclists:
        resolvedNpcVehicleType === "bicycle" ? request.extraCyclists : 0,
      cyclistBlueprints: CYCLIST_BLUEPRINTS,
      seed: request.seed + scenarios.length,
      // Collision-AVOIDED variant: same planned conflict, reactive subject.
      subjectReactive: request.subjectReactive,
    });

    try {
      snapDraftActorsToRuntimeRoads(actors, map.segments);
    } catch {
      continue; // off-runtime-road site
    }

    // Driveway map-edge floor (richmond rightped-279-0): the WHOLE authored
    // driveway scene — subject spawn + route incl. the stub, walker crossing —
    // must sit ≥ DRIVEWAY_MAP_EDGE_FLOOR_M inside the drivable hull, or the
    // clip stares at the world edge from the parcel.
    if (
      drivewayExit === true &&
      drivableBounds &&
      !actorsInsideMapEdgeFloor(actors, drivableBounds)
    ) {
      rejectedByGate += 1;
      rejectedByReason[DRIVEWAY_MAP_EDGE_REASON] =
        (rejectedByReason[DRIVEWAY_MAP_EDGE_REASON] ?? 0) + 1;
      continue;
    }

    // P-3: turn-family subjects are curvature-RETIMED at draft assembly (the M1.2
    // lint fix), so the authored schedule reaches the conflict LATER than the
    // planner's constant-speed ETA — judging the draft against the stale ETA
    // rejected the retimed drafts as "contact N s off the planned time". The
    // honest planned time-of-conflict is the DRAFT's own time at the conflict
    // (the walker/NPC reconciles key the meet off it); it also feeds the 2D
    // repair loop via generation.conflictTimeS.
    const subjectDraftForTiming = plannedSubjectActor(actors);
    const plannedConflictTimeS = isSubjectTurnFamily(request.scenarioFamily)
      ? (draftTimeAtConflict(subjectDraftForTiming, conflictPoint) ?? arrivalTimeS)
      : arrivalTimeS;

    const report = validateCollisionDraft({
      // The kinematic gate validates against a CollisionFamilyId. Two families
      // aren't in that enum, so map them to the closest gate semantics:
      //  - bicycle_merge → unsafe_cut_in (same-direction lateral cut-in, no turn).
      //  - left/right_turn_ped_crosswalk → pedestrian_crossing: the conflict is a
      //    crossing walker, so the gate checks subject↔walker convergence (a walker,
      //    not a vehicle NPC). The turn correctness is the worker's / 2D-loop's
      //    job — requiring the turn maneuver here would reject the mid-turn arc.
      family:
        request.scenarioFamily === "bicycle_merge"
          ? "unsafe_cut_in"
          : request.scenarioFamily === "left_turn_ped_crosswalk" ||
              request.scenarioFamily === "right_turn_ped_crosswalk"
            ? "pedestrian_crossing"
            : request.scenarioFamily,
      actors,
      intendedLocation: conflictPoint,
      conflict: { conflictPoint, arrivalTimeS: plannedConflictTimeS, subjectTurnRelation: null },
      durationS: DRAFT_DURATION_S,
      fixedDeltaS: DRAFT_FIXED_DELTA_S,
    });
    if (report.verdict !== "pass") {
      rejectedByGate += 1;
      // Record WHICH kinematic check failed. This gate consumes more sites than
      // any other and recorded nothing, so a zero-yield run reported "39 rejected
      // by gate" with three of them explained — indistinguishable from a broken
      // generator. The strings are the validator's own; this is pure accounting.
      const kinReason = report.reasons?.[0] ?? "unspecified";
      const kinKey = `kinematic_${kinReason
        .replace(/[^a-z0-9]+/gi, "_")
        .toLowerCase()
        .slice(0, 60)}`;
      rejectedByReason[kinKey] = (rejectedByReason[kinKey] ?? 0) + 1;
      continue;
    }

    // AVOIDED variant reaction window (2026-08-02, allfam-avoid intent-failure
    // RCA): the planner back-walks subject and NPC to the SAME arrival time, so the
    // yield rests entirely on the reactive brake winning a dead-heat race. In
    // practice the subject runs 0.4-2.4 s AHEAD of plan (15/17 intended_collision
    // scenes: subject entered the crossing 0.2-1.8 s before the open-loop NPC and
    // was struck mid-clearance, contact 0.1-3.4 s BEFORE the planned conflict).
    // Advance the vehicle conflict actor so it reaches the crossing ahead of
    // the subject: the threat is inside the subject's detection horizon BEFORE its
    // commit point, and the subject's reactive brake produces the intended yield.
    // Applied AFTER the kinematic gate (which certifies the conflict geometry
    // converges at the planned point) — same staging as the path extension
    // below. npc-only, per the repair-loop contract: the subject is never re-timed.
    // Walker conflicts keep their solved timing (ped yields already work; the
    // walker start is solved against the achieved subject ETA).
    if (request.subjectReactive) {
      const npcIdx = actors.findIndex((a) => a.id === "npc");
      if (npcIdx >= 0) {
        const advanced = retimeConflictActor(actors[npcIdx]!, -AVOID_CONFLICT_LEAD_S);
        if (advanced) actors[npcIdx] = advanced;
      }
    }

    // Past the (validated) conflict, keep the actors moving so a near-miss
    // doesn't freeze at the site: the subject drives on until the scenario ends and
    // the pedestrian steps onto the far sidewalk. Purely additive tail waypoints
    // — applied AFTER the gate (validation unaffected) and BEFORE population.
    extendActorPathsBeyondConflict(actors, DRAFT_DURATION_S, map.segments);

    // Stage-2 realism: add background traffic + NPCs around the (validated)
    // collision, kept out of the conflict zone + subject corridor. Seed varies per
    // scenario so a batch isn't N identical backdrops. `density` presets fill the
    // counts; no-op when empty.
    const background = populateBackgroundScene({
      primaryActors: actors,
      conflictPoint,
      segments: map.segments,
      sidewalks: map.regions.sidewalks,
      // Bias background pedestrians toward office/storefront/bus-stop POIs
      // (dib 2026-07-10 realism ask).
      poiPoints: map.regions.poiPoints,
      parkingLanes,
      // Lot bays: the second parked-car source, and on maps with no XODR parking
      // lanes (Saratoga) the ONLY one. Absent → curb lanes only, as before.
      parkingBays: map.regions.parkingBays,
      // Cap ambient VEHICLES on World-Partition maps UNCONDITIONALLY here — a caller
      // that forgot to pre-cap (the bespoke Munich straight path did) otherwise ships
      // ~10 ambient cars/scene that mis-place + fly on Munich_Phase_1A (dib 2026-07-25).
      // Since 2026-07-27 (M-2) this is a LIGHT cap (max 5), not a hard zero: the
      // worker's subject-route guard now destroys any WP-re-stamped ambient vehicle
      // sitting in the subject's corridor before physics starts.
      population: stripWorldPartitionAmbientVehicles(
        resolvePopulation(request.population),
        map.carlaMapName ?? "",
      ),
      // P2 van-occlusion variant: place a physics-frozen van on the subject→ped
      // sightline (the review sketches). Rides on the population step so it
      // composes with the turn-across-crosswalk ped families too, without
      // touching their planner. Omit → no van (existing batches byte-identical).
      // P-1.4 (dib 2026-07-27): World-Partition (Munich) narrow streets get the
      // CAR-class body FIRST — a regular parked car fits sites the van's
      // clearance guards reject, and the operator prefers it there anyway.
      occluder: request.sightlineOccluder
        ? {
            kind: (WORLD_PARTITION_MAPS.has(map.carlaMapName ?? "")
              ? "car"
              : request.sightlineOccluder) satisfies SightlineOccluderKind,
          }
        : null,
      seed: request.seed + scenarios.length,
    });
    // D2: spawn the parked-car occluder for occlusion-matched pedestrian sites,
    // so the conflict ped (and its companions, D3) emerge from behind it instead
    // of being visible from a distance (the ops review's core viability gap).
    // Added AFTER the kinematic gate so it never affects validation; the guard
    // in buildOccluderCar keeps it off the subject's lane.
    // Occluders exist ONLY for PEDESTRIAN conflicts (dib 2026-07-28: "we need
    // the occluders only for pedestrians, not for avoiding a collision with
    // another vehicle"). The right_turn_hook occluder was authored for the
    // shelved CYCLIST variant (a VRU); with today's vehicle conflict it can
    // only interfere — it froze the conflict NPC behind its own occluder in
    // every reviewed scene. Restore via buildCyclistOccluderCar if/when the
    // cyclist right-hook returns with 0.10 bike assets.
    // Every PEDESTRIAN conflict, which now includes the turn-across-crosswalk
    // families: the 2026-07-28 rule was "occluders only for pedestrians, not for
    // avoiding a collision with another vehicle", and a ped crossing the leg the
    // subject turns into is exactly that. Restricting it to the straight family was
    // an artefact of turn-ped sites never carrying a matched occluder, not a
    // decision (dib 2026-07-29). right_turn_hook stays excluded: its conflict
    // actor is a vehicle today, and its occluder froze the NPC behind its own
    // body in every reviewed scene.
    const occluder =
      isPedCrossingFamily(site.family) && site.occluder
        ? buildOccluderCar(
            actors,
            site.occluder.subtype,
            scenarios.length,
            request.occluderClass,
            site.conflictPoint,
          )
        : null;
    // Under requireOccluder, a site that passed the gate but whose occluder fails
    // to VERIFY (LOS too weak to block the sightline, or no placement geometry) is
    // dropped — emitting it un-occluded would be exactly the "no occlusion,
    // implausible" case the gate exists to prevent.
    if (request.requireOccluder && site.occluder && !occluder) {
      rejectedByGate += 1;
      continue;
    }
    // A2 (dib 2026-07-26 review): occluder ↔ walker-path clearance. The occluder
    // bodies deliberately hug the conflict ped's spawn, which is exactly where the
    // companion walkers' curb-line offsets land — companions spawned/walking through
    // an occluder body get stuck ("running in place"), and a stuck ped sits in the
    // subject's route corridor forever → the "subject never resumes" stall.
    //  - CONFLICT ped blocked → drop that occluder (under requireOccluder the site
    //    is rejected below, same contract as a failed occluder build).
    //  - companion / background walker blocked → drop THAT walker, keep the scene.
    const conflictPed = actors.find((a) => a.id === "ped" && a.kind === "walker");
    const conflictPedPath = conflictPed ? walkPathOf(conflictPed) : [];
    const pedClears = (obb: ObbFootprint) =>
      conflictPedPath.length === 0 ||
      pathClearsObb(conflictPedPath, obb, PED_OCCLUDER_CLEARANCE_M);
    // P-1 relocation context: the subject's approach polyline + the ped's reveal
    // point, shared by every occluder relocation below.
    const subjectActor = plannedSubjectActor(actors);
    const subjectPathForOccluders = subjectActor ? subjectApproachCorridor(subjectActor, conflictPoint) : [];
    const pedRevealPoint = conflictPedPath[0] ?? null;
    const preferCarFirst = WORLD_PARTITION_MAPS.has(map.carlaMapName ?? "");
    const relocateBlocked = (body: ScenarioEditorActorDraft): ScenarioEditorActorDraft | null =>
      pedRevealPoint
        ? relocateOccluderClearOfWalkPath({
            occluder: body,
            conflictPedPath,
            subjectPath: subjectPathForOccluders,
            pedSpawn: pedRevealPoint,
            preferCarFirst,
            blueprintIndex: request.seed + scenarios.length,
          })
        : null;
    // P-1.1/1.2: an occluder that would block the CONFLICT ped's own crossing is
    // RELOCATED along its curb line (car-class substitution as the fallback)
    // instead of silently dropped — dropping was RC-1 (9/12 reviewed
    // "van-occlusion" scenes shipped without their van).
    let keptOccluder = occluder;
    if (keptOccluder) {
      const obb = vehicleObbOf(keptOccluder);
      if (obb && !pedClears(obb)) keptOccluder = relocateBlocked(keptOccluder);
    }
    let keptBackground = background;
    for (const bg of background) {
      if (!isSightlineOccluderId(bg.id)) continue;
      const obb = vehicleObbOf(bg);
      if (obb && !pedClears(obb)) {
        const relocated = relocateBlocked(bg);
        keptBackground = relocated
          ? keptBackground.map((a) => (a.id === bg.id ? relocated : a))
          : keptBackground.filter((a) => a.id !== bg.id);
      }
    }
    // A3 slice (ped-1559-4, 2026-07-26): a STATIC background vehicle (parked
    // dressing) authored onto the conflict ped's crossing corridor blocks the
    // crossing at runtime — the worker's stride guard holds the ped at the car's
    // bumper and the scene's core interaction never happens. The crossing is the
    // scene; the parked car is degradable dressing. Drop the car, keep the scene.
    for (const bg of keptBackground) {
      if (bg.kind !== "vehicle" || !bg.is_static) continue;
      const obb = vehicleObbOf(bg);
      if (obb && !pedClears(obb)) {
        keptBackground = keptBackground.filter((a) => a.id !== bg.id);
      }
    }
    if (request.requireOccluder && site.occluder && !keptOccluder) {
      rejectedByGate += 1; // occluder existed but would trap the conflict ped
      continue;
    }
    // P-1.5: parked occluder bodies face WITH the traffic of their adjacent lane
    // (flip-only, so the relocation/clearance geometry above is unchanged).
    if (keptOccluder) orientOccluderWithTraffic(keptOccluder, map.segments);
    for (const bg of keptBackground) {
      if (isSightlineOccluderId(bg.id)) orientOccluderWithTraffic(bg, map.segments);
    }
    // Drop companion + background WALKERS whose walk threads a kept occluder body.
    const occluderObbs = [
      ...(keptOccluder ? [keptOccluder] : []),
      ...keptBackground.filter((a) => isSightlineOccluderId(a.id)),
    ]
      .map(vehicleObbOf)
      .filter((o): o is ObbFootprint => o !== null);
    const walkerBlocked = (a: ScenarioEditorActorDraft): boolean => {
      if (a.kind !== "walker" || a.id === "ped") return false;
      const path = walkPathOf(a);
      return occluderObbs.some((obb) => !pathClearsObb(path, obb, PED_OCCLUDER_CLEARANCE_M));
    };
    let keptActors = actors.filter((a) => !walkerBlocked(a));
    keptBackground = keptBackground.filter((a) => !walkerBlocked(a));

    // M-4 (dib 2026-07-27): walker SPAWN hygiene — no ped spawns inside a vehicle
    // body (the "pedestrian standing on a parked car" + sky-drop-at-clip-start
    // review items). Shift laterally where possible; an unshiftable companion/
    // background walker is dropped, an unshiftable CONFLICT ped rejects the site.
    const hygiene = applyWalkerSpawnHygiene({
      actors: keptActors,
      background: keptBackground,
      occluder: keptOccluder,
    });
    if (hygiene.rejectSite) {
      rejectedByGate += 1;
      continue;
    }
    keptActors = hygiene.actors;
    keptBackground = hygiene.background;

    // `finalizeGeneratedActorBehaviors` wraps the KEPT set, not the raw one: the
    // walker-hygiene cull above can drop actors, and a base clip authored onto an
    // actor that is about to be culled is wasted work — while an actor that
    // survives the cull without one has no baseline at all, which is the defect
    // the call exists to prevent.
    const allActors = finalizeGeneratedActorBehaviors([
      ...keptActors,
      ...(keptOccluder ? [keptOccluder] : []),
      ...keptBackground,
    ]);

    // Final assembled-scene plausibility gate (codex review 2026-07-27 #1): the
    // kinematic gate above validated a clean PRE-population draft; every
    // mutation since (path extension, population, D2 occluder insert/relocate,
    // culls, walker hygiene) reshaped the scene un-relinted. Principals = subject +
    // conflict actor (planned-to-draft's fixed "ped"/"npc" ids) + kept occluder
    // bodies; everything else is degradable dressing the gate CULLS on defect —
    // only a principal defect rejects the site (repair-first, reject-last).
    const assembled = validateAssembledScene(allActors, {
      subjectId: subjectActor?.id ?? "subject",
      principalIds: new Set<string>([
        ...(subjectActor ? [subjectActor.id] : []),
        ...keptActors.filter((a) => a.id === "ped" || a.id === "npc").map((a) => a.id),
        ...(keptOccluder ? [keptOccluder.id] : []),
        ...keptBackground.filter((a) => isSightlineOccluderId(a.id)).map((a) => a.id),
      ]),
      // Box occluder bodies with the same footprints their placement clearances
      // used (the class-table fallback envelopes can exceed the real body).
      vehicleFootprints: OCCLUDER_FOOTPRINT_M,
    });
    if (assembled.reject) {
      rejectedByGate += 1;
      const assembledReason = `assembled_${assembled.reject}`;
      rejectedByReason[assembledReason] = (rejectedByReason[assembledReason] ?? 0) + 1;
      continue;
    }
    const assembledCulled = new Set(assembled.culled);
    const finalActors = assembled.actors;

    // Fail-closed invariant: a collision scene must carry its conflict actor. The
    // planner always produces one, but a snap/cull regression could strip it —
    // never ship a "subject + background only" scene mislabeled as a collision. (This
    // does NOT catch a present-but-non-conflicting actor like right-389-0, whose
    // npc misses by 10s; that clean_miss is the contact gate's job to discard.)
    // Identity, not id: both sides come from `keptActors`, and an actor whose id
    // is still unassigned must not silently compare equal to the subject.
    const keptSubject = plannedSubjectActor(keptActors);
    if (!keptActors.some((actor) => actor !== keptSubject && !assembledCulled.has(actor.id))) {
      rejectedByGate += 1;
      continue;
    }

    // P-1.3: what occlusion actually SURVIVED. The kept sightline body (if any)
    // determines the honest class — a van relocation may have substituted a car.
    const keptSightlineBody = keptBackground.find(
      (a) => isSightlineOccluderId(a.id) && a.spawn_point,
    );
    const sightlineOcclusion: "van" | "car" | "none" | null = request.sightlineOccluder
      ? keptSightlineBody
        ? keptSightlineBody.blueprint === VAN_OCCLUDER_BLUEPRINT
          ? "van"
          : "car"
        : "none"
      : null;

    const population = resolvePopulation(request.population);
    const stamped = stampCollisionGeneratedOutput({
      generator: "simforge.batch_collision.v1",
      seed: request.seed + scenarios.length,
      family: request.scenarioFamily,
      actors: finalActors,
      // Companions the assembled gate culled must not be listed as principals.
      principalActorIds: new Set(
        keptActors
          .filter((actor) => actor !== keptSubject && !assembledCulled.has(actor.id))
          .map((actor) => actor.id),
      ),
      plannedOutcome: request.outcome,
      subjectReactive: request.subjectReactive,
      npcVehicleType: resolvedNpcVehicleType ?? null,
      traffic:
        request.population.density === "light"
          ? "normal"
          : request.population.density ??
            (population.vehicles + population.pedestrians + population.cyclists > 0
              ? "medium"
              : "normal"),
      parked:
        request.population.parkedDensity === "medium"
          ? "moderate"
          : request.population.parkedDensity ??
            (population.parked > 0 ? "light" : "none"),
      weather: request.environment?.weather,
      environmentPreset: request.environment
        ? {
            lighting: request.environment.timeOfDay,
            weather: request.environment.weather,
            roadSurface: request.environment.roadCondition,
          }
        : undefined,
      // Honest occlusion metadata (P-1.3): the D2 site occluder's subtype when
      // that body survived, else the surviving sightline body reads as a parked
      // car/van occlusion, else null — modifiers.occlusion = none when the
      // requested occluder could not be placed.
      occlusionSubtype: keptOccluder
        ? (site.occluder?.subtype ?? null)
        : sightlineOcclusion === "van" || sightlineOcclusion === "car"
          ? "SIGHTLINE_PARKED_VEHICLE"
          : null,
      signalized: request.locationConstraints.signalized,
      contextHint:
        site.family === "pedestrian_crossing" &&
        isMidblockGateId(site.pedSite.gate.id)
          ? "mid_block"
          : undefined,
    });
    scenarios.push({
      scenarioId: `${request.scenarioFamily}-${site.siteId.replace(/[^A-Za-z0-9_-]/g, "_")}-${scenarios.length}`,
      actors: stamped.actors,
      scenarioIntention: stamped.scenarioIntention,
      scenarioMetadata: stamped.scenarioMetadata,
      generation: {
        mapAssetId: map.mapAssetId,
        family: request.scenarioFamily,
        siteId: site.siteId,
        fitScore: site.fit.fitScore,
        plannedOutcome: request.outcome,
        conflictTimeS: plannedConflictTimeS,
        seed: request.seed,
        ...(drivewayExit !== undefined ? { drivewayExit } : {}),
        ...(entranceTurnIn !== undefined ? { entranceTurnIn } : {}),
        ...(sightlineOcclusion !== null ? { occlusion: sightlineOcclusion } : {}),
      },
    });
  }

  return { scenarios, sitesConsidered: sites.length, rejectedByGate, rejectedByReason };
}

/** Pure geometry used by the occluder placement guards — exported for tests. */
export const __collisionGeneratorTestHooks = {
  actorPath,
  buildCyclistOccluderCar,
  buildOccluderCar,
  distanceToPolyline,
  subjectApproachCorridor,
  occluderBlueprintForKind,
  occluderKindForSubtype,
  OCCLUDER_BLUEPRINTS,
  OCCLUDER_FOOTPRINT_M,
  OCCLUDER_MIN_EDGE_CLEARANCE_M,
  OCCLUDER_MIN_SUBJECT_CLEARANCE_M,
  OCCLUDER_NPC_PATH_CLEARANCE_M,
};
