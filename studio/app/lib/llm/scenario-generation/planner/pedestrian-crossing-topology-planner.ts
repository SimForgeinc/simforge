/**
 * Deterministic pedestrian-crossing planner (topology-gated).
 *
 * Composes Task 3's site selector and Task 2's gate→subject-route helper into a
 * full `pedestrian_crossing` plan:
 *
 *   1. Pick a junction-approach Straight gate + conflict point
 *      (`selectPedestrianCrossingSite`).
 *   2. Route the subject STRAIGHT through that gate by back-walking
 *      `subjectSpeed × feasibleTimeS` from the conflict point
 *      (`buildSubjectRouteFromGate`), where `feasibleTimeS` floats in
 *      `[minTimeS, idealTimeS]` based on the chosen site's available room so
 *      the subject stays at FULL speed (we shorten the run-up rather than slow the
 *      subject).
 *   3. Synthesise a perpendicular walker crossing whose START TIME is SOLVED
 *      so the walker reaches the conflict point (lane centre) exactly when the
 *      subject does.
 *
 * The subject ETA is fixed by the back-walk (≈ feasibleTimeS ∈ [minTimeS,
 * idealTimeS]: idealTimeS when room is ample, shorter when upstream room caps
 * the run-up). The walker's curb-hold is the dependent variable:
 * hold = max(0, subjectEta − tToConflict).
 *
 * This mirrors the npc/walker conventions of the legacy heuristic
 * `planPedestrianCrossing` in `collision-route-planner.ts` so that downstream
 * draft assembly (`plannedCollisionToDraftActors`, which returns `[subject, walker]`
 * whenever a walker is present and never reads `collision.npc` for walker
 * scenarios) is byte-for-byte identical. In particular `collision.npc` is set
 * to the subject plan (the walker is surfaced separately via `walker`), exactly as
 * the heuristic does.
 *
 * Pure math on topology data — no server I/O.
 */
import {
  stepOffNeedsRamp,
  walkerGaitLabel,
  walkerSpeedMps,
  walkerStepOffRamp,
  type WalkerGait,
  type WalkerProfile,
  } from "@/app/lib/llm/scenario-generation/walker-profile";
