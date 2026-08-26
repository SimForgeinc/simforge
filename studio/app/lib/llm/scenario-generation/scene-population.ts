/**
 * Deterministic scene population — add background traffic + NPC pedestrians /
 * cyclists around a primary collision so the clip looks like real traffic,
 * WITHOUT disrupting the labeled subject↔conflict event. This is the stage-2
 * realism layer for VLM/VLA training data.
 *
 * Everything is explicit, seeded, reproducible actor placement (the CARLA
 * worker has no ambient traffic-manager path — it only spawns the actors array):
 *   - VEHICLES + CYCLISTS: autopilot, road-anchored on drivable runtime lanes
 *     (Traffic-Manager driven), kept out of the collision zone + the subject's
 *     driving corridor so they can't pre-empt the intended contact.
 *   - PEDESTRIANS: scripted short walks along projected sidewalks (the worker
 *     has no wandering-walker mode), kept clear of the conflict.
 *
 * Default counts are 0 — a request with no population is byte-identical to the
 * primary-only scenario.
 */
import { plannedSubjectActor, walkerBlueprintAt } from "@simforge-oss/studio-shared";
import type { ScenarioEditorActorDraft, Vec2 } from "@simforge-oss/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/llm/scenario-generation/runtime-road-snap";
import { withWorldAnchor, worldAnchorAtFraction } from "@/app/lib/scenario-editor/batch-scenario-generator/routing";
import type { ParkingLaneRef } from "@/app/lib/maps/topology/parking-lanes";
import { finalizeGeneratedActorBehaviors } from "@/app/lib/scenario-generation/generated-actor-behavior";

export interface ScenePopulation {
  /** Background autopilot vehicles on drivable lanes. */
  vehicles: number;
  /** Background scripted pedestrians on sidewalks. */
  pedestrians: number;
  /** Background autopilot cyclists on drivable lanes. */
  cyclists: number;
  /** Static parked cars — annotated Parking lanes (curb) first, then RoadRunner
   *  ParkingSpace bays (lots). */
  parked: number;
}

export const EMPTY_POPULATION: ScenePopulation = {
  vehicles: 0,
  pedestrians: 0,
  cyclists: 0,
  parked: 0,
};

/** Density shorthand: a named preset for both traffic and parking. */
export type TrafficDensity = "light" | "medium" | "heavy";

/** Traffic (moving actors) per density tier. */
export const DENSITY_PRESETS: Record<
  TrafficDensity,
  { vehicles: number; pedestrians: number; cyclists: number }
> = {
  light: { vehicles: 4, pedestrians: 2, cyclists: 1 },
  medium: { vehicles: 10, pedestrians: 5, cyclists: 2 },
  heavy: { vehicles: 20, pedestrians: 12, cyclists: 4 },
};

/** Parked cars per density tier — a SEPARATE knob from traffic density (cheap
 * static dressing, so the tiers run higher than moving traffic). */
export const PARKED_DENSITY_PRESETS: Record<TrafficDensity, number> = {
  light: 6,
  medium: 14,
  heavy: 28,
};

/**
 * Resolve a population request into concrete counts. Traffic and parking are
 * INDEPENDENT knobs: traffic = explicit vehicle/ped/cyclist counts if any > 0,
 * else the `density` preset, else 0; parking = explicit `parked` if > 0, else
 * the `parkedDensity` preset, else 0. The placement step still caps to what fits
 * near the conflict, so a "heavy" request is a target, not a guarantee.
 */
export function resolvePopulation(input: {
  density?: TrafficDensity | null;
  parkedDensity?: TrafficDensity | null;
  vehicles?: number;
  pedestrians?: number;
  cyclists?: number;
  parked?: number;
} | null | undefined): ScenePopulation {
  const vehicles = input?.vehicles ?? 0;
  const pedestrians = input?.pedestrians ?? 0;
  const cyclists = input?.cyclists ?? 0;
  const traffic =
    vehicles + pedestrians + cyclists > 0
      ? { vehicles, pedestrians, cyclists }
      : input?.density
        ? { ...DENSITY_PRESETS[input.density] }
        : { vehicles: 0, pedestrians: 0, cyclists: 0 };
  const parked =
    (input?.parked ?? 0) > 0
      ? input!.parked!
      : input?.parkedDensity
        ? PARKED_DENSITY_PRESETS[input.parkedDensity]
        : 0;
  return { ...traffic, parked };
}

// World-Partition maps (UE5 streamed): the runtime `world_anchor` re-stamping
// re-projects actors onto renumbered runtime roads WITHOUT preserving the
// generation-time inter-actor spacing, so ambient VEHICLES land in the subject's own
// lane — the subject then side-swipes them and stalls (dib 2026-07-24 Munich review:
// the "flying"/colliding cars; only 10/57 of the prior render passed). Crowd
// pedestrians no longer ragdoll (b6f3c8ce9) and curb parked cars are physics-frozen
// clear of the corridor, so both stay; ambient vehicles were fully dropped until
// 2026-07-27 and are now CAPPED instead (see below).
export const WORLD_PARTITION_MAPS: ReadonlySet<string> = new Set(["Munich_Phase_1A"]);

/** Max moving ambient vehicles on a World-Partition map (M-2, dib 2026-07-27
 *  review: "light moving traffic" back in the Munich ped-avoidance scenes). A
 *  LIGHT cap, not a restore: the worker now carries a second-line guard that
 *  destroys any re-stamped ambient vehicle sitting in the subject's route corridor
 *  before physics starts, so a handful of ambient cars is safe — a medium/heavy
 *  count would still degrade too many placements to be worth it. */
export const WORLD_PARTITION_AMBIENT_VEHICLE_CAP = 5;

/** Cap ambient VEHICLES on World-Partition maps (Munich) to a LIGHT count
 *  (WORLD_PARTITION_AMBIENT_VEHICLE_CAP); pedestrians, cyclists and parked cars
 *  are untouched. Was a hard zero until 2026-07-27 (M-2): the worker-side
 *  subject-route guard now removes any ambient vehicle the WP world_anchor re-stamp
 *  drops into the subject's corridor, so light moving traffic is safe again. A no-op
 *  on every non-WP map (US), so US ped scenes keep their ambient traffic. Pure —
 *  safe to unit-test. Name kept for the existing call sites ("strip" now means
 *  "strip down to the light cap"). */
export function stripWorldPartitionAmbientVehicles<P extends { vehicles: number }>(
  population: P,
  mapName: string,
): P {
  return WORLD_PARTITION_MAPS.has(mapName) &&
    population.vehicles > WORLD_PARTITION_AMBIENT_VEHICLE_CAP
    ? { ...population, vehicles: WORLD_PARTITION_AMBIENT_VEHICLE_CAP }
    : population;
}

/**
 * A deliberately-placed SIGHTLINE occluder (P2, dib 2026-07-24 review): a
 * physics-frozen parked VAN positioned ON the subject→conflict sightline so the
 * crossing pedestrian is hidden BEHIND it and emerges late — the harder, more
 * realistic reveal the review sketches show (subject turns right into a driveway /
 * at a junction, a parked van "OCC" on the exit leg hides the ped). Unlike the
 * generic medium occluder (`occluderClass: "medium"` in the collision generator,
 * a straight-crossing variant), this rides on top of ANY family's already-authored
 * subject+ped geometry — including the turn-across-crosswalk scenes — because it is
 * placed in the population step from (conflictPoint, subject approach, ped spawn).
 * `kind: "van"` is the boxy Sprinter; `kind: "car"` is the CAR-class body (P-1.4,
 * dib 2026-07-27: Munich's narrow streets prefer a regular parked car over a van
 * — the smaller footprint fits sites the van's clearance guards reject).
 */
export type SightlineOccluderKind = "van" | "car";
export type SightlineOccluder = { kind: SightlineOccluderKind };

/**
 * A RoadRunner `ParkingSpace` bay as a parked-car candidate: the bay centre plus
 * the heading INTO the bay (head-in orientation), both in runtime meters — i.e.
 * the `center`/`spotHeadingRad` pair of the parking-spot planner's `ParkingSpot`,
 * narrowed to what placement needs. The SECOND parked-car source alongside
 * `ParkingLaneRef` (see `parkingBays` below for why it exists).
 */
