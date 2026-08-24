import type { BatchParkedDensity, BatchTrafficProfile } from "./types";

// Accepted semantic publications are cached by revision. Keep a generous
// timeout for a first cold S3 artifact read without coupling generation to a
// central runtime bundle.
export const SEMANTIC_NETWORK_READ_TIMEOUT_MS = 45_000;

// Alpamayo PAI label window: keyframe at 5.1s + 64 future steps @ 0.1s.
export const LABEL_WINDOW_END_S = 11.5;
// The labeled maneuver must happen INSIDE the window and the subject must stay
// alive (on drivable mesh) past its end with margin.
export const RUNWAY_HORIZON_S = LABEL_WINDOW_END_S + 1.5;
// The subject must stay on the drivable mesh for the WHOLE clip, not just past the
// label window — otherwise it reaches a dead end / map-tile boundary mid-clip
// and CARLA destroys it ("subject vanished"). ~18s of guaranteed forward runway
// covers a 20s clip once the start acceleration ramp is credited. Small map
// patches (e.g. Yale) can't sustain this while moving, so moving placements
// there are correctly rejected (use stop scenarios instead).
// Forward-runway demand (seconds of road the subject must have ahead at cruise). The
// placement gate rejects spots with less, so LOWERING this admits MORE candidate
// locations (at the cost of shorter post-maneuver runway → more end-of-clip stalls,
// now a clean hold via the route-end handbrake + junction routing). Override via
// GEN_SURVIVAL_HORIZON_S to trade variety vs. runway; default 18.
export const SURVIVAL_HORIZON_S = Number(process.env.GEN_SURVIVAL_HORIZON_S) || 18;
// Ambient (autopilot, route:[]) cars free-roam under the CARLA Traffic Manager,
// which DESTROYS a vehicle the instant it reaches a lane with no drivable successor
// — a map-edge dead-end, common on these clipped dev extracts. One such removal is a
// car popping out of existence mid-clip; it sits below the mass-despawn reject
// threshold (needs a whole-population collapse), so it ships in the review. Skip any
// ambient spawn whose WORST-CASE forward runway dead-ends within this horizon.
// survivalRunwayMeters returns the full horizon whenever the forward graph loops
// (interior roads) and a short value only for a genuine dead-end, so the guard
// rejects exactly the boundary-bound spawns that vanish — not interior traffic.
// Override via GEN_AMBIENT_RUNWAY_HORIZON_S; default 12s (a vanish near the clip end
// is far less jarring than an early one; matches the lane-change horizon).
export const AMBIENT_RUNWAY_HORIZON_S = Number(process.env.GEN_AMBIENT_RUNWAY_HORIZON_S) || 12;
// Floor: even a crawling fill car must not vanish in the first few seconds.
export const AMBIENT_MIN_RUNWAY_M = 45;
export const CANDIDATE_RESAMPLE_ATTEMPTS = 24;
// Post-turn re-acceleration credit: the subject exits a turn at ~15-20 km/h and takes
// ~3-4s back to cruise, covering roughly half the at-cruise distance — so demanding
// full cruise-speed runway for the post-turn seconds over-rejects. Mirrors
// STOP_RESUME_ACCEL_CREDIT_S.
export const TURN_RESUME_ACCEL_CREDIT_S = 2.0;
// Lane-change survival horizon: shorter than the global 18s (dib 2026-07-13 —
// the change-then-turn follow-through is legitimate, so the subject doesn't need 18s
// of straight-line runway past the merge; the 2D gate rejects derailed scenes).
// Override via GEN_LANE_CHANGE_HORIZON_S.
export const LANE_CHANGE_HORIZON_S = Number(process.env.GEN_LANE_CHANGE_HORIZON_S) || 12;
// Safety margin BEYOND the S-curve, before the next junction. The merge does not
// need straight road AFTER it settles — finishing the change on a junction
// approach and turning into the cross street is a valid, NVIDIA-dataset-like
// scene (dib 2026-07-13) — but it DOES need the curve itself to fit (below).
export const LANE_CHANGE_MIN_BEGIN_CLEAR_M = 10;

