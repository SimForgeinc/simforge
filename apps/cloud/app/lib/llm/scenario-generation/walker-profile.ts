/**
 * Conflict-pedestrian stature profiles.
 *
 * WHY THIS EXISTS. Euro NCAP's CPNCO cell — Car-to-Pedestrian Nearside CHILD
 * Obstructed — is specifically a child emerging from behind an obstruction. Our
 * `pedestrian_crossing_medium_occluder` families have claimed that cell while
 * staging adult walkers, which made the mapping approximate. A live probe of the
 * 0.10 image (2026-07-28) found exactly two child models, and until the walker
 * catalogue fix the generator could not address them at all.
 *
 * WHAT ACTUALLY CHANGES, and what does not. Our occlusion model is a PLAN-VIEW
 * sightline test: the occluder body must straddle the subject-eye-to-reveal-point
 * chord. It has no height term, so a shorter walker does NOT change the computed
 * reveal geometry — it changes what the 3D camera sees, which is the point of
 * the cell but not something the 2D solve can measure.
 *
 * The change the solve DOES see is GAIT. A child crosses at 1.1 m/s against the
 * planner's 1.3 m/s default, so the same crossing takes ~18% longer. Every
 * downstream quantity is derived from that speed — the pre-conflict approach
 * time, the crossing duration, and the curb hold solved against the subject's ETA —
 * so the conflict is re-solved, never inherited. Reusing adult timing with a
 * child walker would place the walker at the conflict point late and quietly
 * turn a staged collision into a miss.
 *
 * Speeds are the repo catalogue's own `walkSpeedMps`, which the probe
 * cross-checked against the spawned actors.
 */
import {
  CARLA_UE5_WALKER_ADULTS,
  CARLA_UE5_WALKER_CHILDREN,
  walkerBlueprintAt,
} from "@simcloud/shared";
import { PEDESTRIAN_LIMITS } from "@uniscenarios/sim-engine";

const WALKER_ACCELERATION_MPS2 = PEDESTRIAN_LIMITS.accelMax;

export type WalkerProfile = "adult" | "child";

/**
 * GAIT (dib 2026-07-29, BACKLOG #37). Euro NCAP CPNCO-50 reads "a child
 * pedestrian crossing its path RUNNING from behind an obstruction from the
 * nearside" (AEB/LSS VRU Test Protocol v4.5.1). We ship the cell with a WALKING
 * child, so the running variant is the correct reading of a cell we already
 * claim — not a new category.
 *
 * Gait is a SECOND axis on the same re-solve path as stature, and for the same
 * reason: it is a speed, and every downstream quantity in
 * `planPedestrianCrossingForSite` is derived from that speed. It is the LARGER
 * of the two effects. A child at the catalogue run speed covers the curb→lane-
 * centre leg in 1.1/2.0 = 55% of the walking time, so:
 *   - `tToConflictS` falls ~45%;
 *   - the curb hold GROWS by exactly that much, because the subject ETA is fixed by
 *     the back-walk and `hold = subjectEta − tToConflict`;
 *   - the REVEAL WINDOW — step-off to conflict, which is the subject's whole time to
 *     react once the child clears the occluder — falls ~45% with it.
 * Inheriting the walking solve would leave the child holding too short and
 * arriving early, i.e. crossing in front of a subject that is still far away: the
 * staged conflict quietly becomes a non-event, the mirror of the stature bug.
 */
export type WalkerGait = "walk" | "run";

/** The planner's historical default. Kept as the adult value so every existing
 *  scenario re-solves identically — this change must be inert for adults. */
export const ADULT_WALKER_SPEED_MPS = 1.3;

/** Catalogue `walkSpeedMps` for walker.pedestrian.0048/0049. */
export const CHILD_WALKER_SPEED_MPS = 1.1;

/** Catalogue `runSpeedMps` for walker.pedestrian.0048/0049 — the CPNCO-50 gait. */
export const CHILD_RUN_SPEED_MPS = 2.0;

/**
 * Catalogue `runSpeedMps` for the adult models.
 *
 * NOTE THE ASYMMETRY, which is deliberate: the adult WALK constant above is the
 * planner's historical 1.3, not the catalogue's 1.7–1.8, because changing it
 * would re-solve every shipped adult scene. The adult RUN value has no such
 * legacy to protect, so it is the catalogue's own number. Its only consumer is
 * the reactive companion that chases the child (see `buildReactiveCompanion`),
 * where a sprint is exactly the intent.
 */
export const ADULT_RUN_SPEED_MPS = 4.0;

export interface WalkerProfileSpec {
  readonly profile: WalkerProfile;
  /** Crossing speed fed to the timing solve. */
  readonly speedMps: number;
  /** Running speed — catalogue `runSpeedMps` for this profile's pool. */
  readonly runSpeedMps: number;
  /** Pool the conflict walker's blueprint is drawn from. */
  readonly pool: readonly string[];
  /** Measured stature, carried into scenario metadata for review + CoT. */
  readonly heightM: number;
  readonly label: string;
}