export type ParkingBayRef = { center: Vec2; headingRad: number };

export interface PopulateSceneInput {
  /** The primary actors (subject + conflict) — their spawns + the subject corridor are avoided. */
  primaryActors: ReadonlyArray<ScenarioEditorActorDraft>;
  /** Where the labeled collision happens (runtime meters). */
  conflictPoint: Vec2;
  /** Drivable runtime road segments for vehicle/cyclist placement. */
  segments: ReadonlyArray<RuntimeRoadSegment>;
  /** Projected sidewalk polylines (runtime meters) for pedestrian placement. */
  sidewalks: ReadonlyArray<{ polyline: Vec2[] }>;
  /** POI points (offices, storefronts, bus stops…) — background pedestrians are
   *  BIASED toward sidewalks near these (dib 2026-07-10: "add pedestrians in the
   *  scene near office buildings, in sidewalks etc — increases the realism"). */
  poiPoints?: ReadonlyArray<Vec2>;
  /**
   * Annotated Parking lanes (runtime meters) from the map topology index, for
   * static curb-parked cars. Omit (or empty) → no parked cars even when
   * `population.parked > 0` (the slimmed runtime bundle has no parking geometry,
   * so the caller supplies it via `parkingLanesFromTopology`).
   */
  parkingLanes?: ReadonlyArray<ParkingLaneRef>;
  /**
   * RoadRunner `ParkingSpace` bays (runtime meters) — the SECOND parked-car
   * source, used once the curb lanes are exhausted. XODR `parking` lanes barely
   * exist on our maps, so the lane-only path all but no-opped: the 2026-07-29
   * child-occluder emit asked for 14 parked cars/scene and shipped a MEAN of 0.5
   * across 65 scenes (56 of 65 had zero) — belmont has 1 parking lane (18.9 m,
   * nowhere near the subject sites), the Saratoga school map has 0, only yale has a
   * usable 14. Bay supply in the SAME [SUBJECT_CORRIDOR_M, PARKED_NEAR_PATH_M] band
   * measures 21/scene (belmont), 31/scene (yale), 5/scene (easterbrook). These
   * are predominantly off-street LOT bays, which is what the operator asked for
   * ("parking lots need more parked cars for realism"). Omit (or empty) → the
   * lane-only behaviour, unchanged.
   */
  parkingBays?: ReadonlyArray<ParkingBayRef>;
  population: ScenePopulation;
  /**
   * Deliberately-placed sightline occluder (P2 van-occlusion variant). Omit / null
   * → no occluder, so every existing scene stays byte-identical. Independent of the
   * population counts: a cell may request ONLY the occluder (counts all 0).
   */
  occluder?: SightlineOccluder | null;
  seed: number;
  /** Min clearance of background actors from the conflict + primary spawns (default 12 m). */
  keepOutM?: number;
  /**
   * Max distance of background actors from the conflict (default 70 m) — keeps
   * them clustered around the action so they're actually in frame, instead of
   * scattered map-wide. ~ the subject's run-up, so they're visible on approach.
   */
  maxRadiusM?: number;
}

const DRIVABLE_LANE_TYPES = new Set(["driving", "bidirectional"]);
// Image-native ids (UE5.5/0.10 live probe 2026-07-09): the old 0.9 list ALL
// substituted to lincoln.mkz, so background traffic rendered near-uniform (dib:
// "use all car models for variety and realism"). Weighted toward regular cars,
// with the taxi + police charger as occasional street realism.
const VEHICLE_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.taxi.ford",
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.dodgecop.charger",
];
const CYCLIST_BLUEPRINT = "vehicle.bh.crossbike";
const WALK_SPEED_MPS = 1.3;
const DEFAULT_KEEP_OUT_M = 12;
const DEFAULT_MAX_RADIUS_M = 70;
// Background vehicles stay this far off the subject's path: small enough to admit
// the oncoming / adjacent lanes (~3.5 m away, so traffic is visible head-on in
// the chase cam) but enough to keep cars out of the subject's OWN lane ahead.
const SUBJECT_CORRIDOR_M = 3;
// AUTOPILOT background vehicles heading the SUBJECT'S way need a wider berth: a
// same-direction car 3.5m off-axis is in the adjacent/merging lane and TM
// drives it into the subject's approach, stalling the scene before the conflict
// (subject_stuck — surfaced when world_anchor stamping put ambient actors on their
// CORRECT roads, 2026-07-08 belmont v2). Oncoming traffic keeps the tight
// corridor so head-on ambient stays visible in frame.
// NOTE (2026-07-14): widening these (14->24 / 6->10) to keep autopilot ambient out of the
// subject's way BACKFIRED — measured ped conversion 25% -> 15% and subject-vs-bg-vehicle collisions
// 14 -> 19. Pushing ambient further out laterally just relocates it; the clearance is a band
// around the subject's PATH POINTS, so it cannot stop a car that is simply further along the
// subject's road, and squeezing the valid spawn set evidently produced worse placements. Reverted
// to the values that were tuned against real runs. The density itself is the lever (see
// EMIT_PED_DRAFTS_BG_VEHICLES) — not the band.
const SAME_DIR_CORRIDOR_M = 14;
// Reaction window an ambient vehicle must NOT be able to close against the subject's
// opening path. 2.5 s is the shortest interval in which a discarded scene is
// still recognisably a scenario rather than a spawn accident: the measured bad
// batch had 8 of 17 bg-contacts inside 2 s and a median of 2.05 s, so a 2.5 s
// window covers the accident cluster without reaching into the legitimate
// staged-conflict timings (which land 4 s+ once the subject is up to speed).
// Top of the ambient speed band (see the 22-38 kph draw in placeRoadActors).
const AMBIENT_MAX_SPEED_KPH = 38;
// Top of the cyclist band (the 12-20 kph draw below). The TTC gate must price a
// cyclist at ITS class ceiling, not the vehicle band's: at 38 kph a 17 m gap
// reads reachable (26.4 m in the 2.5 s window) and the cyclist is rejected,
// even though at its real 20 kph ceiling it covers only 13.9 m — over-filtering
// exactly the conflict-adjacent spots where cyclist diversity matters
// (PR-538 review P2-2, reproduced 2026-08-18).
const CYCLIST_MAX_SPEED_KPH = 20;
const AMBIENT_SPAWN_TTC_S = 2.5;
// How much of the subject's route counts as "opening path" for that window. At an
// urban 8-11 m/s the subject covers ~25 m in the first 2.5 s; 30 m adds a margin for
// a faster start without extending the guard down the whole route.
const SUBJECT_HEAD_START_M = 30;
// Spacing the subject route is densified to. Shared so the head-of-corridor point
// count in clearOfSubjectFeed and the densifier cannot drift apart.
const CORRIDOR_STEP_M = 2.5;
// Min subject-path clearance for AUTOPILOT ambient in ANY direction (see
// clearOfSubjectFeed). Parked/static dressing keeps the tight SUBJECT_CORRIDOR_M band.
const AUTOPILOT_CORRIDOR_M = 6;
const VEHICLE_SPACING_M = 9; // min spacing between placed background vehicles
const PED_WALK_M = 11; // length of a background pedestrian's scripted walk
// A background pedestrian WALKS PED_WALK_M along its sidewalk, so checking only its
// spawn point (as the old code did) let it start clear then walk INTO the conflict
// corridor / another actor and collide mid-sim — the Munich review's "flying"/colliding
// ambient crowd (bg-ped ↔ ped / bg-park / occluder / each other). The whole swept walk
// must stay clear, and each ped registers BOTH endpoints so later actors avoid its path.
const PED_PATH_CLEARANCE_M = 2.5; // min distance from a walking ped to any other placed actor
// Parked cars: center-to-center spacing along the curb (~4.7m car + ~1.8m gap),
// min parking-lane length to bother with, and the muted "parked" body color.
// dib 2026-08-02 Munich review (bikeavoidmedocc/right-2101-0): "parked cars to
// the right of the subject are too dense — space them out so they are realistic".
// 6.5 m pitch left a ~1.8 m bumper gap (a packed inner-city curb); 8.0 m gives
// ~3.3 m — an ordinarily-occupied street.
const PARKED_SPACING_M = 8.0;
// Compare parked-vs-parked a hair UNDER the nominal pitch: the curb cursor
// advances by exactly PARKED_SPACING_M, so 1-ulp float noise in the arc
// interpolation would otherwise reject the very slot it just stepped to.
const PARKED_SPACING_EPS_M = 0.05;
// Bay-to-bay minimum for LOT parked cars. The bays are real stalls, so the curb
// pitch is the wrong measure: measured stall pitch is 2.59 m (belmont p50; 2.5–3.2
// on Saratoga), and the polygons carry duplicates — 387 of yale's 639 bays have a
// COINCIDENT twin, which would stack two cars in one stall. 4.8 m ≥ the ~4.7 m car
// body, so it rejects every duplicate and every nose-to-tail overlap while still
// filling every second stall of a row (a half-occupied lot, not a wall of cars).
const PARKED_BAY_SPACING_M = 4.8;
const PARKED_MIN_LANE_LENGTH_M = 6;
// Parked cars hug the SUBJECT'S PATH (the curb it actually drives past) — the chase
// cam follows the subject, so cars off-route aren't rendered. This is the lateral
// band off the subject path a curb car may sit in: beyond SUBJECT_CORRIDOR_M (not in the
// subject's lane) and within PARKED_NEAR_PATH_M (still at the adjacent curb, in view).
const PARKED_NEAR_PATH_M = 18;
const PARKED_COLOR = "90,96,104";
// Image-native curb mix (cars + SUV + an occasional van; no taxi/police parked).
const PARKED_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.lincoln.mkz",
  "vehicle.mini.cooper",
  "vehicle.sprinter.mercedes",
];