// --- Lane-change S-curve geometry: MIRRORS the worker ------------------------
// services/carla-worker/carla_worker/timed_instructions.py builds the lane change
// as a pure-pursuit S-curve and walks forward in 2m steps requiring a PAIRED
// adjacent driving lane for transition_m * SETTLE_FRACTION. If that walk breaks
// (a junction inside the merge), it SILENTLY falls back to TrafficManager
// set_path — which is a no-op for lane changes. Measured 2026-07-14 over 49
// scenes: pursuit executed 25/28 (89%), tm_fallback 3/16 (19%).
//
// The 2026-07-13 relaxation gated only on "the merge BEGINS on open road"
// (delay + 10m), so placement happily produced merges with a junction 18m in
// while the worker needed 32-91m of paired lane. Those scenes then scored as
// lane_keep/turn_right and were discarded by the 2D gate — pure wasted yield.
// Gate on what the maneuver PHYSICALLY needs; keep these in sync with the worker.
export const LANE_CHANGE_TRANSITION_SECONDS = 2.8;
export const LANE_CHANGE_MIN_TRANSITION_M = 18;
export const LANE_CHANGE_MAX_TRANSITION_M = 70;
export const LANE_CHANGE_SETTLE_FRACTION = 1.3;
/** The `transitionMeters` hint emit.ts sends with the lane_change primitive. The
 * worker treats it as a FLOOR, not a cap (speed * 2.8 wins when longer). */
export const LANE_CHANGE_TRANSITION_HINT_M = 25;

/** Meters of paired adjacent lane the worker needs to build the S-curve at this
 * speed. Mirror of `_lane_change_transition_m` * `_LANE_CHANGE_SETTLE_FRACTION`. */
export function laneChangeCurveMeters(speedMps: number): number {
  const scaled = Math.max(speedMps, 0) * LANE_CHANGE_TRANSITION_SECONDS;
  const base = Math.max(LANE_CHANGE_TRANSITION_HINT_M, scaled);
  const transition = Math.max(
    LANE_CHANGE_MIN_TRANSITION_M,
    Math.min(LANE_CHANGE_MAX_TRANSITION_M, base),
  );
  return transition * LANE_CHANGE_SETTLE_FRACTION;
}
/** Highway-family cruise band (km/h): the shared 28-45 variation draw is
 * REMAPPED into this band (like the stop family's remap) so non-highway
 * streams stay byte-identical. The NuRec metadata comb showed most real
 * highway scenes are congested — free-flow ~68-96 covers the diverse end
 * while cells can still override subjectSpeedKphOverride / traffic profile for
 * jam variants. */
export const HIGHWAY_CRUISE_KPH_MIN = 68;
export const HIGHWAY_CRUISE_KPH_MAX = 96;
/** Ramp speed for highway_exit (after the gore) and highway_entry (before the
 * merge): fraction of the drawn highway cruise, clamped to a realistic band. */
export const HIGHWAY_RAMP_SPEED_FRACTION = 0.5;
export const HIGHWAY_RAMP_SPEED_KPH_MIN = 35;
export const HIGHWAY_RAMP_SPEED_KPH_MAX = 55;
/** Post-merge re-acceleration credit for highway_entry runway demand (the subject
 * accelerates from ramp speed to cruise after the merge — same rationale as
 * TURN_RESUME_ACCEL_CREDIT_S). */