export const WALKER_PROFILES: Readonly<Record<WalkerProfile, WalkerProfileSpec>> = Object.freeze({
  adult: {
    profile: "adult",
    speedMps: ADULT_WALKER_SPEED_MPS,
    runSpeedMps: ADULT_RUN_SPEED_MPS,
    pool: CARLA_UE5_WALKER_ADULTS,
    heightM: 1.84,
    label: "Pedestrian",
  },
  child: {
    profile: "child",
    speedMps: CHILD_WALKER_SPEED_MPS,
    runSpeedMps: CHILD_RUN_SPEED_MPS,
    pool: CARLA_UE5_WALKER_CHILDREN,
    heightM: 1.11,
    label: "Child pedestrian",
  },
});

export function walkerProfileSpec(profile: WalkerProfile | undefined): WalkerProfileSpec {
  return WALKER_PROFILES[profile ?? "adult"];
}

/**
 * Crossing speed for a profile+gait — the single value the timing solve consumes.
 *
 * `gait` defaults to "walk", so every pre-existing call site keeps its exact
 * value and no shipped scene re-solves.
 */
export function walkerSpeedMps(
  profile: WalkerProfile | undefined,
  gait: WalkerGait | undefined = "walk",
): number {
  const spec = walkerProfileSpec(profile);
  return gait === "run" ? spec.runSpeedMps : spec.speedMps;
}

/** Human-readable gait for review sheets and CoT ("running"/"walking"). */
export function walkerGaitLabel(gait: WalkerGait | undefined): string {
  return gait === "run" ? "running" : "walking";
}

/**
 * The walker's STEP-OFF RAMP: how a walker actually leaves the kerb.
 *
 * MEASURED FAILURE THIS FIXES (2026-07-29, Saratoga, 40 sites). Authoring the
 * running child as [hold at the kerb] → [cross at full speed] made the batch
 * emit ZERO scenes: 31 of 39 rejections were the kinematic integrity lint,
 * "child pedestrian has an unexplained speed_discontinuity violation (peak
 * 20.00 m/s^2, threshold 15.00)". The authored track stepped the walker from a
 * dead stop to crossing speed inside one 0.1 s replay sample. Walking never
 * tripped it only because 1.1 m/s over 0.1 s is 11 m/s^2, under the limit —
 * 2.0 m/s is 20, over it. So the discontinuity was always there; the run gait
 * merely pushed it past the threshold.
 *
 * The lint is right and the AUTHORING was wrong. A real UE5 walker cannot
 * teleport to speed either: the worker clamps its acceleration to
 * WALKER_ACCELERATION_MPS2 (actor_physics.py). Expressing that ramp in the
 * waypoints makes the authored crossing something the runtime can actually
 * track, rather than a schedule it silently falls behind.
 *
 * Geometry: accelerating from rest to `v` at `a` covers `v^2/2a` in `v/a`
 * seconds. Every distance further along the crossing is therefore reached
 * `v/(2a)` seconds later than a constant-speed schedule predicts — a single
 * constant offset, which is why the meet-at-conflict solve stays exact: it
 * shifts `tToConflictS` and the curb hold absorbs it.
 */
export interface WalkerStepOffRamp {
  /** Distance covered while accelerating to full speed, metres. */
  readonly rampDistM: number;
  /** Time spent accelerating, seconds. */
  readonly rampTimeS: number;
  /** Constant lateness the ramp adds to EVERY downstream arrival, seconds. */
  readonly extraTimeS: number;
}

export function walkerStepOffRamp(speedMps: number): WalkerStepOffRamp {
  const a = WALKER_ACCELERATION_MPS2;
  return {
    rampDistM: (speedMps * speedMps) / (2 * a),
    rampTimeS: speedMps / a,
    extraTimeS: speedMps / (2 * a),
  };
}

/**
 * Does a straight-to-full-speed step-off exceed the integrity lint?
 *
 * Mirrors `DEFAULT_KINEMATIC_THRESHOLDS.integrity.speedJumpMps2` (15 m/s^2)
 * against the gate's own 0.1 s replay sampling. Used to author the ramp exactly
 * where the flat schedule is not physically expressible, so shipped walking
 * scenes keep their existing byte-identical waypoints.
 */
const GATE_SAMPLE_S = 0.1;
const GATE_SPEED_JUMP_LIMIT_MPS2 = 15;
export function stepOffNeedsRamp(speedMps: number): boolean {
  return speedMps / GATE_SAMPLE_S > GATE_SPEED_JUMP_LIMIT_MPS2;
}

/**
 * Deterministic blueprint for the conflict walker of a given profile.
 *
 * Adults keep a FIXED blueprint (index 0) rather than varying per scene: the
 * conflict walker carries the family's validated geometry, and letting it drift
 * would change what a re-render looks like for no benefit. Children have only
 * two models, so the index spreads across both.
 */
export function conflictWalkerBlueprint(
  profile: WalkerProfile | undefined,
  index = 0,
): string {
  const spec = walkerProfileSpec(profile);
  return spec.profile === "adult"
    ? walkerBlueprintAt(0, spec.pool)
    : walkerBlueprintAt(index, spec.pool);
}