// ── Sightline van occluder (P2, dib 2026-07-24 review) ──────────────────────
// The Sprinter panel van: the boxiest / tallest (~2.4 m) spawn-verified UE5 body
// under truck size — the SAME body the collision generator's "medium" occluder
// class uses (batch-collision-generator MEDIUM_OCCLUDER_BLUEPRINTS). A van reads
// as a real curb obstruction and, being ~5.9 m long, actually blocks the subject's
// low sightline to a ped stepping out from behind it (a sedan is too short/low).
export const VAN_OCCLUDER_BLUEPRINT = "vehicle.sprinter.mercedes";
// Sprinter footprint (m) — mirrors the collision generator's OCCLUDER_FOOTPRINT_M
// entry so both occluder paths scale placement off the same body dimensions.
// Exported (with the blueprint) for the A2 occluder↔ped-path clearance pass in
// batch-collision-generator (dib 2026-07-26 review: peds stuck behind the van).
export const VAN_OCCLUDER_FOOTPRINT = { length: 5.9, width: 2.0 } as const;
// CAR-class sightline body (P-1, dib 2026-07-27): the Patrol SUV — the tallest
// image-native car-class body, so it still blocks the subject's low sightline while
// its smaller footprint fits narrow-street sites the van cannot (Munich ask:
// "a regular vehicle is better than no occluder at all").
export const CAR_OCCLUDER_BLUEPRINT = "vehicle.nissan.patrol";
export const CAR_OCCLUDER_FOOTPRINT = { length: 4.7, width: 1.9 } as const;
const OCCLUDER_COLOR = "55,58,64"; // muted "parked" body (matches the medocc occluder)
// Nudge the van off the sidewalk toward the road (into the parking strip) so it
// actually straddles the subject→ped sightline; capped per-site + guarded below.
const VAN_OCCLUDER_ROAD_INSET_M = 2.0;
// Keep the van's road-side EDGE this far off the subject path; the half-width is added
// on top (1.65 + 1.0 = 2.65 m centre clearance) so the body never reads as in-lane
// — the van OCCLUDES, it must never block or get hit by the subject.
const VAN_OCCLUDER_MIN_EDGE_CLEARANCE_M = 1.65;
// LOS verifier: the subject's sightline is taken from ~this far upstream of the
// conflict (where it would first glimpse the ped) to the ped, and the van body
// must straddle it — else it is beside the sightline and blocks nothing.
const VAN_OCCLUDER_LOS_SIGHT_M = 15;
// Slack added to the van half-width when checking it covers the sightline.
const VAN_OCCLUDER_LOS_MARGIN_M = 0.6;