export const HIGHWAY_MERGE_ACCEL_CREDIT_S = 2.0;
// Per-map urban cruise-speed band (km/h) for NON-highway, non-stop strategies.
// Munich_Phase_1A is a crowded junction-dense urban core where the realistic street
// speed is ~30 km/h, not the ~36 km/h the shared draw (28-45) centers on. The placement
// runway requirement scales with cruise speed (required ≈ speedMps × SURVIVAL_HORIZON_S),
// so an over-fast subject over-rejects short urban blocks (route_runway_overrun). Remapping
// the urban draw into this lower band for listed maps makes the subject cruise at a realistic
// urban speed AND lets more short-block candidates clear the runway gate. Maps not listed
// keep the default 28-45 draw, so US arterials are unaffected. (dib 2026-07-21: crowded
// Munich streets ≈ 30, not the census ~50.)
export const MAP_URBAN_CRUISE_KPH: Record<string, { min: number; max: number }> = {
  Munich_Phase_1A: { min: 24, max: 34 },
};
// Map-edge placement guard: reject spawns within this many metres of the usable
// extent boundary (a few car lengths), so a placement isn't right on the map edge.
// Combined with the per-map 0.10 footprint (extent.ts) this bounds placement to
// the covered map — the belmont/DiRosa "vehicles vanish into the abyss" fix.
export const MAP_EDGE_MARGIN_M = 15;
// Lane changes only: the subject must finish merging before it reaches a junction,
// or the Traffic Manager halts it at the junction line and the maneuver never
// happens (the subject just sits there for the rest of the clip). Require clear road
// from the spawn to the next junction covering the merge (instruction delay +
// transition) plus this settle buffer, so the change completes on open road.
export const LANE_CHANGE_TRANSITION_M = 25;
export const LANE_CHANGE_POST_MERGE_JUNCTION_BUFFER_M = 15;
// Overtake lane-change (overtake_left / overtake_right): a slower lead sits ahead
// in the SUBJECT's lane, and the subject performs the SAME pursuit S-curve to the adjacent
// lane to pass it — so the change is MOTIVATED (there is a car to get around) rather
// than a bare merge. The lead cruises at a fraction of the subject's speed; the subject
// closes on it during the instruction delay, then swings out and passes.
export const OVERTAKE_LEAD_SPEED_FRACTION = 0.55;
export const OVERTAKE_LEAD_MIN_SPEED_KPH = 12;
// Bumper gap the subject trails the lead by AT the lane-change moment (the initial spawn
// gap is sized so the subject closes to ~this by then); keeps the S-curve from clipping
// the lead's rear corner while still reading as a close, motivated pass.
export const OVERTAKE_TRAIL_GAP_M = 9;
// Initial spawn-gap clamp (subject->lead) so a fast closing rate can't put the lead in
// the subject's bumper at t=0, and a near-zero rate can't push it out of frame.
export const OVERTAKE_MIN_GAP_M = 12;
export const OVERTAKE_MAX_GAP_M = 45;
// Forward runway the slow lead needs to keep cruising (it is a route-follower); one
// short junction segment per metre with a comfortable floor.
export const OVERTAKE_LEAD_ROUTE_RUNWAY_M = 120.0;
export const OVERTAKE_LEAD_BLUEPRINT = "vehicle.nissan.patrol";
// Slow QUEUE ahead of the lead in the subject's own lane (dib 2026-07-09: "traffic in
// the lead car's lane"). The subject passes a LINE of slow traffic, not a single car.
// VARIATION AXIS (dib 2026-07-09, review of overtake-v2 18x rating-5): the queue
// count is a per-scene variation lever — "no traffic in front of the lead" (0) and
// "lane filled in front of the lead" (2-3) are BOTH good scenes, so drawing this
// per seed multiplies yield from the same placement pool. Wire it into the seeded
// variation draw when scaling the overtake set (see the plan doc's overtake
// variants section).
export const OVERTAKE_QUEUE_COUNT = 2;
export const OVERTAKE_QUEUE_SPACING_M = 14.0;
// Fraction of overtakes where the LEAD is a heavy vehicle (bus/truck) — a stronger,
// more realistic reason to pass. A heavy lead gets extra initial gap for its body.
export const OVERTAKE_HEAVY_LEAD_FRACTION = 0.35;
export const OVERTAKE_HEAVY_LEAD_EXTRA_GAP_M = 8.0;
// The worker's stop primitive disables autopilot and applies full brake; the
// timed-instruction compiler models that as a ramp from cruise speed to rest
// (timed-instructions.ts timedCompleteSeconds: brakingWindowSeconds ?? 2), so
// braking distance ~= v * STOP_BRAKING_WINDOW_S / 2 (average speed v/2). 3.0s
// budgets MORE braking distance so the subject stops with a safe gap to the boundary
// (the stop_outcome audit found overran-boundary stops). NOTE: this is the
// DISTANCE model only — the worker still applies full brake, so the actual
// deceleration is worker-side; softening it (a controlled-decel stop primitive)
// is a worker follow-up (the stop_outcome ride-quality gate flags hard stops).
export const STOP_BRAKING_WINDOW_S = 3.0;
// Batch clips run 20s; a post-stop proceed at ~12-13.5s must survive the
// remaining clip time through its chosen junction branch.
export const CLIP_DURATION_S = 20;
// --- Dead-end overrun guard (dib 2026-07-17) --------------------------------
// ~100/175 of the overnight render failures were nominal egos driving off the
// PHYSICAL end of successor-less XODR roads (SR-P1 road 41 ends at s=344.5 —
// mesh ends exactly there) and falling into the void → actor_integrity_rejected
// (actor_below_road_surface). The 2D gate cannot catch it: no_rendering mode
// has no meshes, so nothing falls. The placement-time guard rejects any subject
// whose planned corridor can dead-end within its worst-case travel demand:
//   demand_m = cruise_mps * CLIP_DURATION_S * FACTOR + MARGIN_M
// (full clip at cruise + 10% + a spawn-jitter allowance — deliberately ignores
// the initial acceleration ramp, i.e. conservative). Reject reason:
// "route_runway_overrun". Corridors that end mid-mesh (loops / a junction
// continuation past the route end) pass on a shorter measured length — the
// worst case there is a benign route-end hold on pavement, not a void fall.
export const ROUTE_OVERRUN_DEMAND_FACTOR = 1.1;
export const ROUTE_OVERRUN_DEMAND_MARGIN_M = 10;
// Accelerating from rest to cruise takes ~3s, so the distance covered after a
// resume is roughly v * (remaining - ACCEL_RAMP/2); the runway demand uses
// that instead of the full v * remaining so junction-dense maps keep a pool.
export const STOP_RESUME_ACCEL_CREDIT_S = 1.5;
/** Effective lead-vehicle footprint for queue/rest-gap math: lead half-length
 * + subject half-length (~2.35m each for the sedan blueprints used here), so
 * center-to-center distance = bumper gap + this. */
