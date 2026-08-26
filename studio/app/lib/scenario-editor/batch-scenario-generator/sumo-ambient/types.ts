/**
 * SUMO offline ambient-traffic converter — input/output contracts.
 *
 * Architecture (see plans/sumo-ambient — offline generation, NOT co-simulation):
 * SUMO runs headless at EMIT time over a netconvert'd copy of the map's XODR
 * (`scripts/sumo/sumo-ambient-pipeline.sh`), its FCD trajectory output is
 * extracted into a `SumoTrajectoryFile` (`scripts/sumo/extract_fcd_trajectories.py`),
 * and this module converts those trajectories into background timed-path actors
 * in the scenario dialect. Everything downstream — worker validation, the 2D
 * gate, replay sidecars, 3D render — is unchanged: the traffic is plain
 * `placement_mode: "timed_path"` + `path_timing: "schedule"` actors baked into
 * the spec, exactly replayable by construction.
 *
 * Coordinate frame contract (verified empirically on Yale_St_Palo_Alto_CA):
 * netconvert is run with `--offset.disable-normalization true`, so SUMO net /
 * FCD coordinates ARE the XODR inertial frame, which IS the runtime/frontend
 * spec frame (median distance of FCD points to map-geometry.json driving-lane
 * centerlines: 0.21 m as-is vs 3203 m y-flipped). The worker owns the
 * runtime→CARLA y-flip at spawn time (`coordinate_frames.py`); this module
 * NEVER flips y. `verifyFrameAlignment` re-checks that invariant empirically on
 * every conversion rather than assuming it.
 */