/** Small, fast seeded PRNG (mulberry32) — keeps population reproducible per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist2(a: Vec2, b: Vec2): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** Deterministic shuffle (Fisher–Yates) driven by the seeded RNG. */
function shuffled<T>(items: ReadonlyArray<T>, rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** World point at a 0..1 fraction along a segment centerline. */
function centerlinePoint(centerline: ReadonlyArray<{ x: number; y: number }>, frac: number): Vec2 | null {
  const pts = centerline.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return null;
  const idx = Math.min(pts.length - 1, Math.max(0, Math.round(frac * (pts.length - 1))));
  return { x: pts[idx]!.x, y: pts[idx]!.y };
}

// ── Body-true placement (dib 2026-08-02 Munich review) ───────────────────────
// Point-radius checks placed CENTERS; bodies have length, width and heading.
// Worse, the road-actor checks tested `centerlinePoint` (VERTEX-INDEX rounding)
// while the emitted `world_anchor` pose comes from `worldAnchorAtFraction`
// (s-interpolated) — on unevenly-sampled centerlines the checked point is NOT
// the emitted pose. Measured on munich merge-18-4: bg-veh-22636-0 and -2
// emitted world anchors 2.9 m apart with opposite yaws ("two non-interacting
// vehicles spawned on top of each other") after both PASSED the 9 m point
// check. Every vehicle body now registers an oriented bounding box at its
// EMITTED pose, and candidates are rejected on OBB overlap (separating-axis)
// with a margin — against primaries (subject body included: right-3187-1 "subject
// slightly collides with the parked cars right at spawn"), the occluder, and
// each other.
const VEHICLE_FOOTPRINT_M: Readonly<Record<string, { length: number; width: number }>> = {
  "vehicle.sprinter.mercedes": VAN_OCCLUDER_FOOTPRINT,
  "vehicle.nissan.patrol": CAR_OCCLUDER_FOOTPRINT,
  "vehicle.bh.crossbike": { length: 1.9, width: 0.6 },
};
const DEFAULT_VEHICLE_FOOTPRINT_M = { length: 4.7, width: 1.9 } as const;
/** Clearance margin added around every body pair (mirrors the subject's swept slop). */
const BODY_CLEARANCE_M = 0.6;

type PlacedBody = { cx: number; cy: number; yawDeg: number; length: number; width: number };

function vehicleFootprint(blueprint: string | null | undefined): { length: number; width: number } {
  return VEHICLE_FOOTPRINT_M[blueprint ?? ""] ?? DEFAULT_VEHICLE_FOOTPRINT_M;
}

function bodyCorners(body: PlacedBody, marginM: number): Vec2[] {
  const rad = (body.yawDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hl = body.length / 2 + marginM;
  const hw = body.width / 2 + marginM;
  return [
    { x: body.cx + hl * cos - hw * sin, y: body.cy + hl * sin + hw * cos },
    { x: body.cx + hl * cos + hw * sin, y: body.cy + hl * sin - hw * cos },
    { x: body.cx - hl * cos + hw * sin, y: body.cy - hl * sin - hw * cos },
    { x: body.cx - hl * cos - hw * sin, y: body.cy - hl * sin + hw * cos },
  ];
}

/** Separating-axis overlap for two oriented rectangles, each inflated by half the margin. */
function bodiesOverlap(a: PlacedBody, b: PlacedBody, marginM: number): boolean {
  // Cheap reject: beyond the two circumradii they cannot touch.
  const reach =
    Math.hypot(a.length, a.width) / 2 + Math.hypot(b.length, b.width) / 2 + marginM;
  if (dist2({ x: a.cx, y: a.cy }, { x: b.cx, y: b.cy }) > reach * reach) return false;
  const cornersA = bodyCorners(a, marginM / 2);
  const cornersB = bodyCorners(b, marginM / 2);
  for (const [pa, pb] of [
    [cornersA, cornersB],
    [cornersB, cornersA],
  ] as const) {
    for (let i = 0; i < 4; i++) {
      const p1 = pa[i]!;
      const p2 = pa[(i + 1) % 4]!;
      const ax = p2.y - p1.y;
      const ay = p1.x - p2.x; // outward normal of edge p1->p2
      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of pa) {
        const d = p.x * ax + p.y * ay;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      let minB = Infinity;
      let maxB = -Infinity;
      for (const p of pb) {
        const d = p.x * ax + p.y * ay;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      if (maxA < minB || maxB < minA) return false; // separating axis found
    }
  }
  return true;
}

/** The subject body's half-width plus mirrors — what a dressing body must clear of
 *  the subject's PATH, measured to the dressing BODY OUTLINE, not its centre. The
 *  old centre-radius rule left ~1.1 m for a parallel sedan but nothing for a
 *  yawed or long body (right-3187-1: "subject slightly collides with the parked
 *  cars in its lane right at spawn"). */
const SUBJECT_HALF_BODY_M = 0.93;

/** Corner + edge-midpoint samples of a body's outline. */
function bodyOutline(body: PlacedBody): Vec2[] {
  const corners = bodyCorners(body, 0);
  const outline: Vec2[] = [...corners];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    outline.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return outline;
}

/** True when every outline sample of `body` keeps the subject's half-body (plus
 *  slop) clear of the corridor polyline — body-true, where the old rule only
 *  measured the centre. */
function bodyClearsCorridor(body: PlacedBody, corridor: ReadonlyArray<Vec2>): boolean {
  if (corridor.length < 2) return true;
  const need = SUBJECT_HALF_BODY_M + BODY_CLEARANCE_M / 2;
  for (const sample of bodyOutline(body)) {
    if (distanceToPolyline(sample, corridor) < need) return false;
  }
  return true;
}

/** The primary actors' bodies at spawn — the subject's yaw from its own path, the
 *  others from spawn_yaw / first path segment. Walkers get their small frame. */
function primaryBodies(primaryActors: ReadonlyArray<ScenarioEditorActorDraft>, corridor: Vec2[]): PlacedBody[] {
  const bodies: PlacedBody[] = [];
  for (const actor of primaryActors) {
    if (!actor.spawn_point) continue;
    let yawDeg = typeof actor.spawn_yaw === "number" ? actor.spawn_yaw : Number.NaN;
    if (!Number.isFinite(yawDeg)) {
      const wps = actor.timed_waypoints ?? [];
      const next =
        actor.role === "subject" && corridor.length >= 2
          ? corridor[1]!
          : wps.length >= 2
            ? { x: wps[1]!.x, y: wps[1]!.y }
            : null;
      yawDeg = next
        ? (Math.atan2(next.y - actor.spawn_point.y, next.x - actor.spawn_point.x) * 180) / Math.PI
        : 0;
    }
    const fp =
      actor.kind === "walker" ? { length: 0.6, width: 0.6 } : vehicleFootprint(actor.blueprint);
    bodies.push({
      cx: actor.spawn_point.x,
      cy: actor.spawn_point.y,
      yawDeg,
      length: fp.length,
      width: fp.width,
    });
  }
  return bodies;
}

/**
 * Unit direction of a lane centerline at `frac`, taken from the two vertices
 * ADJACENT to the sampled one.
 *
 * The obvious construction — sample at `frac` and again at `frac + 0.05` and
 * subtract — is silently broken, because `centerlinePoint` snaps to a vertex
 * (`Math.round(frac * (n - 1))`). Both samples land on the SAME vertex unless
 * the centerline carries >= 11 points, so the direction came back null for
 * every sparse runtime segment, and every caller that needed a heading just
 * skipped its check. That is how the same-direction corridor band
 * (SAME_DIR_CORRIDOR_M) came to be inert on short lanes.
 */
function centerlineDirAt(
  centerline: ReadonlyArray<{ x: number; y: number }>,
  frac: number,
): Vec2 | null {
  const pts = centerline.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (pts.length < 2) return null;
  const idx = Math.min(pts.length - 1, Math.max(0, Math.round(frac * (pts.length - 1))));
  const a = idx < pts.length - 1 ? pts[idx]! : pts[idx - 1]!;
  const b = idx < pts.length - 1 ? pts[idx + 1]! : pts[idx]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? { x: dx / l, y: dy / l } : null;
}

/** Cumulative arc-length samples of a polyline + total length. */
function polylineArc(polyline: ReadonlyArray<Vec2>): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < polyline.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(polyline[i]!.x - polyline[i - 1]!.x, polyline[i]!.y - polyline[i - 1]!.y));
  }
  return { cum, total: cum[cum.length - 1] ?? 0 };
}

/** Point at arc-length `d` along a polyline. */
function pointAtArc(polyline: ReadonlyArray<Vec2>, cum: number[], d: number): Vec2 {
  if (d <= 0) return polyline[0]!;
  for (let i = 1; i < polyline.length; i++) {
    if (cum[i]! >= d) {
      const seg = cum[i]! - cum[i - 1]!;
      const t = seg > 1e-6 ? (d - cum[i - 1]!) / seg : 0;
      return {
        x: polyline[i - 1]!.x + t * (polyline[i]!.x - polyline[i - 1]!.x),
        y: polyline[i - 1]!.y + t * (polyline[i]!.y - polyline[i - 1]!.y),
      };
    }
  }
  return polyline[polyline.length - 1]!;
}

/**
 * DENSELY sampled (x,y) points along the subject's path (~every 2.5 m) — background
 * vehicles stay clear of these so none lands in the subject's travel lane between
 * sparse waypoints (a sparse check let a car slip into the lane and trigger the
 * subject's collision sensor, faking a ped contact). Dense sampling excludes the
 * whole subject corridor while still admitting the oncoming lane (~3.5 m off-axis).
 */
function subjectPathPoints(primaryActors: ReadonlyArray<ScenarioEditorActorDraft>): Vec2[] {
  const subject = plannedSubjectActor(primaryActors);
  if (!subject) return [];
  const path: Vec2[] = [];
  if (subject.spawn_point) path.push({ x: subject.spawn_point.x, y: subject.spawn_point.y });
  for (const wp of subject.timed_waypoints ?? []) path.push({ x: wp.x, y: wp.y });
  if (path.length < 2) return path;
  const STEP_M = CORRIDOR_STEP_M;
  const dense: Vec2[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(segLen / STEP_M));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      dense.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return dense;
}

function roadActor(
  id: string,
  label: string,
  blueprint: string,
  seg: RuntimeRoadSegment,
  sFraction: number,
  speedKph: number,
): ScenarioEditorActorDraft {
  return {
    id,
    label,
    kind: "vehicle",
    role: "traffic",
    is_static: false,
    placement_mode: "road",
    blueprint,
    // world_anchor: the UE5/0.10 runtime RENUMBERS road ids vs the bundle, so a
    // bare road_id anchor can resolve to a DIFFERENT physical road — observed
    // as bg-veh/bg-cyc pairs spawning 2-3m apart (spawn_overlap discards) and
    // ambient wrong-way actors despite the 9m generation-time spacing check.
    // Collision actors got this stamp on 2026-07-06; background actors now too.
    spawn: withWorldAnchor(
      {
        road_id: String(seg.road_id),
        section_id: seg.section_id,
        lane_id: seg.lane_id,
        s_fraction: Math.round(sFraction * 1000) / 1000,
      },
      seg,
      sFraction,
    ),
    spawn_point: null,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    path_placement: [],
    speed_kph: speedKph,
    autopilot: true,
    timeline: [],
    sensors: [],
  } as ScenarioEditorActorDraft;
}