export const STOP_LEAD_VEHICLE_LENGTH_M = 4.7;
// Cause-first lead placement: put the stopped lead a full COMFORTABLE STOPPING
// DISTANCE (v²/2a) ahead + a center-to-center rest gap, so the route follower's
// kinematic stop controller can ease the subject to a smooth halt behind it instead of
// rear-ending it. Mirrors the worker's ROUTE_OBSTACLE_COMFORT_DECEL/STOP_GAP.
export const STOP_COMFORT_DECEL_MPS2 = 1.5;
// Center-to-center spacing ADDED beyond the comfortable stopping distance when placing
// the lead. Smaller = the lead rests closer (well inside the 45m detect range) so the
// subject approaches and stops at the worker STOP_GAP (11) cleanly instead of braking late
// and crawling. Must stay ≥ worker STOP_GAP so the subject isn't already inside the gap at
// spawn (comfortStopDist ≥ 16m guarantees the total initial gap clears 11).
export const STOP_FOLLOW_REST_GAP_M = 6.0;
// Short-lane RETRY profile for lead_brake. The dominant placement reject on short
// office-park / urban lanes is the lead gap (comfortStopDist + rest) overflowing the lane
// (C:lead_fraction_overflow) or the runway falling short. A firmer comfort decel + a capped
// lower cruise shrink the comfortable-stopping-distance gap (v²/2a) so much shorter lanes
// fit, while the lead stays the CAUSE (lead_vehicle) so the stop still scores valid. The gap
// is floored above the worker STOP_GAP (11) so the subject never spawns already inside the gap.
// Tried only AFTER the standard profile rejects, so existing long-lane placements are
// byte-identical and this only ADDS placements that used to be dropped.
export const STOP_COMFORT_DECEL_MPS2_SHORT = 2.5;
export const STOP_SHORT_LANE_CRUISE_KPH = 20;
export const STOP_SHORT_MIN_INITIAL_GAP_M = 13;
/** queue_at_junction: subject pulls away this many seconds after the lead so the
 * TM follows the lead naturally instead of ramming its rear. */
export const STOP_QUEUE_EGO_RESUME_LAG_S = 1.5;
/** Lead blueprint for caused stops: ~4.69m long, matching
 * STOP_LEAD_VEHICLE_LENGTH_M. */
export const STOP_LEAD_BLUEPRINT = "vehicle.lincoln.mkz";
/** Stop-family cruise band. Real-map probing showed the shared 28-45 kph
 * draw starves the junction-anchored variants: the upstream approach needs
 * v * (delay + 1) + margin meters of single-predecessor chain, and at 45 kph
 * that is ~112m on grids whose blocks run 30-100m. 25-36 kph keeps the brake
 * visibly from cruise (>= 6.9 m/s at the 5.1s keyframe) while fitting far
 * more anchor chains. The shared draw is REMAPPED (not redrawn) so non-stop
 * families' streams stay byte-identical. */
export const STOP_CRUISE_SPEED_KPH_MIN = 25;
// Default stop approach speed band (the per-template subjectSpeedKphOverride usually wins).
export const STOP_CRUISE_SPEED_KPH_MAX = 36;
/** Post-stop proceeds creep through the junction at most this fast (pulling
 * away from a stop line at cruise speed is neither realistic nor needed);
 * the post-resume survival-runway demand scales with this, not with cruise. */
export const STOP_PROCEED_SPEED_KPH_CAP = 25;
/** Adaptive brake delay floor: braking earlier than 4.5s would erode the
 * "subject at cruise at the 5.1s keyframe" gate margin (full brake sheds ~30% of
 * v in the first 0.6s of the ~2s ramp). */
export const STOP_MIN_BRAKE_DELAY_S = 4.5;
/** junction_proceed prefers a right turn (most often legal from a stop line),
 * then straight, then left. queue_at_junction leads prefer straight. */
export const STOP_PROCEED_RELATIONS_EGO = ["Right", "Straight", "Left"] as const;
export const STOP_PROCEED_RELATIONS_LEAD = ["Straight", "Right", "Left"] as const;