import type {
  MapTopologyIndex,
} from "@simforge-oss/maps/topology";
import {
  Vec2,
} from "@simforge-oss/maps/topology";
import type {
  PlannedActor,
  PlannedCollision,
  PlannedWalker,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import {
  buildSubjectRouteFromGate,
  buildPlannedActorFromTopology,
  orientLanePolylineToTravel,
} from "./gate-subject-route";
import { isMidblockGateId } from "./midblock-ped-site-selector";
import {
  selectPedestrianCrossingSite,
  type PedCrossingSite,
  type PedSiteSelectionTrace,
} from "./pedestrian-crossing-site-selector";
import {
  resolveCrossingLine,
  type ProjectedCrosswalk,
  type ProjectedSidewalk,
} from "./pedestrian-crossing-geometry";

// ── Constants ────────────────────────────────────────────────────────────────

/** Walker pace, metres per second (≈ a brisk-but-natural pedestrian). */

/** Curb-holds shorter than this are dropped: the walker steps off immediately,
 *  so the repeated spawn waypoint that encodes the hold becomes a degenerate
 *  two-vertices-at-t=0 stub that confuses the runtime trajectory follower and
 *  desyncs under road-snap. */
const MIN_HOLD_S = 0.1;

/** Half-width of the modelled crossing, metres. The walker starts at
 *  `conflict − u·HALF_WIDTH_M` and ends at `conflict + u·HALF_WIDTH_M`,
 *  passing through the conflict point (lane centre) at the midpoint. */
const HALF_WIDTH_M = 4;
/** Mid-block sites: max curb→conflict spawn offset before the resolved
 *  crossing is rejected in favor of the tight perpendicular fallback. */
const MIDBLOCK_MAX_SPAWN_OFFSET_M = 12;

// ── Public types ─────────────────────────────────────────────────────────────

export interface PedTopoArgs {
  /** Conflict-walker stature. `child` uses the slower child gait (and the
   *  0.10 image's only small models) — Euro NCAP CPNCO. Default adult. */
  walkerProfile?: WalkerProfile;
  /** Conflict-walker gait. `run` is Euro NCAP CPNCO-50's own wording and re-solves
   *  the crossing off the catalogue run speed. Default walk. */
  walkerGait?: WalkerGait;
  topology: MapTopologyIndex;
  anchor: Vec2;
  subjectSpeedKph: number;
  /** Ideal seconds of approach run-up (collision-window ideal). Used as the
   *  UPPER bound on the floated arrival time when room is ample. */
  idealTimeS: number;
  /** Minimum acceptable seconds of run-up (collision-window minimum). Gates
   *  the room guard (selector) and the LOWER bound on the floated arrival
   *  time. */
  minTimeS: number;
  /** Crosswalk polygons near the conflict, projected to runtime meters. Drive
   *  the crossing-line resolver's top tier (cross along a real marked crossing).
   *  Omit to resolve from topology sidewalk lanes / road edge only. */
  crosswalks?: ProjectedCrosswalk[];
  /** Sidewalk centrelines near the conflict, projected to runtime meters
   *  (Overture `sidewalk_segment`). The resolver spawns the walker on the
   *  nearest one when the XODR has no sidewalk lanes. */
  sidewalks?: ProjectedSidewalk[];
  /** Pedestrian POI points (bus stop / transit / frontage), runtime meters.
   *  Used as a spawn surface (and side bias) when no crosswalk/sidewalk fits. */
  poiPoints?: Vec2[];
}

/** Per-site build arguments — `planPedestrianCrossingForSite` takes an
 *  already-selected `PedCrossingSite` (no anchor; the site already encodes the
 *  conflict geometry). */
export interface PedSiteBuildArgs {
  /** See PedTopoArgs.walkerProfile. */
  walkerProfile?: WalkerProfile;
  /** See PedTopoArgs.walkerGait. */
  walkerGait?: WalkerGait;
  topology: MapTopologyIndex;
  subjectSpeedKph: number;
  idealTimeS: number;
  minTimeS: number;
  /** Optional selection trace to carry on `result.trace.site`. When omitted a
   *  minimal single-site trace is synthesised so the result is self-describing
   *  even when the caller didn't run the full selector. */
  siteTrace?: PedSiteSelectionTrace;
  /** Crosswalk polygons near the conflict, projected to runtime meters (top
   *  tier of the crossing-line resolver). */
  crosswalks?: ProjectedCrosswalk[];
  /** Sidewalk centrelines near the conflict, projected to runtime meters. */
  sidewalks?: ProjectedSidewalk[];
  /** Pedestrian POI points (bus stop / transit / frontage), runtime meters —
   *  spawn surface / side bias when no crosswalk/sidewalk fits. */
  poiPoints?: Vec2[];
}

export interface PedTopoResult {
  collision: PlannedCollision;
  walker: PlannedWalker;
  trace: {
    site: PedSiteSelectionTrace;
    subject: {
      /** Gate chain rsls: [approach, connecting, ...exits]. */
      lanes: string[];
      speedKph: number;
      backWalkM: number;
      /** Achieved ETA to the conflict point (may be < ideal). */
      etaToConflictS: number;
    };
    walker: {
      conflict: { x: number; y: number };
      /** Solved curb-hold before the walker steps off. */
      holdS: number;
      /** Time from start-curb to lane centre (conflict point).
       *
       *  This is also the REVEAL WINDOW for an occluded crossing: the walker is
       *  hidden behind the occluder for the whole hold, so the subject's time to
       *  react runs from step-off to the conflict. It is the quantity gait moves
       *  most — a running child gives the subject 55% of the walking window. */
      tToConflictS: number;
      speedMps: number;
      /** Gait the crossing was solved at. */
      gait: WalkerGait;
      /** How the crossing line was resolved: crosswalk | sidewalk | road_edge
       *  | fixed_fallback (legacy ±HALF_WIDTH when topology was too sparse). */
      crossingSource: string;
    };
  };
}

/** Result of the nearest-first re-pick search over candidate sites. */
export interface PickFirstValidatingSiteResult<TPlan> {
  /** The site whose plan was the first to validate. */
  acceptedSite: PedCrossingSite;
  /** The plan built for the accepted site. */
  plan: TPlan;
  /** How many sites were attempted (planned) before one validated, inclusive
   *  — i.e. the 1-based index of the accepted site among `sites`. */
  sitesTried: number;
}

// ── Re-pick decision helper ────────────────────────────────────────────────────

/**
 * Topological-reachability gate: walk the proximity-ranked `sites` nearest-first
 * and return the FIRST site whose plan kinematically validates.
 *
 * Pure decision logic — no I/O, no builder coupling. `planForSite(site)` builds
 * a plan for one site (or `null` if it can't be planned, e.g. subject back-walk
 * failed); `validate(plan)` returns the post-snap kinematic verdict. A site is
 * accepted iff `planForSite` yields a plan AND `validate` returns
 * `verdict === "pass"`. Sites that fail to plan are skipped without a validate
 * call; sites that plan but fail validation are skipped after one validate.
 *
 * Exactly one `validate` per site that produced a plan (the caller bounds the
 * input list length to cap cost). Returns `null` when no site validates.
 */
export function pickFirstValidatingSite<TPlan>(
  sites: readonly PedCrossingSite[],
  planForSite: (site: PedCrossingSite) => TPlan | null,
  validate: (plan: TPlan) => { verdict: "pass" | "fail" },
): PickFirstValidatingSiteResult<TPlan> | null {
  let sitesTried = 0;
  for (const site of sites) {
    sitesTried += 1;
    const plan = planForSite(site);
    if (!plan) continue; // couldn't plan this site — skip, no validate.
    const { verdict } = validate(plan);
    if (verdict === "pass") {
      return { acceptedSite: site, plan, sitesTried };
    }
  }
  return null;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a deterministic, topology-gated pedestrian-crossing plan for ONE
 * already-selected site.
 *
 * This is the per-site half of the planner: the selection (which gate) is done
 * upstream; here we route the subject STRAIGHT through `site`'s gate and synthesise
 * the timed walker. The builder's nearest-first re-pick loop calls this once
 * per candidate site (cheap — no I/O) and validates each result, accepting the
 * first whose post-snap scenario kinematically reaches the walker.
 *
 * Returns `null` when the subject route can't be back-walked from the site's
 * conflict point.
 */
export function planPedestrianCrossingForSite(
  site: PedCrossingSite,
  a: PedSiteBuildArgs,
): PedTopoResult | null {
  const { topology, subjectSpeedKph, idealTimeS, minTimeS } = a;

  // Selection trace to carry on the result. When the caller (e.g. the gated
  // wrapper) ran the full selector it threads its trace through; otherwise
  // synthesise a minimal single-site trace so the result stays self-describing.
  const siteTrace: PedSiteSelectionTrace = a.siteTrace ?? {
    candidates: 1,
    afterLaneGuard: 1,
    afterRoomGuard: 1,
    topN: [{ gate: site.gate.id, score: site.score, reasons: [] }],
    rejected: [],
    chosen: site.gate.id,
  };

  // 2. Route the subject STRAIGHT through the gate. Float the run-up time into
  //    `[minTimeS, idealTimeS]` based on the chosen site's available room: use
  //    the full ideal run-up when there is room for it, otherwise shorten the
  //    run-up to what fits — at FULL speed. `finalizePlannedActor` scales the
  //    sim speed so the subject covers `backwardM` in `feasibleTimeS`; passing a
  //    matching (smaller) `backwardM` AND `arrivalTimeS` keeps that speed equal
  //    to the family default rather than slowing the subject to stretch a short
  //    approach to idealTimeS.
  const speedMps = subjectSpeedKph / 3.6;
  const feasibleTimeS = Math.min(
    idealTimeS,
    Math.max(minTimeS, site.roomM / speedMps),
  );
  const backwardM = speedMps * feasibleTimeS; // ≤ site.roomM
  // Mid-block sites carry a SYNTHETIC gate (no junction to route through):
  // the subject chain is the crossing lane itself, and the shared chain builder
  // handles the backward predecessor walk for run-up beyond the lane start.
  const subject: PlannedActor | null = isMidblockGateId(site.gate.id)
    ? (() => {
        const lane = topology.lanes[site.gate.approachLaneRsl];
        if (!lane?.polyline || lane.polyline.length < 2) return null;
        // Travel-oriented, matching the site selector's arc frame: the raw
        // +s-ordered polyline is BACKWARD for positive-id lanes, which
        // authored the subject wrong-way from waypoint 0 (2026-08-01 ledger).
        return buildPlannedActorFromTopology(
          topology,
          [
            {
              rsl: site.gate.approachLaneRsl,
              oriented: orientLanePolylineToTravel(site.gate.approachLaneRsl, lane),
            },
          ],
          site.conflictArc,
          backwardM,
          site.conflictPoint,
          feasibleTimeS,
        );
      })()
    : buildSubjectRouteFromGate({
        topology,
        gate: site.gate,
        conflictArc: site.conflictArc,
        conflictPoint: site.conflictPoint,
        backwardDistanceM: backwardM,
        arrivalTimeS: feasibleTimeS,
      });
  if (!subject) return null;

  // 3. ACHIEVED subject ETA — use `subject.expectedSpeedKph`, the speed scaled by
  //    `finalizePlannedActor` so the subject covers the *actual* polyline length
  //    (joint-gap segments included) in exactly `arrivalTimeS`.  The simulator
  //    drives at `expectedSpeedKph`, so the real arrival time at the conflict
  //    is `arcLengthM / (expectedSpeedKph / 3.6)` ≈ feasibleTimeS.
  //    Using the raw `subjectSpeedKph` (the family-default input) would
  //    over-estimate ETA because the polyline is always ≥ the intended
  //    back-walk distance, making the walker mis-time vs the actual subject.
  const subjectEtaS = subject.arcLengthM / (subject.expectedSpeedKph / 3.6);

  // 4. Walker crossing through the conflict point. Resolve a curb-to-curb line
  //    from real map data (crosswalk → sidewalk → road edge); fall back to the
  //    legacy fixed-width perpendicular only when topology is too sparse to
  //    resolve one (so no regression on un-enriched maps). The line always
  //    passes THROUGH the conflict point; start time is SOLVED so the walker
  //    reaches it at the subject ETA.
  let resolved = resolveCrossingLine({
    topology,
    conflictPoint: site.conflictPoint,
    approachLaneRsl: site.gate.approachLaneRsl,
    crossingAxisRad: site.crossingAxisRad,
    crosswalks: a.crosswalks,
    sidewalks: a.sidewalks,
    poiPoints: a.poiPoints,
  });
  // Mid-block guard: away from junctions the sidewalk/crosswalk data is often
  // sparse, and the resolver can latch onto a DISTANT curb (observed: walker
  // spawn 77m from the conflict — an unreactable, occluder-defeating crossing).
  // Cap the spawn-side offset and fall back to the tight fixed perpendicular.
  if (resolved && isMidblockGateId(site.gate.id)) {
    const spawnOffM = Math.hypot(
      resolved.spawn.x - site.conflictPoint.x,
      resolved.spawn.y - site.conflictPoint.y,
    );
    if (spawnOffM > MIDBLOCK_MAX_SPAWN_OFFSET_M) resolved = null;
  }

  let start: Vec2;
  let end: Vec2;
  let crossingSource: string;
  if (resolved) {
    start = resolved.spawn;
    end = resolved.far;
    crossingSource = resolved.source;
  } else {
    const ux = Math.cos(site.crossingAxisRad);
    const uy = Math.sin(site.crossingAxisRad);
    start = {
      x: site.conflictPoint.x - ux * HALF_WIDTH_M,
      y: site.conflictPoint.y - uy * HALF_WIDTH_M,
    };
    end = {
      x: site.conflictPoint.x + ux * HALF_WIDTH_M,
      y: site.conflictPoint.y + uy * HALF_WIDTH_M,
    };
    crossingSource = "fixed_fallback";
  }
  // Asymmetric crossing: distances are measured from the resolved endpoints
  // rather than a fixed half-width.
  //
  // ONE speed drives the whole solve, and it is a function of BOTH stature and
  // gait. Hoisted to a single binding so a future axis cannot re-solve half the
  // crossing and inherit the other half — the failure mode this module exists to
  // prevent. A running child's `tToConflictS` is ~55% of the walking value, which
  // (subject ETA being fixed by the back-walk) lands entirely on the curb hold.
  const crossSpeedMps = walkerSpeedMps(a.walkerProfile, a.walkerGait);
  // STEP-OFF RAMP. A walker cannot leave the kerb at full speed — the worker
  // clamps it to WALKER_ACCELERATION_MPS2 — and authoring it that way made the
  // running child fail the kinematic integrity lint at 31 of 40 sites (peak
  // 20.00 m/s^2 vs a 15.00 threshold: 2.0 m/s inside one 0.1 s replay sample).
  // Authored only where the flat step-off is not physically expressible, so
  // every shipped walking scene keeps byte-identical waypoints.
  const ramp = stepOffNeedsRamp(crossSpeedMps) ? walkerStepOffRamp(crossSpeedMps) : null;
  const dToConflictM = Math.hypot(
    start.x - site.conflictPoint.x,
    start.y - site.conflictPoint.y,
  );
  // The ramp adds ONE constant to every downstream arrival, so the meet solve is
  // unchanged in form: the curb hold simply absorbs it.
  const tToConflictS = dToConflictM / crossSpeedMps + (ramp?.extraTimeS ?? 0);
  const crossLenM = Math.hypot(end.x - start.x, end.y - start.y);
  const crossDurS = crossLenM / crossSpeedMps + (ramp?.extraTimeS ?? 0);
  const holdS = Math.max(0, subjectEtaS - tToConflictS);
  // Unit vector along the crossing, for the ramp vertex.
  const crossUx = crossLenM > 1e-9 ? (end.x - start.x) / crossLenM : 0;
  const crossUy = crossLenM > 1e-9 ? (end.y - start.y) / crossLenM : 0;

  // Encode the curb-hold as a repeated spawn waypoint ONLY when it's non-
  // trivial. When holdS ≈ 0 the walker steps off at once, so the duplicate is a
  // degenerate two-vertices-at-t=0 stub — emit a clean [start, end] line.
  // The ramp is ONE extra vertex at the point full speed is reached. Its incoming
  // average speed is v/2, so the step-off jump halves (2.0 m/s -> 10 m/s^2, inside
  // the 15 limit) and the second leg picks up the remaining v/2 just as gently.
  const startT = holdS > MIN_HOLD_S ? holdS : 0;
  const rampVertex =
    ramp && ramp.rampDistM < crossLenM
      ? [
          {
            x: start.x + crossUx * ramp.rampDistM,
            y: start.y + crossUy * ramp.rampDistM,
            time: startT + ramp.rampTimeS,
          },
        ]
      : [];
  const waypoints =
    holdS > MIN_HOLD_S
      ? [
          { x: start.x, y: start.y, time: 0 },
          { x: start.x, y: start.y, time: holdS },
          ...rampVertex,
          { x: end.x, y: end.y, time: holdS + crossDurS },
        ]
      : [
          { x: start.x, y: start.y, time: 0 },
          ...rampVertex,
          { x: end.x, y: end.y, time: crossDurS },
        ];
  const walker: PlannedWalker = {
    spawnPoint: start,
    waypoints,
    rationale: `Walker spawns at the ${crossingSource} curb, holds ${holdS.toFixed(1)}s (solved from subject ETA ${subjectEtaS.toFixed(1)}s) then crosses ${crossLenM.toFixed(0)}m ${walkerGaitLabel(a.walkerGait)} at ${crossSpeedMps} m/s — reaching the conflict point at the planned ${subjectEtaS.toFixed(1)}s, ${tToConflictS.toFixed(1)}s after stepping off.`,
  };

  // 5. Collision. `npc` mirrors the legacy heuristic: the walker IS the NPC
  //    but is surfaced separately, so npc is set to the subject plan and never
  //    consumed by the walker draft path.
  const collision: PlannedCollision = {
    conflictPoint: site.conflictPoint,
    arrivalTimeS: subjectEtaS,
    subject,
    npc: subject, // walker is the NPC, but it's surfaced separately
    rationale: `Pedestrian crossing — subject drives Straight through gate ${site.gate.id} (junction ${site.gate.junctionId}); walker crosses ${crossLenM.toFixed(0)}m at the conflict point (${crossingSource} curb), timed to meet the subject at ${subjectEtaS.toFixed(1)}s.`,
    subjectGate: {
      junctionId: site.gate.junctionId,
      gateId: site.gate.id,
      turnRelation: "Straight",
      headingChangeRad: site.gate.headingChangeRad,
    },
  };

  // 6. Trace.
  // Start from the gate chain rsls; prepend subject.spawnLaneId when the subject
  // spawned on an upstream predecessor lane (i.e. the back-walk extended
  // beyond the approach lane's start).
  const gateLaneChain = [
    site.gate.approachLaneRsl,
    site.gate.connectingLaneRsl,
    ...site.gate.exitLaneRsls,
  ];
  const laneChain =
    subject.spawnLaneId !== gateLaneChain[0]
      ? [subject.spawnLaneId, ...gateLaneChain]
      : gateLaneChain;

  return {
    collision,
    walker,
    trace: {
      site: siteTrace,
      subject: {
        lanes: laneChain,
        speedKph: subjectSpeedKph,
        backWalkM: backwardM,
        etaToConflictS: subjectEtaS,
      },
      walker: {
        conflict: site.conflictPoint,
        holdS,
        tToConflictS,
        speedMps: crossSpeedMps,
        gait: a.walkerGait ?? "walk",
        crossingSource,
      },
    },
  };
}

/**
 * Build a deterministic, topology-gated pedestrian-crossing plan.
 *
 * Thin wrapper: pick the proximity-ranked sites (`selectPedestrianCrossingSite`)
 * and build the TOP site (`sites[0]`). Existing callers/tests rely on this
 * single-site behaviour; the builder uses the selector + `planPedestrianCrossingForSite`
 * directly to try sites nearest-first.
 *
 * Returns `null` when no viable Straight gate exists, or when the subject route
 * can't be back-walked from the chosen conflict point.
 */
export function planPedestrianCrossingGatedTopology(
  a: PedTopoArgs,
): PedTopoResult | null {
  const { topology, anchor, subjectSpeedKph, idealTimeS, minTimeS } = a;

  // 1. Pick the crossing sites. The room guard requires only the MINIMUM
  //    run-up (minTimeS), keeping mid-room gates the ideal-time guard rejected.
  const picked = selectPedestrianCrossingSite({
    topology,
    anchor,
    subjectSpeedKph,
    minTimeS,
  });
  if (!picked || picked.sites.length === 0) return null;

  // Build the top (nearest-to-anchor) site, threading the full selection trace.
  //
  // `walkerProfile`/`walkerGait` are forwarded HERE deliberately. Until now this
  // wrapper accepted `walkerProfile` on `PedTopoArgs` and then dropped it on the
  // floor, so any caller that went through the wrapper silently got adult walking
  // timing no matter what it asked for. The batch generator escaped it only
  // because it calls `planPedestrianCrossingForSite` directly. Dropping a speed
  // axis is exactly the inherit-the-wrong-solve bug this module guards against,
  // so both axes are threaded and asserted in the unit tests.
  return planPedestrianCrossingForSite(picked.sites[0]!, {
    topology,
    walkerProfile: a.walkerProfile,
    walkerGait: a.walkerGait,
    subjectSpeedKph,
    idealTimeS,
    minTimeS,
    siteTrace: picked.trace,
    crosswalks: a.crosswalks,
    sidewalks: a.sidewalks,
    poiPoints: a.poiPoints,
  });
}