function pedestrianActor(id: string, label: string, blueprint: string, start: Vec2, end: Vec2): ScenarioEditorActorDraft {
  const walkS = Math.max(2, Math.hypot(end.x - start.x, end.y - start.y) / WALK_SPEED_MPS);
  return {
    id,
    label,
    kind: "walker",
    role: "pedestrian",
    is_static: false,
    placement_mode: "timed_path",
    blueprint,
    spawn: { road_id: "", s_fraction: 0.5, lane_id: null, section_id: null },
    spawn_point: { x: start.x, y: start.y },
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    path_placement: [],
    timed_waypoints: [
      { x: start.x, y: start.y, time: 0 },
      { x: end.x, y: end.y, time: Math.round(walkS * 10) / 10 },
    ],
    speed_kph: Math.round(WALK_SPEED_MPS * 3.6 * 10) / 10,
    autopilot: false,
    timeline: [],
    sensors: [],
  } as ScenarioEditorActorDraft;
}

/** Point + local tangent heading (degrees) at arc-length `d` along a polyline —
 * the parked car's curb position + parallel-parked orientation. */
function parkingSampleAtArc(polyline: ReadonlyArray<Vec2>, cum: number[], d: number): { x: number; y: number; yawDeg: number } {
  for (let i = 1; i < polyline.length; i++) {
    if (cum[i]! >= d || i === polyline.length - 1) {
      const a = polyline[i - 1]!;
      const b = polyline[i]!;
      const seg = cum[i]! - cum[i - 1]!;
      const t = seg > 1e-6 ? Math.max(0, Math.min(1, (d - cum[i - 1]!) / seg)) : 0;
      return {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
        yawDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
  }
  const a = polyline[0]!;
  return { x: a.x, y: a.y, yawDeg: 0 };
}

/** A static, point-anchored parked car at the curb (physics frozen by the
 * worker; never moves, never enters a lane). */
function parkedCarActor(id: string, label: string, blueprint: string, sample: { x: number; y: number; yawDeg: number }): ScenarioEditorActorDraft {
  return {
    id,
    label,
    kind: "vehicle",
    role: "traffic",
    is_static: true,
    placement_mode: "point",
    blueprint,
    color: PARKED_COLOR,
    spawn: { road_id: "", section_id: null, lane_id: null, s_fraction: 0 },
    spawn_point: { x: Math.round(sample.x * 1000) / 1000, y: Math.round(sample.y * 1000) / 1000 },
    spawn_yaw: Math.round(sample.yawDeg * 100) / 100,
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

/** Perpendicular distance from p to the SEGMENT ab (clamped to the segment, so a
 *  point beyond an endpoint measures to that endpoint, not the infinite line). */
function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** Distance from p to a polyline, measured to its SEGMENTS (not just vertices — a
 *  vertex-only check lets an occluder sit in-lane between two sparse waypoints). */
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
 * Build the physics-frozen VAN occluder for the P2 van-occlusion variant. It sits
 * ON the subject's sightline to the conflict pedestrian so the ped is hidden until it
 * emerges late (the review sketches). Placement mirrors the collision generator's
 * proven `buildOccluderCar` geometry so both occluder paths behave the same:
 *   - anchor at the ped's CURB spawn `s`; find the subject-corridor point closest to
 *     `s` (≈ the conflict) and the subject's APPROACH direction there (a multi-point
 *     chord, robust vs a single noisy segment);
 *   - park the van one half-body-length + 0.5 m UPSTREAM of the ped along that
 *     approach, so the van's downstream end is at the ped and the body extends back
 *     toward the oncoming subject — the ped stays hidden until it clears the van;
 *   - nudge it off the sidewalk toward the road (into the parking strip) so it
 *     straddles the sightline, capped and guarded so its road-side edge never
 *     reaches the subject's lane (it OCCLUDES, it never blocks or gets hit);
 *   - LOS-verify: the van centre must lie within a body half-width (+slack) of the
 *     subject-eye→ped line, else it is beside the sightline and blocks nothing → null.
 * Pure + deterministic (no RNG): same (conflictPoint, corridor, ped spawn, seed) →
 * identical van. Returns null when the geometry is unavailable or the only valid
 * placement would intrude on the subject's path.
 */
export function buildSightlineVanOccluder(input: {
  /** The conflict pedestrian's curb spawn — the body the van hides. */
  pedSpawn: Vec2;
  /** Dense subject approach corridor (`subjectPathPoints`), spawn → conflict. */
  corridor: ReadonlyArray<Vec2>;
  seed: number;
  /** Occluder body class (P-1.4): "van" (default, the Sprinter) or "car" (the
   *  Patrol SUV — preferred on narrow-street World-Partition maps). */
  kind?: SightlineOccluderKind;
}): ScenarioEditorActorDraft | null {
  const { pedSpawn: s, corridor, seed } = input;
  if (corridor.length < 2) return null;
  const kind: SightlineOccluderKind = input.kind ?? "van";
  const footprint = kind === "car" ? CAR_OCCLUDER_FOOTPRINT : VAN_OCCLUDER_FOOTPRINT;
  // Sit one half-length (+0.5 m) upstream so the downstream end is at the ped.
  const upstreamM = footprint.length / 2 + 0.5;
  // A wider body needs its CENTRE further from the path so its road-side EDGE still
  // clears the lane. (1.65 edge + 1.0 half-width = 2.65 m centre clearance.)
  const minSubjectClearanceM = VAN_OCCLUDER_MIN_EDGE_CLEARANCE_M + footprint.width / 2;

  // Subject-corridor point closest to the ped spawn ≈ the conflict.
  let ci = 0;
  let cBest = Infinity;
  for (let i = 0; i < corridor.length; i++) {
    const d2 = dist2(corridor[i]!, s);
    if (d2 < cBest) {
      cBest = d2;
      ci = i;
    }
  }
  // Approach direction from a chord ending at the conflict (≥3 pts back, or the
  // whole prefix) — the subject is moving toward the conflict in this direction.
  const from = corridor[Math.max(0, ci - 3)]!;
  const to = corridor[ci]!;
  const dl = Math.hypot(to.x - from.x, to.y - from.y);
  if (dl < 1e-3) return null; // no resolvable approach heading
  const ex = (to.x - from.x) / dl;
  const ey = (to.y - from.y) / dl;
  // Road-ward direction: from the ped curb toward the subject path (the parking strip
  // the ped crosses to). Needs a real curb→road offset; a ped spawned ON the path
  // gives no side to nudge to → skip (this is a curb-ped occlusion feature).
  const toRoadX = to.x - s.x;
  const toRoadY = to.y - s.y;
  const trl = Math.hypot(toRoadX, toRoadY);
  if (trl < 1e-3) return null;
  const nx = toRoadX / trl;
  const ny = toRoadY / trl;
  const insetMax = Math.min(VAN_OCCLUDER_ROAD_INSET_M, 0.35 * trl);
  // Base at the kerb, upstream along the approach (this offset is ALONG the path so
  // it does not change the perpendicular distance to the subject corridor).
  const baseX = s.x - ex * upstreamM;
  const baseY = s.y - ey * upstreamM;
  const dKerb = distanceToPolyline({ x: baseX, y: baseY }, corridor);
  if (dKerb < minSubjectClearanceM) return null; // in-lane even at the kerb → bad site
  // Nudge toward the road only as far as the edge-clearance allows (interpolate,
  // since distanceToPolyline is ~linear in the nudge on a locally-straight path).
  let inset = insetMax;
  const dFull = distanceToPolyline({ x: baseX + nx * inset, y: baseY + ny * inset }, corridor);
  if (dFull < minSubjectClearanceM && dFull < dKerb) {
    inset *= Math.max(0, (minSubjectClearanceM - dKerb) / (dFull - dKerb));
  }
  const px = baseX + nx * inset;
  const py = baseY + ny * inset;
  // Safety net for the piecewise-linear interpolation on curved approaches.
  if (distanceToPolyline({ x: px, y: py }, corridor) < minSubjectClearanceM - 1e-3) return null;
  // LOS: the van must sit ON the subject's sightline to the ped, not beside it. Take the
  // sightline from the subject eye ~LOS_SIGHT_M upstream (on its path) to the ped, and
  // require the van centre within a body half-width (+slack) of that line.
  const lx = to.x - ex * VAN_OCCLUDER_LOS_SIGHT_M;
  const ly = to.y - ey * VAN_OCCLUDER_LOS_SIGHT_M;
  const vx = s.x - lx; // sightline: subject eye (on the road) → ped (on the curb)
  const vy = s.y - ly;
  const vlen = Math.hypot(vx, vy) || 1;
  const perpDist = Math.abs((px - lx) * vy - (py - ly) * vx) / vlen;
  if (perpDist > footprint.width / 2 + VAN_OCCLUDER_LOS_MARGIN_M) return null;
  const yawDeg = (Math.atan2(ey, ex) * 180) / Math.PI;
  return {
    id: kind === "car" ? `occluder-car-${seed}` : `occluder-van-${seed}`,
    label: kind === "car" ? "Parked car (sightline occluder)" : "Parked van (occluder)",
    kind: "vehicle",
    role: "traffic",
    is_static: true,
    placement_mode: "point",
    blueprint: kind === "car" ? CAR_OCCLUDER_BLUEPRINT : VAN_OCCLUDER_BLUEPRINT,
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

/** The conflict pedestrian among the primary actors — the walker the van hides.
 *  The planner ids the principal crossing ped `"ped"` (companions/backgrounds are
 *  distinct ids), so prefer that, then any pedestrian with a spawn point. */
function conflictPedSpawn(primaryActors: ReadonlyArray<ScenarioEditorActorDraft>): Vec2 | null {
  const principal = primaryActors.find((a) => a.id === "ped" && a.role === "pedestrian");
  const ped = principal ?? primaryActors.find((a) => a.role === "pedestrian" && a.spawn_point);
  return ped?.spawn_point ? { x: ped.spawn_point.x, y: ped.spawn_point.y } : null;
}

/**
 * Place background actors around the primary collision. Returns the extra actor
 * drafts to append to the scenario (never mutates the primaries). Counts are
 * best-effort: capped by the available drivable lanes / sidewalks / parking lanes.
 */
export function populateBackgroundScene(input: PopulateSceneInput): ScenarioEditorActorDraft[] {
  const { vehicles, pedestrians, cyclists, parked } = input.population;
  const wantVanOccluder = input.occluder != null;
  // The sightline occluder is INDEPENDENT of the population counts — a cell may
  // request only the van (counts all 0). Bail to the byte-identical empty result
  // only when neither is asked for.
  if (vehicles + pedestrians + cyclists + parked <= 0 && !wantVanOccluder) return [];

  const keepOut = input.keepOutM ?? DEFAULT_KEEP_OUT_M;
  const keepOut2 = keepOut * keepOut;
  const maxRadius2 = (input.maxRadiusM ?? DEFAULT_MAX_RADIUS_M) ** 2;
  const corridor2 = SUBJECT_CORRIDOR_M * SUBJECT_CORRIDOR_M;
  const spacing2 = VEHICLE_SPACING_M * VEHICLE_SPACING_M;
  const rng = mulberry32((input.seed ^ 0x9e3779b9) >>> 0);

  const avoid: Vec2[] = [input.conflictPoint];
  for (const a of input.primaryActors) if (a.spawn_point) avoid.push({ x: a.spawn_point.x, y: a.spawn_point.y });
  const corridor = subjectPathPoints(input.primaryActors);

  const placed: ScenarioEditorActorDraft[] = [];
  const placedPoints: Vec2[] = [];
  // Every VEHICLE body in the scene, at its emitted pose — primaries first, so
  // dressing can never intersect the subject (or the conflict actor) at spawn.
  const bodies: PlacedBody[] = primaryBodies(input.primaryActors, corridor);
  const clearOfBodies = (candidate: PlacedBody): boolean =>
    bodies.every((body) => !bodiesOverlap(body, candidate, BODY_CLEARANCE_M));

  // ── Sightline van occluder (P2) ─────────────────────────────────────────────
  // Placed FIRST so every following background actor (peds keep 2.5 m, parked cars
  // keep 9 m) registers + avoids it. It deliberately sits NEAR the conflict (that's
  // the point — the ped emerges from behind it), so it does NOT obey the general
  // keep-out; its own geometry keeps it clear of the subject's driving corridor.
  if (wantVanOccluder) {
    const pedSpawn = conflictPedSpawn(input.primaryActors);
    if (pedSpawn) {
      const van = buildSightlineVanOccluder({
        pedSpawn,
        corridor,
        seed: input.seed,
        kind: input.occluder?.kind,
      });
      if (van?.spawn_point) {
        placed.push(van);
        placedPoints.push({ x: van.spawn_point.x, y: van.spawn_point.y });
        const fp = vehicleFootprint(van.blueprint);
        bodies.push({
          cx: van.spawn_point.x,
          cy: van.spawn_point.y,
          yawDeg: van.spawn_yaw ?? 0,
          length: fp.length,
          width: fp.width,
        });
      }
    }
  }

  // Near the action (in frame) but clear of the conflict zone + subject corridor.
  const clearOfPrimaries = (p: Vec2): boolean =>
    dist2(p, input.conflictPoint) <= maxRadius2 &&
    avoid.every((q) => dist2(p, q) >= keepOut2) &&
    corridor.every((q) => dist2(p, q) >= corridor2);

  // A pedestrian's WHOLE scripted walk (start→end) must stay in-frame + clear of the
  // conflict zone, the subject corridor, and every already-placed actor — checking only the
  // spawn point let a ped start clear then WALK into the conflict/crowd and collide.
  // Sample endpoints + interior (a straight walk can clip a keep-out corner neither
  // endpoint touches).
  const pedPathClear2 = PED_PATH_CLEARANCE_M * PED_PATH_CLEARANCE_M;
  const clearWalk = (start: Vec2, end: Vec2): boolean => {
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      if (!clearOfPrimaries(p)) return false;
      if (placedPoints.some((q) => dist2(p, q) < pedPathClear2)) return false;
    }
    return true;
  };

  // ── Vehicles + cyclists (road-anchored autopilot) ──────────────────────────
  const drivable = shuffled(
    input.segments.filter(
      (s) => DRIVABLE_LANE_TYPES.has((s.lane_type ?? "").toLowerCase()) && (s.centerline?.length ?? 0) >= 2,
    ),
    rng,
  );
  // Corridor test for AUTOPILOT road actors. Two radii:
  // - ANY direction: AUTOPILOT_CORRIDOR_M. The old 3m admitted the oncoming
  //   lane of the SUBJECT'S OWN road; on narrow maps (belmont ~3m lanes) with the
  //   subject's planner path not perfectly lane-centered, that ambient met the subject
  //   HEAD-ON at t~2 (subject_collision -> subject_stuck; also dib's reviewed "weird
  //   collision at the beginning" lane-change discards).
  // - same-direction: SAME_DIR_CORRIDOR_M — TM drives adjacent same-direction
  //   ambient into the subject's approach and stalls it short of the conflict.
  const anyDir2 = AUTOPILOT_CORRIDOR_M * AUTOPILOT_CORRIDOR_M;
  const sameDir2 = SAME_DIR_CORRIDOR_M * SAME_DIR_CORRIDOR_M;
  // The bands above are DISTANCE-only and evaluated against a STATIC spawn point,
  // but autopilot ambient is moving from tick 0. Measured on the 2026-07-29 CPTA
  // batch: 17/142 US scenes discarded `wrong_collision — subject hit a non-conflict`,
  // 37 of the contacts against `bg-veh-*` and exactly 1 against an occluder, with
  // first contact at 0.25 s and 8 of 17 inside 2 s. Ambient runs 22-38 kph
  // (6.1-10.6 m/s), so a car sitting just outside the 6 m any-direction band and
  // closing head-on reaches the subject in ~0.3 s. Distance alone cannot express that.
  //
  // Do NOT fix this by widening the bands — that was tried on 2026-07-14
  // (14->24 / 6->10) and BACKFIRED: ped conversion 25%->15% and subject-vs-bg
  // collisions 14->19, because a wider band only relocates ambient while
  // shrinking the valid spawn set. This gate is a different axis: it rejects only
  // the actors that can physically REACH the subject's opening path inside a reaction
  // window, and leaves every laterally-offset car (the bulk of ambient, and the
  // ones that make a scene look alive) exactly where it was.
  const spawnTtcReach = (speedKph: number) => (speedKph / 3.6) * AMBIENT_SPAWN_TTC_S;
  const clearOfSubjectFeed = (p: Vec2, laneDir: Vec2 | null, speedKph = 0): boolean => {
    // Only the subject's OPENING stretch matters: a conflict staged 40 m down the
    // route is the scenario working, not a spawn defect. Guard the head of the
    // corridor, not its whole length, or this degenerates into the failed
    // widen-everything fix.
    const headPts = Math.max(2, Math.ceil(SUBJECT_HEAD_START_M / CORRIDOR_STEP_M));
    const reach = spawnTtcReach(speedKph);
    // Nearest HEAD corridor point — the TTC judgment is made once, against the
    // closest approach, not per point. Testing "pointed at ANY head point with
    // straight-line reach" rejected every oncoming PARALLEL lane near the
    // corridor head: at 8 m lateral offset, a corridor point ≥14 m along-track
    // is inside a 60° heading cone even though a lane-following car never
    // enters the corridor. Judge the LATERAL closing instead: the component of
    // travel toward the closest approach is what actually shrinks the gap, so a
    // head-on closer (CPTA: first contact 0.25 s) still scores ≈1×speed and is
    // rejected, while a parallel feeder scores ≈0 and is admitted.
    let headMinD2 = Infinity;
    let headQ: Vec2 | null = null;
    for (let i = 0; i < corridor.length; i++) {
      const q = corridor[i]!;
      const d2 = dist2(p, q);
      if (d2 < anyDir2) return false; // too close in ANY direction
      if (i < headPts && d2 < headMinD2) {
        headMinD2 = d2;
        headQ = q;
      }
      if (d2 >= sameDir2 || !laneDir) continue;
      const n = corridor[Math.min(i + 1, corridor.length - 1)]!;
      const ex = n.x - q.x;
      const ey = n.y - q.y;
      const el = Math.hypot(ex, ey);
      if (el < 1e-6) continue;
      const dot = (laneDir.x * ex + laneDir.y * ey) / el;
      if (dot > 0.5) return false; // same-direction feeder too close
    }
    if (reach > 0 && laneDir && headQ) {
      // Lateral closing at the point of closest approach: how much of this
      // actor's travel actually shrinks its gap to the subject's opening path?
      const gap = Math.sqrt(headMinD2) - SUBJECT_CORRIDOR_M;
      const tx = headQ.x - p.x;
      const ty = headQ.y - p.y;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-6) {
        const closing = (laneDir.x * tx + laneDir.y * ty) / tl;
        if (closing > 0 && gap < reach * closing) return false;
      }
    }
    return true;
  };
  const placeRoadActors = (count: number, makeId: (i: number) => string, label: string, pickBlueprint: (i: number) => string, speed: () => number, maxSpeedKph: number) => {
    let made = 0;
    for (const seg of drivable) {
      if (made >= count) break;
      const frac = 0.2 + rng() * 0.6; // avoid the lane ends
      // Check the pose the actor will actually EMIT (worldAnchorAtFraction —
      // s-interpolated, the same resolver `roadActor` stamps into
      // spawn.world_anchor), not the vertex-index approximation. Testing a
      // different point than the emitted pose is how merge-18-4 shipped two
      // ambient cars 2.9 m apart nose-to-nose past a 9 m spacing check.
      const anchor = worldAnchorAtFraction(seg, frac);
      const p = anchor ?? centerlinePoint(seg.centerline ?? [], frac);
      if (!p || !clearOfPrimaries(p)) continue;
      // Heading for the TTC gate comes from the CENTERLINE's adjacent vertices
      // (centerlineDirAt), not from re-sampling at frac and frac+0.05 — that
      // pair snaps to the SAME vertex on sparse centerlines, so the direction
      // came back null and every heading-dependent check silently skipped (the
      // ambient-spawn-ttc fix). On s-carrying segments this agrees with the
      // anchor's yaw; unlike the anchor it also survives s-less centerlines,
      // where worldAnchorAtFraction degrades to an endpoint.
      //
      // FRAME NOTE (PR-538 review, verified 2026-08-18): vertex order here IS
      // the travel order for EVERY lane, positive OpenDRIVE ids included. All
      // production segments come from semanticRoadSegments, which re-orders
      // each polyline via travelOrderedPolyline (semantic-road-segments.ts
      // topologyTravelPolyline; corridor/variant geometry is travel-ordered at
      // graph build) and re-stamps s/yaw along that order. Do NOT apply a
      // laneTravelIncreasesS flip to this tangent — the flip already happened
      // upstream, and applying it again would reverse the closing sign on
      // positive-id lanes (the exact bug it would claim to fix). Guarded by
      // the "positive-lane-id" TTC test in scene-population.test.ts.
      const laneDir = centerlineDirAt(seg.centerline ?? [], frac);
      // Price the gate off the TOP of this actor CLASS's speed band (38 kph
      // vehicles, 20 kph cyclists), not this actor's own draw. Calling speed()
      // here would consume an rng value for every REJECTED candidate too,
      // shifting the sequence for everything after it — which changes
      // placements and invalidates every replay sidecar keyed on
      // (seedDatasetId, map, strategy, seed). Using the band maximum is also
      // the conservative reading: it assumes the worst closing rate the actor
      // could have been given.
      if (!clearOfSubjectFeed(p, laneDir, maxSpeedKph)) continue;
      if (placedPoints.some((q) => dist2(p, q) < spacing2)) continue;
      const blueprint = pickBlueprint(made);
      const fp = vehicleFootprint(blueprint);
      const body: PlacedBody = {
        cx: p.x,
        cy: p.y,
        yawDeg: anchor?.yaw ?? (laneDir ? (Math.atan2(laneDir.y, laneDir.x) * 180) / Math.PI : 0),
        length: fp.length,
        width: fp.width,
      };
      if (!clearOfBodies(body) || !bodyClearsCorridor(body, corridor)) continue;
      placed.push(roadActor(makeId(made), `${label} ${made + 1}`, blueprint, seg, frac, speed()));
      placedPoints.push(p);
      bodies.push(body);
      made += 1;
    }
  };
  placeRoadActors(
    vehicles,
    (i) => `bg-veh-${input.seed}-${i}`,
    "Background Traffic",
    (i) => VEHICLE_BLUEPRINTS[i % VEHICLE_BLUEPRINTS.length]!,
    () => 22 + Math.round(rng() * 16), // 22–38 kph
    AMBIENT_MAX_SPEED_KPH,
  );
  placeRoadActors(
    cyclists,
    (i) => `bg-cyc-${input.seed}-${i}`,
    "Background Cyclist",
    () => CYCLIST_BLUEPRINT,
    () => 12 + Math.round(rng() * 8), // 12–20 kph
    CYCLIST_MAX_SPEED_KPH,
  );

  // ── Pedestrians (scripted sidewalk walks) ──────────────────────────────────
  // POI-biased: sidewalks nearest an office/storefront/bus-stop POI come first
  // (realism — that's where people actually are), then the shuffled remainder.
  const pois = input.poiPoints ?? [];
  const poiDist2 = (sw: { polyline: Vec2[] }): number => {
    if (pois.length === 0) return Infinity;
    const mid = sw.polyline[Math.floor(sw.polyline.length / 2)]!;
    let best = Infinity;
    for (const p of pois) best = Math.min(best, dist2(mid, p));
    return best;
  };
  const swPool = input.sidewalks.filter((s) => s.polyline.length >= 2);
  const NEAR_POI_2 = 60 * 60;
  const nearPoi = shuffled(swPool.filter((s) => poiDist2(s) <= NEAR_POI_2), rng);
  const farPoi = shuffled(swPool.filter((s) => poiDist2(s) > NEAR_POI_2), rng);
  const usableSidewalks = [...nearPoi, ...farPoi];
  let pedMade = 0;
  for (const sw of usableSidewalks) {
    if (pedMade >= pedestrians) break;
    const { cum, total } = polylineArc(sw.polyline);
    if (total < 2) continue;
    const startD = rng() * Math.max(0, total - PED_WALK_M);
    const start = pointAtArc(sw.polyline, cum, startD);
    const end = pointAtArc(sw.polyline, cum, Math.min(total, startD + PED_WALK_M));
    if (!clearWalk(start, end)) continue;
    // Full walker variety, seed-offset so different scenes use different
    // subsets. The count (37) was right but the RANGE was not: the 0.10
    // catalogue is 0015..0051, not 0001..0037, so this arithmetic named 14
    // nonexistent blueprints out of every 37 draws. The worker substituted a
    // real walker for each (walkers are exempt from the fail-closed approval
    // check that guards vehicle swaps), so the people still appeared — but the
    // 37 intended models collapsed onto 23 distinct ones. Index the probed
    // catalogue (packages/shared/src/carla-ue5-walker-blueprints.ts). The pool
    // is every available walker, children included — a mixed pavement is the
    // realistic one, and these are background dressing, never the conflict
    // actor.
    const blueprint = walkerBlueprintAt(input.seed + pedMade);
    placed.push(pedestrianActor(`bg-ped-${input.seed}-${pedMade}`, `Background Pedestrian ${pedMade + 1}`, blueprint, start, end));
    placedPoints.push(start);
    placedPoints.push(end); // register the WHOLE path so later actors avoid the walk, not just the curb
    pedMade += 1;
  }

  // ── Parked cars (static: curb Parking lanes first, then lot bays) ──────────
  // Placed by explicit world POINT (the slimmed runtime map has no parking-lane
  // geometry to anchor against). Kept clear of the conflict + subject corridor like
  // every other background actor, so they're street dressing, never a blocker.
  const parkingLanes = input.parkingLanes ?? [];
  const parkingBays = input.parkingBays ?? [];
  // Bays are a SECOND source, so a map with NO parking lanes (the Saratoga school
  // map has zero) must not short-circuit here — that guard is why easterbrook shipped
  // 0.00 parked cars/scene no matter how high the count was set.
  if (parked > 0 && (parkingLanes.length > 0 || parkingBays.length > 0) && corridor.length > 0) {
    const nearPath2 = PARKED_NEAR_PATH_M * PARKED_NEAR_PATH_M;
    // Squared lateral distance from a point to the subject path (nearest corridor pt).
    const distToPath2 = (p: Vec2): number => {
      let best = Infinity;
      for (const q of corridor) best = Math.min(best, dist2(p, q));
      return best;
    };
    // A curb car sits in the band alongside the subject path: clear of the subject's own
    // lane (>= corridor) and the conflict, but close enough to be in the chase
    // cam's view (<= near-path). Conflict keep-out still applies.
    const clearForParking = (p: Vec2): boolean => {
      const d = distToPath2(p);
      return (
        d >= corridor2 &&
        d <= nearPath2 &&
        avoid.every((q) => dist2(p, q) >= keepOut2)
      );
    };
    // Parked-vs-parked needs its OWN spacing. This check used to measure every
    // candidate against the MOVING-vehicle VEHICLE_SPACING_M (9 m) while the curb
    // cursor advances by PARKED_SPACING_M (6.5 m), so the very next curb slot was
    // ALWAYS 6.5 < 9 and always rejected — the effective curb pitch was 13 m, not
    // 6.5 (modelled yale yield 1.02 -> 1.79 parked cars/scene once split). Moving
    // ambient + the sightline occluder keep the 9 m berth; only parked-vs-parked
    // drops to the parking pitch. Parked cars are placed LAST, so everything
    // already in `placedPoints` here is a moving/occluder actor — the split is
    // just an index into it.
    const movingCount = placedPoints.length;
    const clearOfPlaced = (p: Vec2, parkedMin2: number): boolean => {
      for (let i = 0; i < placedPoints.length; i++) {
        if (dist2(p, placedPoints[i]!) < (i < movingCount ? spacing2 : parkedMin2)) return false;
      }
      return true;
    };
    const parkedSpacing2 = (PARKED_SPACING_M - PARKED_SPACING_EPS_M) ** 2;
    const baySpacing2 = PARKED_BAY_SPACING_M * PARKED_BAY_SPACING_M;

    const nearParking = parkingLanes
      .filter((lane) => lane.points.length >= 2 && lane.length_m >= PARKED_MIN_LANE_LENGTH_M)
      .map((lane) => ({
        lane,
        distance: Math.min(...lane.points.map((p) => distToPath2(p))),
      }))
      .filter((entry) => entry.distance <= nearPath2)
      .sort((a, b) => a.distance - b.distance);

    let parkedMade = 0;
    for (const { lane } of nearParking) {
      if (parkedMade >= parked) break;
      const { cum, total } = polylineArc(lane.points);
      if (total < PARKED_MIN_LANE_LENGTH_M) continue;
      let cursor = 0.5 + rng() * PARKED_SPACING_M; // jittered start offset
      while (cursor < total - 1 && parkedMade < parked) {
        const sample = parkingSampleAtArc(lane.points, cum, cursor);
        const p = { x: sample.x, y: sample.y };
        const blueprint = PARKED_BLUEPRINTS[parkedMade % PARKED_BLUEPRINTS.length]!;
        const fp = vehicleFootprint(blueprint);
        const body: PlacedBody = {
          cx: p.x,
          cy: p.y,
          yawDeg: sample.yawDeg,
          length: fp.length,
          width: fp.width,
        };
        if (
          clearForParking(p) &&
          clearOfPlaced(p, parkedSpacing2) &&
          clearOfBodies(body) &&
          bodyClearsCorridor(body, corridor)
        ) {
          placed.push(
            parkedCarActor(`bg-park-${input.seed}-${parkedMade}`, `Parked Car ${parkedMade + 1}`, blueprint, sample),
          );
          placedPoints.push(p);
          bodies.push(body);
          parkedMade += 1;
        }
        cursor += PARKED_SPACING_M;
      }
    }

    // Lot bays fill whatever the curb lanes could NOT (usually everything — see
    // `parkingBays`). Nearest-to-the-subject-path first so the cars land in the chase
    // cam's frame, and each bay carries its own head-in heading, so no geometry
    // math: the bay IS the slot. Same clearance guards as the curb cars.
    if (parkedMade < parked) {
      const nearBays = parkingBays
        .map((bay) => ({ bay, distance: distToPath2(bay.center) }))
        .filter((entry) => entry.distance <= nearPath2)
        .sort((a, b) => a.distance - b.distance);
      for (const { bay } of nearBays) {
        if (parkedMade >= parked) break;
        const p = { x: bay.center.x, y: bay.center.y };
        if (!clearForParking(p) || !clearOfPlaced(p, baySpacing2)) continue;
        const blueprint = PARKED_BLUEPRINTS[parkedMade % PARKED_BLUEPRINTS.length]!;
        const yawDeg = (bay.headingRad * 180) / Math.PI;
        const fp = vehicleFootprint(blueprint);
        const body: PlacedBody = { cx: p.x, cy: p.y, yawDeg, length: fp.length, width: fp.width };
        if (!clearOfBodies(body) || !bodyClearsCorridor(body, corridor)) continue;
        placed.push(
          parkedCarActor(`bg-park-${input.seed}-${parkedMade}`, `Parked Car ${parkedMade + 1}`, blueprint, {
            x: p.x,
            y: p.y,
            yawDeg,
          }),
        );
        placedPoints.push(p);
        bodies.push(body);
        parkedMade += 1;
      }
    }
  }

  return finalizeGeneratedActorBehaviors(placed);
}