// IMAGE-NATIVE ids (UE5.5/0.10, live-probed 2026-07-09 — see
// docs/automated-scenario-creation.md §2b). The old 0.9-era list (audi.a2,
// tesla.model3, toyota.prius, …) ALL substituted to lincoln.mkz at spawn, so the
// rendered fleet was near-uniform (dib: "use all car models for variety and
// realism, especially when training the VLAs"). Every regular car the image has,
// plus the taxi and an occasional police charger for street realism.
/** The subject the batch generator seeds when the persisted draft arrives with no
 * actors (headless: there is no editor to bootstrap a starter subject). Matches what
 * the editor-seeded subject used to be — same blueprint + color — so emitted scenes
 * stay identical to the previously-validated batches. */
export const SUBJECT_BLUEPRINT = "vehicle.audi.a2";
export const SUBJECT_COLOR = "230,200,40";

export const TRAFFIC_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.taxi.ford",
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.dodgecop.charger",
] as const;

/** Large vehicles mixed into the background fill when heavyVehiclesEnabled is
 * set: a city bus, an articulated semi + trailer, and a box delivery truck.
 * All three are in the canonical CARLA vehicle catalog. They're long
 * (~12-16m), so CARLA may reject the tightest spawns — the fill gives them
 * extra headway, keeps them off the subject's own corridor, and the worker
 * tolerates individual spawn failures. */
export const HEAVY_VEHICLE_BLUEPRINTS = [
  "vehicle.fuso.mitsubishi",
  "vehicle.firetruck.actors",
  "vehicle.carlacola.actors",
] as const;
/** Fraction of eligible fill vehicles rendered as a heavy vehicle. */
export const HEAVY_VEHICLE_FILL_FRACTION = 0.16;
/** Extra center-to-center headway (m) advanced after a heavy vehicle so its
 * long body never overlaps the next fill spawn. */
export const HEAVY_VEHICLE_EXTRA_HEADWAY_METERS = 12;
/** Lanes shorter than this (m) never host a heavy vehicle — no room for the
 * body plus headway. */
export const HEAVY_VEHICLE_MIN_LANE_LENGTH_METERS = 32;

/** Bicycles mixed into the background fill when bikesEnabled is set. All three
 * are in the canonical CARLA vehicle catalog (modeled as two-wheeled
 * vehicles). They crawl at bike speed and ride off the subject's jam corridor. */
export const BIKE_BLUEPRINTS = [
  // The current UE5 image has no spawn-verified two-wheeler. Use its compact
  // native vehicle until the image catalog exposes a real bicycle blueprint.
  "vehicle.mini.cooper",
] as const;
/** Fraction of eligible fill slots rendered as a cyclist. */
export const BIKE_FILL_FRACTION = 0.1;
/** Cyclists are capped to this (km/h) regardless of the lane's flow speed. */
export const BIKE_MAX_SPEED_KPH = 18;

export const MAX_BATCH_TRAFFIC_ACTORS = 12;
/** Min same-lane clearance (m) an ambient car must keep from the subject / scripted
 * cause. A car is ~4.5m long, so <6m centre-to-centre = overlapping bumpers (the
 * flying-car spawn overlap was ~1.5m). Different lanes can't collide, so this only
 * applies within a lane. */
export const TRAFFIC_CAUSE_CLEARANCE_M = 6.0;
/** Minimum WORLD-space centre-to-centre separation between any two spawned
 * vehicles. Mirrors the worker's `scene_outcome.SPAWN_OVERLAP_M = 3.0` (below
 * which bounding boxes overlap and the pair ejects in 3D physics) with a small
 * margin, so the generator prevents exactly what the scene gate rejects.
 * Deliberately BELOW a lane width (~3.5 m): legitimate side-by-side traffic in
 * adjacent lanes is not an overlap and must survive. */
export const SPAWN_MIN_SEPARATION_M = 3.4;

export const HEAVY_TRAFFIC_TARGET_DEFAULT = 250;
export const HEAVY_TRAFFIC_TARGET_MIN = 50;
export const HEAVY_TRAFFIC_TARGET_MAX = 400;
/** Per-map ambient-vehicle cap for dead-end-heavy maps. Munich_Phase_1A is riddled
 * with successor-less dead-end roads; mass ambient fill (~40-62 actors) makes CARLA's
 * TrafficManager spam dead-end warnings during setup and CRASH the sim
 * (carla_runtime_crashed_or_unresponsive → 13/27 scenes lost; Munich yield RCA, dib
 * 2026-07-20). Clamp the effective ambient target for these maps regardless of the
 * requested profile; a light-ambient re-render recovered the crashed scenes 1:1. */