import type { ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";

/** One FCD sample. `angle_deg` is SUMO's navigational angle: degrees, 0 = north
 * (+y in the net frame), increasing CLOCKWISE. `x`/`y` are the FRONT-BUMPER
 * center in net (= runtime) meters — SUMO positions vehicles by their front
 * bumper, so the converter shifts samples back by half the vehicle length. */
export interface SumoFcdSample {
  /** Seconds since the extraction window start (t=0 is clip start). */
  t: number;
  x: number;
  y: number;
  /** m/s along the vehicle heading. */
  speed: number;
  angle_deg: number;
}

export interface SumoVehicleTrack {
  id: string;
  /** SUMO vType id (distribution draws are normalized: "car_a@ambientMix" → "car_a"). */
  vtype: string;
  /** Samples ordered by t, typically at 0.1 s cadence. */
  samples: SumoFcdSample[];
}

/** The neutral trajectory file written by scripts/sumo/extract_fcd_trajectories.py. */
export interface SumoTrajectoryFile {
  source: "sumo-fcd";
  net: string;
  map: string;
  /** Always "xodr": native XODR inertial frame == runtime spec frame. */
  frame: "xodr";
  window: { t0: number; t1: number };
  sample_period_s: number;
  vehicles: SumoVehicleTrack[];
  /** vType id → vehicle length in meters (front-bumper→center shift). */
  vtype_lengths_m?: Record<string, number>;
}

/** Reference polyline in the runtime frame (a map-geometry.json driving lane,
 * or a topology-index lane polyline) used for empirical frame verification. */
export type RuntimeLanePolyline = Array<{ x: number; y: number }>;

export interface FrameAlignmentReport {
  /** Median distance (m) of sampled trajectory points to the nearest reference
   * lane centerline, as-is. */
  asIsMedianM: number;
  /** Same, with trajectory y negated. */
  flippedMedianM: number;
  sampledPoints: number;
  verdict: "as-is" | "flipped" | "ambiguous";
}

export interface SumoAmbientOptions {
  /** Clip duration; trajectory samples beyond it are cut. */
  clipDurationS: number;
  /** Hard cap on emitted ambient actors (nearest-to-priority-point win). */
  maxActors?: number;
  /** Spawn point de-overlap clearance vs scenario actors, meters. Mirrors the
   * ring's TRAFFIC_CAUSE_CLEARANCE_M (6 m ≈ car length + buffer). */
  spawnClearanceM?: number;
  /** Points ambient traffic must not spawn on top of: every scenario actor's
   * spawn (subject + cause + occluders + parked). */
  keepClearPoints?: Array<{ x: number; y: number }>;
  /** Priority point for the actor cap (normally the subject spawn). */
  priorityPoint?: { x: number; y: number };
  /** Drop tracks whose SPAWN sits farther than this from the priority point.
   * A timed_path actor materialises at its spawn at t=0; beyond the subject's
   * streaming bubble there is no ground collision, so a far spawn free-falls
   * through the world (measured: bg actors at 519/828 m fell 108-368 m on
   * SR-P1). The cap alone cannot prevent this — it ranks by CLOSEST APPROACH,
   * so a track that later passes the subject can still spawn 800 m away. */
  maxSpawnDistanceM?: number;
  /** Reference lane polylines (runtime frame) for the empirical frame gate.
   * When provided, conversion FAILS unless the as-is fit wins decisively. */
  referenceLanes?: RuntimeLanePolyline[];
  /** Max acceptable as-is median lane distance for the frame gate (m). */
  frameGateMaxMedianM?: number;
  /** Net bounding box, for the map-edge entry/exit policy. REQUIRED by
   * `buildSumoAmbientActors` — without it an interior-disappearing track is
   * kept and freezes mid-road (`SumoConversionContractError`). */
  netBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** A vehicle may enter late / exit early only within this margin of the net
   * boundary; interior late entries and interior early exits are dropped
   * (an interior early exit would freeze mid-road — the timed path cannot
   * despawn an actor). */
  edgeMarginM?: number;
  /** Additional legitimate entry/exit points beyond the bbox border — the
   * fringe-edge endpoints of a SUBNET (e.g. a freeway corridor cut out of a
   * city map: its on/off-ramp stubs end mid-bbox, and traffic legitimately
   * appears/vanishes there). A point within `edgeMarginM` of any of these
   * counts as "near the boundary" for the entry/exit policy. */
  netBoundaryPoints?: Array<{ x: number; y: number }>;
  /** Planned subject corridor (scene-time samples) for the emit-time safety check:
   * ambient tracks that come within `subjectCorridorClearanceM` of the subject at the
   * SAME scene time are dropped (reason "corridor_conflict"). Milliseconds
   * cheap; catches the open-loop-ambient-meets-scripted-subject class before the
   * 2D gate has to. */
  subjectCorridor?: Array<{ t: number; x: number; y: number }>;
  /** Clearance for the subject-corridor check (m). Default 5. */
  subjectCorridorClearanceM?: number;
  /** Planned trajectories of NON-subject scripted actors (conflict NPC, conflict
   * walker, extra cyclists) for the same time-synchronized emit-time check.
   * The conflict-family trap this exists for (task #76, measured): the tune
   * loop's only lever moves the CONFLICT actor, so an ambient track that meets
   * the subject or the conflict actor is unfixable by the loop — it converges
   * "cleanly" on a scene carrying a baked collision. Tracks within
   * `clearanceM` (default `subjectCorridorClearanceM`) of a scripted corridor at
   * the same scene time are dropped (reason "scripted_corridor_conflict",
   * detail names the scripted actor). Checked BEFORE the cap so a doomed
   * track never consumes an actor slot. */
  scriptedCorridors?: Array<{
    actorId: string;
    samples: Array<{ t: number; x: number; y: number }>;
    clearanceM?: number;
  }>;
  /** Minimum in-window presence; shorter tracks are not worth an actor slot. */
  minPresenceS?: number;
  /** Waypoint resampling cadence ceiling, seconds. */
  waypointCadenceS?: number;
  /** Resample keeps a sample early when heading changes this much (deg). */
  headingEpsDeg?: number;
  /** Resample keeps a sample early when speed changes this much (m/s). */
  speedEpsMps?: number;
  /** Hard per-actor waypoint cap (decimated uniformly if exceeded). */
  maxWaypointsPerActor?: number;
  /** Maximum perpendicular deviation (m) of the original track from the
   * resampled polyline. Cadence + heading/speed triggers are BLIND to shallow
   * highway lane changes (~3-5 degrees at speed): decimation flattens the
   * lateral migration into a chord that clips the neighbouring lane's car
   * (measured: recurring same-pair ambient collisions wherever the pair's
   * window appeared). Samples are re-inserted at the worst deviation until the
   * bound holds or the waypoint cap is reached. */
  maxPathDeviationM?: number;
  /** Deterministic blueprint-draw seed. */
  seed?: number;
  /** Fallback vehicle length when the vtype is unknown (m). */
  defaultVehicleLengthM?: number;
  /** Teleport-jump guard threshold (m/s). */
  maxPlausibleSpeedMps?: number;
}

export interface DroppedTrack {
  id: string;
  reason:
    | "short_presence"
    | "interior_late_entry"
    | "interior_early_exit"
    | "spawn_overlap"
    | "mutual_spawn_overlap"
    | "spawn_beyond_bubble"
    | "corridor_conflict"
    | "scripted_corridor_conflict"
    | "teleport_jump"
    | "over_cap";
  detail?: string;
}

export interface SumoAmbientResult {
  actors: ScenarioEditorActorDraft[];
  dropped: DroppedTrack[];
  frame: FrameAlignmentReport | null;
  stats: {
    inputVehicles: number;
    emitted: number;
    waypointTotal: number;
    waypointMaxPerActor: number;
    holdSegments: number;
  };
}

export const SUMO_AMBIENT_DEFAULTS = {
  maxActors: 32,
  spawnClearanceM: 6,
  frameGateMaxMedianM: 3,
  edgeMarginM: 30,
  minPresenceS: 3,
  waypointCadenceS: 1.0,
  headingEpsDeg: 8,
  speedEpsMps: 1.5,
  maxWaypointsPerActor: 60,
  seed: 47,
  defaultVehicleLengthM: 4.7,
  /** Any implied inter-sample speed above this marks a SUMO TELEPORT (gridlock
   * recovery jump) — the track is dropped rather than replayed as a 200 km/h
   * dash. Observed live: vehicle '1517' teleported at t=1798 of the Yale heavy
   * movie ("waited too long (yield)"). */
  maxPlausibleSpeedMps: 40,
} as const;

/** Id prefix that makes every converted actor part of the worker's DRESSING
 * population: excluded from contact metrics' conflict-actor resolution,
 * dropped from restamp frame records, spawn-tolerant. A SUMO ambient actor can
 * therefore never be scored as the conflict actor, structurally. */
export const SUMO_AMBIENT_ID_PREFIX = "bg-sumo-";