export const MAP_AMBIENT_CAP: Record<string, number> = {
  Munich_Phase_1A: 12,
};
/** Lanes whose centerline passes within this distance of the subject spawn are
 * eligible for jam fill (both travel directions). */
export const HEAVY_TRAFFIC_FILL_RADIUS_METERS = 250;
/** Center-to-center headway range for fill vehicles. Must exceed the longest
 * blueprint (~5m sedans) or the pair is INTERPENETRATING at spawn, not merely
 * close: 5m center-to-center = 0m bumper gap, which CARLA rejects (or ejects in
 * 3D physics as a "flying car"). 7m gives a ~2m bumper gap — what a real jam
 * actually looks like — and still packs a queue tightly (dib 2026-07-14). */
/** 12-18 m (was 7-11): at 7-11 m the TM's car-following compresses the queue
 * to a 6-10 kph standstill — authored 25-35% of free-flow never materializes.
 * Wider gaps let the jam genuinely CREEP (~15-20 kph): visible motion, still
 * reads bumper-to-bumper at freeway scale (dib 2026-07-27: "no accidents but
 * no movement either"). */
export const HEAVY_TRAFFIC_MIN_HEADWAY_METERS = 12;
export const HEAVY_TRAFFIC_MAX_HEADWAY_METERS = 18;
/** "medium" (flowing) profile headway — wide enough that CARLA's traffic
 * manager keeps the fill moving instead of gridlocking into static clusters. */
export const MEDIUM_TRAFFIC_HEADWAY_MIN_METERS = 16;
export const MEDIUM_TRAFFIC_HEADWAY_MAX_METERS = 30;
// --- Dense traffic = SLOW traffic (dib 2026-07-14) ---------------------------
// Congestion is a property of the whole flow, not of one lane. The old model
// crawled only the subject's corridor (5-15 km/h) and left every other lane at
// free-ish urban speed (25-40) — so the subject sat in a jam while the next lane
// over did 40, and TM vehicles merging across that 25 km/h shear produced the
// "undesired drama" (measured 2026-07-14: the dense lane-change templates
// averaged ~33 traffic-on-traffic collisions PER SCENE; highway_exit, which has
// no dense fill, had 0). Real congestion instead slows EVERYONE — a 65 mph road
// runs at 20-30 mph when it's packed — which keeps relative speeds low and the
// scene calm while still looking dense.
//
// Speeds are now a FRACTION of the road's free-flow speed (variation.speedKph)
// rather than absolute km/h, so a jammed highway and a jammed arterial both read
// correctly. The subject's own queue is the slowest band; other lanes flow slightly
// faster, but the shear between them stays small.
/** The subject's corridor (its road, same travel direction) — the queue it sits in. */
export const DENSE_JAM_SPEED_FACTOR_MIN = 0.25;
export const DENSE_JAM_SPEED_FACTOR_MAX = 0.35;
/** Everything else (cross streets, opposite direction, other roads). Still
 * congested — just not stop-and-go. */
export const DENSE_FLOW_SPEED_FACTOR_MIN = 0.3;
export const DENSE_FLOW_SPEED_FACTOR_MAX = 0.45;
/** MEDIUM (flowing) profile: the whole flow moves at ~50-65% of free-flow —
 * the congested-but-moving band of the speed-density fundamental diagram
 * (dib 2026-07-27: medium ≈ 50-60%, heavy ≈ 25-33% of operating speed; the
 * old 70-110% "flowing" band ran near-free-flow INTO density, which is the
 * unstable regime real traffic cannot sustain and the TM answers with
 * rear-end pile-ups — the dominant highway scene-killer). */
export const MEDIUM_FLOW_SPEED_FACTOR_MIN = 0.5;
export const MEDIUM_FLOW_SPEED_FACTOR_MAX = 0.65;
/** Lane-taper no-fill zone (trafficval 2026-07-27: every residual ambient
 * collision on P1's freeway was adjacent-lane pairs on road 297 lanes -3/-4/-5
 * — fill cars placed just upstream of a gore/lane-drop drive into the
 * centerline squeeze and side-swipe). Below this adjacent-centerline
 * separation two car bodies (~1.9 m wide) cannot coexist; normal side-by-side
 * lanes run ~3.5 m and stay fillable. */
export const TAPER_MIN_LANE_SEPARATION_M = 3.0;
/** How far upstream of the detected convergence the fill stays out — a car
 * needs room to complete the TM's merge before the squeeze. */
export const TAPER_NO_FILL_APPROACH_M = 45;
/** The SUBJECT moves with its queue under a dense profile. Without this the subject
 * cruises at free-flow into a crawling queue and either rear-ends it or brakes
 * violently — the single largest source of unintended contact in dense scenes.
 * Deterministic (no RNG draw) so the variation stream stays byte-identical. */
export const DENSE_EGO_SPEED_FACTOR = 0.32;
/** MEDIUM profile subject: moves with the 50-65% flow instead of cruising at
 * free-flow past it (dib 2026-07-27). Slightly above the ambient band so the
 * subject still overtakes gently — motion, not racing. */
export const MEDIUM_EGO_SPEED_FACTOR = 0.7;
/** HEAVY profile pace lead: a same-lane vehicle this far ahead of the subject at
 * queue speed, so car-following embeds the subject IN the jam (its maneuver
 * corridor is otherwise kept deliberately clear, which let it race the queue —
 * dib 2026-07-27: "subject racing through a bunch of stopped vehicles"). */
export const JAM_PACE_LEAD_GAP_M = 20;
export const JAM_PACE_LEAD_SPEED_FACTOR = 0.3;
/** Floor for any congested vehicle: below this TM vehicles effectively stall and
 * gridlock the network instead of creeping. */
export const DENSE_MIN_SPEED_KPH = 8;

/** Subject cruise floor under the MEDIUM congestion factor. */
export const MEDIUM_MIN_SPEED_KPH = 15;

/**
 * The subject's FINAL cruise speed for a traffic profile — the single place the
 * congestion factors apply, shared by the generator and the corpus unit tests
 * so a template's declared speed and its generated speed cannot silently
 * diverge (PR-538 review P1-2: "medium" applied MEDIUM_EGO_SPEED_FACTOR AFTER
 * subjectSpeedKphOverride, so the 100 km/h freeway cell generated a 70 km/h subject —
 * and the reduced speed also drove the placement/runway gates).
 *
 * `pinned` (request.subjectSpeedPinned) opts a SPEED-LABELED cell out of subject
 * congestion: the authored override IS the scenario (freeway 100/88/85 cells,
 * where the speed forces placement onto the freeway corridor), while ambient
 * density stays whatever the profile says. Deterministic — no RNG draw.
 */
export function congestedEgoSpeedKph(
  profile: BatchTrafficProfile,
  speedKph: number,
  pinned: boolean,
): number {
  if (pinned) return speedKph;
  if (profile === "heavy") {
    return Math.max(DENSE_MIN_SPEED_KPH, Math.round(speedKph * DENSE_EGO_SPEED_FACTOR));
  }
  if (profile === "medium") {
    return Math.max(MEDIUM_MIN_SPEED_KPH, Math.round(speedKph * MEDIUM_EGO_SPEED_FACTOR));
  }
  return speedKph;
}
/** Lane-change maneuvers: meters of the target lane kept clear immediately
 * BEHIND the subject's s-position (the merge corridor ahead is cleared by the
 * forward-corridor walk) so the lane change stays completable. Sized to cover
 * the subject's pre-merge approach (it changes lanes ~5-7s in, ~70m downstream at
 * arterial speed) plus a trailing safety gap, so the target lane reads as an
 * open slot the whole time the subject is deciding to merge — review feedback was
 * that lane changes "don't happen" when the adjacent lane stays packed. */
export const HEAVY_TRAFFIC_LANE_CHANGE_GAP_METERS = 55;
/** Small buffer kept clear immediately behind the subject on its own lane so a
 * fill vehicle never spawns into the subject's bumper. */
export const HEAVY_TRAFFIC_EGO_TAIL_BUFFER_METERS = 8;

// The resuming cause-lead needs this much forward route past its rest point to
// actually drive away (else it spawns near its segment end with no room and the
// resume is a no-op). Routed THROUGH successor segments to reach it.
export const STOP_LEAD_RESUME_RUNWAY_M = 40.0;

// Forward route length for the cause-first subject: enough drivable road to (a) approach
// the lead from its spawn gap, (b) ease to the kinematic stop gap behind it, and (c)
// follow it away on resume. Longer than the lead's runway because the subject starts
// behind the lead and must cover the approach + the resume runway.
export const SUBJECT_STOP_FORWARD_RUNWAY_M = 75.0;

// Fraction of cause-first lead_brake stops where the lead HOLDS (never resumes) so the
// subject holds to clip end. Resume is the default (dib: most review misses were "stops but
// never resumes"); a minority hold for valid_stop variety.
export const STOP_HOLD_FRACTION = 0.3;

// stop_vru: a pedestrian crossing the subject's lane. The subject (worker route-follower)
// brakes for walkers in its corridor via the existing obstacle-stop, so the ped is the
// instantiated, visible cause and the subject yields then resumes once it clears.
export const STOP_VRU_BLUEPRINT = "walker.pedestrian.0019"; // 0001 is generation-1, absent from the 0.10 image (see carla-ue5-walker-blueprints.ts); 0019 is what the worker substituted to.
export const STOP_VRU_REST_GAP_M = 8.0;          // crossing point this far beyond the comfortable stop
export const STOP_VRU_CROSS_HALF_WIDTH_M = 4.0;  // ped curb-offset each side (8m total crossing)
export const STOP_VRU_CROSS_SECONDS = 6.0;       // curb-to-curb crossing time (~1.3 m/s)
export const STOP_VRU_SPEED_KPH = 5.0;
// The ped pauses mid-crossing (at the lane centerline, in the subject's corridor) — a
// hesitant pedestrian. This guarantees the subject comes to a FULL stop and HOLDS ≥ the
// metric's MIN_STOP_S while the ped is the visible cause, instead of the subject easing
// through as a fast crosser clears (the `never_stopped` near-misses).
export const STOP_VRU_CENTER_PAUSE_S = 2.5;
// Fraction of cause-first stops realised as a VRU yield (pedestrian crossing) vs a
// braking lead. The rest are lead_brake.
export const STOP_VRU_FRACTION = 0.35;
// Fraction of cause-first stops attempted as a stop-LINE stop. The WORKER half is ready
// (Solution B: caches `StopLine` world positions + eases the route-follower to a stop at
// the nearest line ahead; frame-aligned + tested) — but it only bites when a stop line is
// actually on the subject's route, and today the subject is placed at RANDOM junctions, ~105m+ off
// the few real stop lines (verified: 6 lines on Yale, 0 on any route). Re-enable once the
// PLACEMENT targets stop-line junctions (plumb signals.geojson stop-line positions into
// the generator). 0 keeps the overnight to the validated lead+vru subtypes.
export const STOP_SIGN_FRACTION = 0;

/** Curb lanes whose centerline passes within this distance of the subject spawn
 * are eligible for parked-car fill, so the parked cars line the subject's
 * immediate streetscape rather than the whole map. */
export const PARKED_FILL_RADIUS_METERS = 120;
/** Center-to-center spacing of parallel-parked cars along the curb (~4.7m car
 * + ~1.8m gap). */
export const PARKED_VEHICLE_SPACING_METERS = 6.5;
/** Never spawn a parked car closer than this to the SUBJECT (a car materializing on
 * the subject's bumper reads as a collision). Subject and parked cars sit in different
 * lanes, so this is a lateral/framing clearance, not a body-overlap guard. */
export const PARKED_EGO_CLEARANCE_METERS = 4;
/** Never spawn a parked car closer than this (center-to-center) to ANY
 * already-placed parked car. Must be ≥ a full car length: two ~4.7m cars closer
 * than their length overlap and EJECT in 3D physics ("flying parked car"). The
 * old code reused PARKED_EGO_CLEARANCE_METERS (4m < 4.7m) for this, so on maps
 * with overlapping/duplicated parking-lane records (Munich's World-Partition
 * OpenDRIVE) cross-lane cars landed ~4-5m apart, passed the 4m check, and flew.
 * 6.0m matches the within-lane spacing intent (~1.3m bumper gap). */
export const PARKED_MUTUAL_CLEARANCE_METERS = 6.0;
/** Curb lanes shorter than this are skipped (a single-slot stub reads as
 * clutter, not a parking row). */
export const PARKED_MIN_LANE_LENGTH_METERS = 6;
/** Per-density occupancy of the available curb slots + a hard per-scene cap on
 * parked cars (render-cost guardrail: parked cars are static so they cost far
 * less than autopilot traffic, but they still spawn + render). */
export const PARKED_DENSITY_PRESETS: Record<
  Exclude<BatchParkedDensity, "none">,
  { slotOccupancy: number; maxVehicles: number }
> = {
  light: { slotOccupancy: 0.3, maxVehicles: 12 },
  moderate: { slotOccupancy: 0.6, maxVehicles: 25 },
  heavy: { slotOccupancy: 0.9, maxVehicles: 45 },
};
// Image-native curb-parking mix: regular cars + the SUV + an occasional van
// (people park vans; no taxis/police parked at random curbs).
export const PARKED_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.lincoln.mkz",
  "vehicle.mini.cooper",
  "vehicle.sprinter.mercedes",
] as const;
