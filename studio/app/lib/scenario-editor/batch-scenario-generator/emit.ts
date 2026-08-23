import type {
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
  TimedInstructionIntent,
  TimedInstructionPrimitiveId,
} from "@simcloud/shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type { ParkingLaneRef } from "@/app/lib/maps/topology/parking-lanes";
import type { NormalizedScenarioDraft } from "../draft-normalization";
import type { BatchEnvironmentPreset } from "./variation";
import { PRESET_ALPAMAYO_PAI, sensorsFromPreset } from "../sensor-rigs";
import { finalizeGeneratedActorBehaviors } from "@/app/lib/scenario-generation/generated-actor-behavior";
import type {
  BatchParkedDensity,
  BatchScenarioStrategy,
  BatchTrafficProfile,
  BatchTrafficSource,
  Candidate,
  PlacedVariation,
  ScenarioVariation,
  StopScenarioPlan,
} from "./types";
import { isLaneKeepStrategy, isStopJunctionStrategy, laneChangeSide } from "./types";
import {
  SUBJECT_BLUEPRINT,
  SUBJECT_COLOR,
  SUBJECT_STOP_FORWARD_RUNWAY_M,
  SURVIVAL_HORIZON_S,
} from "./constants";
import {
  buildForwardRouteThroughSuccessors,
  buildRouteViaChain,
  withWorldAnchor,
} from "./routing";
import {
  buildBatchTrafficActors,
  buildJamPaceLead,
  buildCrossingVruActor,
  buildHeavyTrafficFillActors,
  buildOvertakeTrafficActors,
  buildParkedActors,
  buildStopLeadActor,
} from "./actors";
import { isOvertakeStrategy } from "./types";
import { buildSumoAmbientActors, signalPlansForWindow } from "./sumo-ambient";
import type {
  SumoAmbientOptions,
  SumoAmbientResult,
  SumoSignalProgram,
  SumoTrajectoryFile,
} from "./sumo-ambient";
import { stampNominalGeneratedOutput } from "@/app/lib/scenario-generation/scenario-intention";

/** Everything the emit path needs to lift a warmed SUMO window into a scene.
 * The trajectory itself is passed IN (already read from the movie by the
 * caller) — the generator stays pure and does no file I/O. */
export type SumoAmbientEmitInput = {
  trajectory: SumoTrajectoryFile;
  /** Provenance for the spec's variation params: which movie + window this came from. */
  movieId: string;
  windowT0S: number;
  /** Converter overrides; sensible defaults come from SUMO_AMBIENT_DEFAULTS. */
  options?: Partial<
    Omit<SumoAmbientOptions, "clipDurationS" | "keepClearPoints" | "priorityPoint">
  >;
  /** Reference lane polylines for the empirical frame gate. REQUIRED — the
   * conversion FAILS CLOSED (SumoConversionContractError) without them, and
   * FAILS (SumoFrameMismatchError) when the as-is fit does not win decisively:
   * that is what stops a y-flipped or wrong-map net from silently emitting
   * traffic that drives through buildings. */
  referenceLanes: NonNullable<SumoAmbientOptions["referenceLanes"]>;
  /** Net bounding box for the map-edge entry/exit policy. REQUIRED — without
   * it an interior-disappearing track is kept and freezes mid-road. */
  netBounds: NonNullable<SumoAmbientOptions["netBounds"]>;
  /** Subnet fringe endpoints (corridor cuts) that also count as legitimate
   * entry/exit locations. */
  netBoundaryPoints?: SumoAmbientOptions["netBoundaryPoints"];
  /** Clip length the schedule is cut to. */
  clipDurationS: number;
  /**
   * `signal_program.json` for this map, written at emit-prep by
   * `scripts/sumo/signal_program.py`. When present, the scene's junctions are
   * authored in `program` mode on the SAME cycle the reel was simulated
   * against, phase-shifted to `windowT0S` — which is what stops the render's
   * lights disagreeing with the queues baked into the trajectory. Omit it and
   * the traffic still obeys traffic control (obedience lives in the
   * trajectory), but CARLA runs its map-default cycle and a baked queue can end
   * up sitting under a green head.
   */
  signalProgram?: SumoSignalProgram;
  /** Receives the per-scene conversion audit (drops by reason, frame report,
   * waypoint stats) so the caller can write conversion-report.json. */
  onReport?: (report: SumoAmbientResult & { movieId: string; windowT0S: number }) => void;
};

/** World spawn position of an actor draft, for SUMO keep-clear / priority
 * geometry. Road-anchored actors (the traffic ring, the heavy fill, scripted
 * leads) carry `spawn.world_anchor`; point-mode actors carry `spawn_point` —
 * the same dual lookup buildParkedActors uses to dedup against them. Getting
 * this wrong would silently return no keep-clear points and let SUMO traffic
 * spawn on top of the scripted cause. */
function actorSpawnPoint(
  actor: ScenarioEditorActorDraft,
): { x: number; y: number } | null {
  const w = actor.spawn?.world_anchor;
  if (w && Number.isFinite(w.x) && Number.isFinite(w.y)) return { x: w.x, y: w.y };
  const p = actor.spawn_point;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  return null;
}

/** Approximate the subject's planned corridor as scene-time samples: hold at the
 * spawn through the instruction delay, then run the spawn-lane centerline at
 * cruise speed. 1 s cadence — the corridor check interpolates between samples.
 * Ends where the centerline ends (no extrapolation): a shorter corridor only
 * under-checks the tail, it cannot create false conflicts. */
export function plannedEgoCorridor(
  subjectPoint: { x: number; y: number },
  segment: RuntimeRoadSegment,
  variation: ScenarioVariation,
  clipDurationS: number,
): Array<{ t: number; x: number; y: number }> {
  const line = (segment.centerline ?? []) as Array<{ x: number; y: number; s: number }>;
  if (line.length < 2) return [];
  // Nearest centerline vertex to the subject spawn = corridor origin.
  let originIdx = 0;
  let best = Infinity;
  for (let i = 0; i < line.length; i += 1) {
    const d =
      (line[i]!.x - subjectPoint.x) * (line[i]!.x - subjectPoint.x) +
      (line[i]!.y - subjectPoint.y) * (line[i]!.y - subjectPoint.y);
    if (d < best) {
      best = d;
      originIdx = i;
    }
  }
  const s0 = line[originIdx]!.s;
  const speedMps = Math.max(1, (variation.speedKph ?? 30) / 3.6);
  const delayS = Math.max(0, variation.instructionDelaySeconds ?? 0);
  const atArc = (arc: number): { x: number; y: number } | null => {
    const target = s0 + arc;
    for (let i = originIdx; i < line.length - 1; i += 1) {
      const a = line[i]!;
      const b = line[i + 1]!;
      if (target >= a.s && target <= b.s) {
        const f = b.s === a.s ? 0 : (target - a.s) / (b.s - a.s);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return null; // past the centerline end — stop, do not extrapolate
  };
  const samples: Array<{ t: number; x: number; y: number }> = [];
  for (let t = 0; t <= clipDurationS; t += 1) {
    const arc = Math.max(0, t - delayS) * speedMps;
    const p = atArc(arc);
    if (!p) break;
    samples.push({ t, x: p.x, y: p.y });
  }
  return samples;
}

function primitiveForStrategy(strategy: BatchScenarioStrategy): TimedInstructionPrimitiveId {
  switch (strategy) {
    case "lane_change_left":
    case "overtake_left":
    case "highway_lane_change_left":
      return "lane_change_left";
    case "lane_change_right":
    case "overtake_right":
    case "highway_lane_change_right":
      return "lane_change_right";
    case "turn_left":
      return "turn_left_at_next_intersection";
    case "turn_right":
      return "turn_right_at_next_intersection";
    case "stop":
      return "stop";
    case "lane_keep":
    default:
      return "lane_follow";
  }
}

export function instructionsForStrategy(
  strategy: BatchScenarioStrategy,
  seed: number,
  variation: ScenarioVariation,
  stopPlan?: StopScenarioPlan | null,
): TimedInstructionIntent[] {
  const generatorMeta = (tags: string[]) => ({
    seed: String(seed),
    strategyId: strategy,
    candidateRank: 0,
    tags: ["batch", "normal_driving", strategy, ...tags],
  });
  if (strategy === "stop" && stopPlan?.subjectStopMode === "tm_follow") {
    // CAUSE-FIRST stop (2026-06-24): NO forced subject stop and NO timed instruction.
    // The subject is given an explicit forward ROUTE on its lane (set in
    // applyGeneratedDraft) → the worker runs it as a deterministic freeform-pursuit
    // path WITH obstacle-aware stopping, so it follows the known route (no TM
    // junction-divergence) and stops NATURALLY behind the instantiated cause (a
    // stopped lead ahead on that route). Smooth decel, genuinely caused.
    return [];
  }
  if (strategy === "stop" && stopPlan) {
    // Causal stop: brake row + optional post-window resume row. The stop row
    // does not advance the compiler's lane-graph cursor, so a junction
    // proceed row still validates against the SPAWN segment's turn_options
    // (guaranteed present by chooseJunctionProceed). The resume row carries
    // speedKph so the worker clears its stopped state and re-enables
    // autopilot at cruise speed.
    const rows: TimedInstructionIntent[] = [
      {
        id: `tii_batch_${seed}`,
        timestampSeconds: stopPlan.subjectStopAtSeconds,
        rowOrder: 0,
        enabled: true,
        primitiveId: "stop",
        args: { until: stopPlan.subjectResume ? "next_instruction" : "scenario_end" },
        source: "generator",
        generator: generatorMeta([`stop_${stopPlan.variant}`]),
        validationErrors: [],
      },
    ];
    if (stopPlan.subjectResume) {
      rows.push({
        id: `tii_batch_${seed}_resume`,
        timestampSeconds: stopPlan.subjectResume.atSeconds,
        rowOrder: 1,
        enabled: true,
        primitiveId: stopPlan.subjectResume.primitiveId,
        args: { speedKph: stopPlan.subjectResume.speedKph },
        source: "generator",
        generator: generatorMeta([`stop_${stopPlan.variant}`, "stop_resume"]),
        validationErrors: [],
      });
    }
    return rows;
  }
  const primitiveId = primitiveForStrategy(strategy);
  const timestampSeconds =
    isLaneKeepStrategy(strategy) ? 0 : variation.instructionDelaySeconds;
  // No lane_follow lead row before the delayed maneuver: the worker drives
  // timed-instruction vehicles from t=0 by default (strict-TM lane follow at
  // spec speed), and a lead row would advance the compiler's lane-graph
  // cursor so turn/lane-change rows validate against the wrong segment.
  return [
    {
      id: `tii_batch_${seed}`,
      timestampSeconds,
      rowOrder: 0,
      enabled: true,
      primitiveId,
      args:
        primitiveId === "stop"
          ? { until: "scenario_end" }
          : primitiveId.startsWith("lane_change")
            ? { speedKph: variation.speedKph, transitionMeters: 25 }
            : { speedKph: variation.speedKph },
      source: "generator",
      generator: generatorMeta([]),
      validationErrors: [],
    },
  ];
}

export function applyGeneratedDraft(input: {
  draft: NormalizedScenarioDraft;
  candidate: Candidate;
  seed: number;
  variation: ScenarioVariation;
  spawnSegment?: RuntimeRoadSegment;
  stopPlan?: StopScenarioPlan | null;
  /** highway_exit / highway_entry: the placed gore/merge chain + speed split. */
  highwayRoute?: PlacedVariation["highwayRoute"];
  alpamayoCapture: boolean;
  trafficEnabled: boolean;
  trafficProfile: BatchTrafficProfile;
  /** "procedural" (default) keeps the geometric lane fill; "sumo" replaces that
   * fill with a warmed SUMO window. The near-field ring and the parked dressing
   * are unaffected either way. */
  trafficSource?: BatchTrafficSource;
  /** Required when trafficSource === "sumo"; ignored otherwise. */
  sumoAmbient?: SumoAmbientEmitInput;
  heavyTrafficTargetCount: number;
  /** Per-map ambient cap (dead-end-heavy maps like Munich): hard ceiling on the fill
   * count AFTER clampHeavyTrafficTargetCount's MIN=50 floor, so a capped map can go
   * below 50 (Munich yield RCA, dib 2026-07-20). Undefined = no cap (other maps). */
  ambientCap?: number;
  heavyVehiclesEnabled: boolean;
  bikesEnabled: boolean;
  parkedDensity: BatchParkedDensity;
  parkingLanes: ReadonlyArray<ParkingLaneRef>;
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  datasetId: string;
  /** Seeded daylight preset (drawBatchEnvironmentPreset); recorded on the
   * draft's renderConfig for the render path to pick up. */
  environmentPreset: BatchEnvironmentPreset;
}): NormalizedScenarioDraft {
  // For turns the spawn is upstream of the junction-approach candidate.
  const segment = input.spawnSegment ?? input.candidate.segment;
  // Cause-first stop: the subject drives an explicit forward route — a worker
  // route-follower with obstacle-aware, kinematic car-following — so it eases to a
  // smooth stop behind the lead AND avoids ambient traffic (which a raw chase_actor
  // pursuit does NOT). The route extends THROUGH drivable successor segments (not just
  // the spawn segment): a single-segment route ends at the segment boundary, so when
  // the lead sits near/past that boundary the subject hits reached_path_end and halts
  // ~18 m short of the kinematic stop gap (the bimodal-gap bug) — and at a junction it
  // has no through-lane runway, so it wanders onto parking/opposite lanes (the
  // wrong-side bug). buildForwardRouteThroughSuccessors only ever steps onto
  // isDrivableSegment lanes (Driving/Bidirectional, non-junction), in each segment's
  // TRUE travel direction, so the subject stays in-lane, reaches the lead's real gap, and
  // has runway to follow it away on resume.
  const causeFirstStop = input.stopPlan?.subjectStopMode === "tm_follow";
  // stop_line (stop_sign): no obstacle to follow — the subject is a route-follower carrying
  // `stop_at_stop_line: true`, and the WORKER eases it to a controlled stop at the nearest
  // stop line ahead on its route (autopilot off → no junction divergence). No timed stop.
  const stopLineMode = input.stopPlan?.subjectStopMode === "stop_line";
  const isTurnStrategy =
    input.candidate.strategy === "turn_left" || input.candidate.strategy === "turn_right";
  // lane_keep is a ROUTE-FOLLOWER (dib 2026-07-13): a deterministic
  // straightest-successor route through junctions IS correct lane keeping, and
  // it opens nearly the whole map (small streets included) as candidates —
  // under TM autopilot the subject could take any branch at a fork, which forced
  // the old straight-corridor-only placement gate.
  const isLaneKeep = isLaneKeepStrategy(input.candidate.strategy);
  // highway_exit / highway_entry: route-follower through the placed gore/merge
  // chain — the deterministic branch choice IS the scenario.
  const isHighwayRamp = Boolean(input.highwayRoute);
  // stop-junction families (stop at stop sign / yield / traffic light): a route-follower
  // that drives THROUGH the junction and stops at the control device there. In CARLA 0.10
  // the TM cannot obey stop/yield signs (no traffic.stop blueprint), so the subject must be a
  // worker route-follower carrying stop_at_stop_line (below) — the worker eases it to a
  // stop at the imported stop-line landmark, then resumes along its route. Traffic-light
  // stops are the worker's red-light hold on the same route. No conflict actor.
  const isStopJunction = isStopJunctionStrategy(input.candidate.strategy);
  // stop_at_uncontrolled: the subject route-follows THROUGH an intersection with no control
  // device, so there is no stop line to ease to — only the other three ease to a stop at
  // the imported control. All four are route-follower egos with no conflict actor.
  const isControlledStopJunction =
    isStopJunction && input.candidate.strategy !== "stop_at_uncontrolled";
  const subjectRouteMode = causeFirstStop || stopLineMode || isLaneKeep || isHighwayRamp || isStopJunction;
  // The maneuver the scene is ABOUT (ground truth for the metrics). Ramps have no
  // canonical maneuver in the v1 metric vocabulary — leave them unset so they score
  // observed-only (the gate fails open) rather than against a wrong expectation.
  const expectedManeuver: ScenarioEditorActorDraft["expected_maneuver"] =
    isLaneKeep || input.candidate.strategy === "stop_at_uncontrolled"
    ? "lane_keep"
    : input.candidate.strategy === "stop" || isControlledStopJunction
      ? "stop"
      : input.candidate.strategy === "turn_left"
        ? "turn_left"
        : input.candidate.strategy === "turn_right"
          ? "turn_right"
          : laneChangeSide(input.candidate.strategy) === "left"
            ? "lane_change_left"
            : laneChangeSide(input.candidate.strategy) === "right"
              ? "lane_change_right"
              : undefined;
  // Route length must cover the WHOLE render clip, else the subject follows its route to the
  // end and stops dead mid-road for the remainder (the "stops in the middle of the road
  // after resuming" review note). The fixed 75 m ran out ~9 s in; size it to the clip
  // (~22 s at cruise). buildForwardRouteThroughSuccessors only walks DRIVABLE successors
  // and stops when the road ends, and the survival-runway placement gate already requires
  // ≈SURVIVAL_HORIZON_S of road here — so this just USES the road that placement guaranteed,
  // with no new rejection (a spot with less road was already rejected upstream).
  const subjectForwardRunwayM = Math.max(
    SUBJECT_STOP_FORWARD_RUNWAY_M,
    (input.variation.speedKph / 3.6) * (SURVIVAL_HORIZON_S + 4),
  );
  const subjectRoute: ScenarioEditorRoadAnchor[] = input.highwayRoute
    ? buildRouteViaChain(
        input.segments,
        segment,
        input.variation.spawnFraction,
        input.highwayRoute.chain,
        input.highwayRoute.preSpeedKph,
        input.highwayRoute.postSpeedKph,
        input.highwayRoute.switchAtChainIndex,
        subjectForwardRunwayM,
      )
    : subjectRouteMode
      ? buildForwardRouteThroughSuccessors(
          input.segments,
          segment,
          input.variation.spawnFraction,
          input.variation.speedKph,
          subjectForwardRunwayM,
          // lane_keep follows the straightest routable successor at every hop —
          // the same walk routeFollowRunwayMeters gated on, so the emitted route
          // delivers the runway placement guaranteed. Stop egos keep the
          // original successor order (byte-identical streams).
          isLaneKeep,
        )
      : [];
  // The generator TRANSFORMS actor[0] into the subject — it historically relied on the
  // persisted draft arriving with a seeded starter subject. It no longer does: new
  // scenarios are now persisted with NO server-generated actors, because the EDITOR
  // bootstraps the starter subject client-side once it has loaded runtime geometry
  // (scenario-api-store.ts buildInitialScenarioDraft). The batch path is headless —
  // there is no editor — so the draft arrives empty, `.map()` over it yields nothing,
  // and every scene persisted with ZERO actors (the subject, and therefore all the
  // traffic/parked actors keyed off it). Seed our own base subject when none exists.
  const baseActors: ScenarioEditorActorDraft[] =
    input.draft.actors.length > 0
      ? input.draft.actors
      : [
          {
            id: `batch-subject-${input.seed}`,
            label: "Subject",
            kind: "vehicle",
            role: "subject",
            blueprint: SUBJECT_BLUEPRINT,
            color: SUBJECT_COLOR,
            spawn: {
              road_id: String(segment.road_id),
              section_id: segment.section_id ?? null,
              lane_id: segment.lane_id ?? null,
              s_fraction: input.variation.spawnFraction,
            },
          } as ScenarioEditorActorDraft,
        ];
  const nextActors = baseActors.map((actor, index): ScenarioEditorActorDraft => {
    if (index !== 0 && actor.role !== "subject") return actor;
    return {
      ...actor,
      role: "subject",
      placement_mode: "road",
      spawn: withWorldAnchor(
        {
          road_id: String(segment.road_id),
          section_id: segment.section_id ?? null,
          lane_id: segment.lane_id ?? null,
          s_fraction: input.variation.spawnFraction,
        },
        segment,
        input.variation.spawnFraction,
      ),
      route: subjectRoute,
      destination: null,
      // Ramp route-followers spawn at their pre-event speed (entry rolls the
      // ramp at ramp speed; exit approaches the gore at cruise).
      speed_kph: input.highwayRoute?.preSpeedKph ?? input.variation.speedKph,
      // stop_line egos ask the worker to ease to a stop at the nearest stop line ahead.
      // TURN egos also opt in (dib 2026-07-08: nominal turn egos blew through stop
      // signs): the worker scripts the stop-and-hold at stop-line landmarks these
      // maps import (TM can't obey them — no traffic.stop blueprint in 0.10). The
      // compiled turn plan has empty `instructions`, so the flag is the reliable
      // discriminator vs a COLLISION subject (which never carries it and must reach its
      // conflict).
      // lane_keep route-followers also stop at stop lines: driving through a
      // junction is now part of the corridor, and blowing a stop sign there
      // reads as wrong behavior in review (same rationale as turn egos).
      ...(stopLineMode || isTurnStrategy || isLaneKeep || isControlledStopJunction
        ? { stop_at_stop_line: true }
        : {}),
      // Declare the scenario's INTENT so the metrics never have to infer it.
      // Route-follower egos (lane_keep / cause-first stop) carry no timed
      // instructions, and the worker used to guess "stop" from the
      // stop_at_stop_line COMPLIANCE flag above — which scored every lane_keep
      // subject against a stop expectation (executed=false → the 2D gate rejected
      // 100% of them). Instruction-driven families set it too, so the expected
      // maneuver is always explicit and matches the compiled plan.
      ...(expectedManeuver ? { expected_maneuver: expectedManeuver } : {}),
      // Cause-first subject is a pure worker route-follower (kinematic car-following stops
      // it behind the lead, not the TM) — autopilot off so it never diverges onto a
      // TM-chosen route at a junction. A non-empty route already forces worker
      // movement; this makes the intent explicit and matches the lead follower.
      autopilot: !subjectRouteMode,
      timeline: [],
      // Route-follower stops (tm_follow = obstacle, stop_line = the worker's stop-line
      // stop) drive by ROUTE only — no timed instructions. Other strategies compile their
      // timed instructions as usual.
      timedInstructions: subjectRouteMode
        ? undefined
        : {
            schemaVersion: "simforge.timed-instructions.v1",
            intent: instructionsForStrategy(
              input.candidate.strategy,
              input.seed,
              input.variation,
              input.stopPlan,
            ),
            resolvedPlan: null,
            status: "draft",
            manifest: [],
          },
      sensors: input.alpamayoCapture
        ? sensorsFromPreset(PRESET_ALPAMAYO_PAI)
        : actor.sensors,
    };
  });
  const subject = nextActors[0];
  // Overtake lead: a slower vehicle in the SUBJECT's lane ahead — the CAUSE the subject
  // changes lanes to pass. Spawned regardless of the traffic toggles (it IS the
  // scenario's motivation, not ambience). May be null if the subject spawned too near
  // the lane end (then it degrades to a bare lane change).
  const overtakeLeadActors =
    subject && isOvertakeStrategy(input.candidate.strategy)
      ? buildOvertakeTrafficActors({
          subject,
          spawnSegment: segment,
          variation: input.variation,
          strategy: input.candidate.strategy,
          seed: input.seed,
          segments: input.segments,
        })
      : [];
  // Caused-stop lead (variants B/C): spawned regardless of the traffic
  // toggles — it IS the scenario's cause, not ambience.
  const stopLeadActors =
    subject && input.stopPlan?.lead
      ? [
          buildStopLeadActor({
            subject,
            lead: input.stopPlan.lead,
            variant: input.stopPlan.variant,
            strategy: input.candidate.strategy,
            seed: input.seed,
            segments: input.segments,
          }),
        ]
      : [];
  // Caused-stop VRU (variant V): a pedestrian crossing the subject's lane — the cause the
  // subject yields to. Spawned regardless of the traffic toggles (it IS the cause).
  const stopVruActors =
    subject && input.stopPlan?.vru
      ? [buildCrossingVruActor({ subject, vru: input.stopPlan.vru, seed: input.seed })]
      : [];
  // HEAVY: pace lead ahead of the subject at queue speed — built FIRST so the ring
  // and fill keep clear of it (and the subject's car-following embeds it in the jam).
  const jamLeadActors =
    input.trafficEnabled && input.trafficProfile === "heavy" && subject
      ? buildJamPaceLead({
          segments: input.segments,
          subject,
          spawnSegment: segment,
          variation: input.variation,
          seed: input.seed,
        })
      : [];
  const trafficActors =
    input.trafficEnabled && subject
      ? buildBatchTrafficActors({
          segments: input.segments,
          subject,
          candidate: input.candidate,
          variation: input.variation,
          spawnSegment: segment,
          seed: input.seed,
          datasetId: input.datasetId,
          trafficProfile: input.trafficProfile,
          // Keep ambient cars off the scripted cause (lead / crossing VRU / overtake
          // lead) — the flying-car spawn overlap (belmont-stop-021: a ring car 1.5m
          // from the lead).
          keepClear: [...stopLeadActors, ...stopVruActors, ...overtakeLeadActors, ...jamLeadActors],
        })
      : [];
  // The mid/far-field ambient population. Two sources produce it:
  //
  //   "procedural" — the geometric lane fill (existing behavior, the default).
  //   "sumo"       — vehicles lifted out of a warmed offline SUMO window and
  //                  baked in as timed_path/schedule actors.
  //
  // The NEAR-FIELD RING above is deliberately untouched by this choice: the
  // cars closest to the subject keep CARLA-native Traffic-Manager reaction, which a
  // baked SUMO schedule cannot provide (it is open loop with respect to the
  // subject). That hybrid is the whole design — SUMO supplies demand realism where
  // open loop is harmless, TM supplies reactivity where it is not.
  const useSumoAmbient =
    input.trafficEnabled &&
    input.trafficSource === "sumo" &&
    input.sumoAmbient != null &&
    subject != null;

  // Keep SUMO traffic off every scripted actor's spawn AND off the ring, so a
  // scheduled car never materialises inside the cause actor (the flying-car
  // spawn-overlap class).
  const sumoKeepClear = useSumoAmbient
    ? [
        subject,
        ...stopLeadActors,
        ...stopVruActors,
        ...overtakeLeadActors,
        ...jamLeadActors,
        ...trafficActors,
      ]
        .map(actorSpawnPoint)
        .filter((p): p is { x: number; y: number } => p != null)
    : [];

  const sumoAmbientActors = useSumoAmbient
    ? (() => {
        const cfg = input.sumoAmbient!;
        const subjectPoint = actorSpawnPoint(subject!);
        // Cheap planned-subject corridor for the emit-time safety check: the subject
        // runs its spawn-lane centerline at cruise speed after its instruction
        // delay. An approximation (a lane change adds ~3.5 m of lateral travel
        // this line does not model) — the 2D gate remains the backstop; this
        // catches the head-on class for milliseconds of work.
        const subjectCorridor = subjectPoint
          ? plannedEgoCorridor(
              subjectPoint,
              segment,
              input.variation,
              cfg.clipDurationS,
            )
          : [];
        const result = buildSumoAmbientActors(cfg.trajectory, {
          ...(cfg.options ?? {}),
          clipDurationS: cfg.clipDurationS,
          keepClearPoints: sumoKeepClear,
          // Spend the actor budget on the traffic NEAREST the subject — those are
          // the vehicles that end up on camera.
          ...(subjectPoint ? { priorityPoint: subjectPoint } : {}),
          referenceLanes: cfg.referenceLanes,
          netBounds: cfg.netBounds,
          ...(cfg.netBoundaryPoints ? { netBoundaryPoints: cfg.netBoundaryPoints } : {}),
          ...(subjectCorridor.length > 1 ? { subjectCorridor } : {}),
        });
        cfg.onReport?.({ ...result, movieId: cfg.movieId, windowT0S: cfg.windowT0S });
        return result.actors;
      })()
    : [];

  // TRAFFIC CONTROL. The ambient's obedience is baked into its trajectory (the
  // reel ran on a net carrying the map's lights AND its stop signs). This is
  // the other half: drive CARLA's heads on the same cycle, entered where SUMO
  // was when the window opened, so the render agrees with the queues in the
  // schedule. Junctions the artifact could not bind are left on map_default.
  const sumoSignalPlans =
    useSumoAmbient && input.sumoAmbient?.signalProgram
      ? signalPlansForWindow(input.sumoAmbient.signalProgram, input.sumoAmbient.windowT0S)
      : [];

  // "heavy" (jam) or "medium" (flowing) bake a lane fill on top of the ring;
  // "normal" takes the empty-array path and stays byte-identical. Skipped
  // entirely when SUMO owns the fill.
  const heavyFillActors =
    !useSumoAmbient &&
    input.trafficEnabled &&
    (input.trafficProfile === "heavy" || input.trafficProfile === "medium") &&
    subject
      ? buildHeavyTrafficFillActors({
          segments: input.segments,
          subject,
          candidate: input.candidate,
          variation: input.variation,
          spawnSegment: segment,
          seed: input.seed,
          datasetId: input.datasetId,
          targetTotalVehicles: input.heavyTrafficTargetCount,
          ambientCap: input.ambientCap,
          existingTraffic: [
            ...stopLeadActors,
            ...stopVruActors,
            ...overtakeLeadActors,
            ...jamLeadActors,
            ...trafficActors,
          ],
          flowing: input.trafficProfile === "medium",
          heavyVehicles: input.heavyVehiclesEnabled,
          bikes: input.bikesEnabled,
        })
      : [];
  // Street parking: static curb cars, independent of the traffic toggles
  // (parked cars are scene dressing, not flowing traffic). Deduped against
  // every dynamic actor placed above.
  const parkedActors =
    input.parkedDensity !== "none" && subject
      ? buildParkedActors({
          subject,
          spawnSegment: segment,
          variation: input.variation,
          density: input.parkedDensity,
          parkingLanes: input.parkingLanes,
          seed: input.seed,
          datasetId: input.datasetId,
          // Dedup curb-parked cars against every dynamic vehicle already placed
          // (ring + heavy fill + scripted cause) so a parked car never lands on
          // a moving fill car (the Yale flying-car overlap).
          avoidVehicles: [
            ...stopLeadActors,
            ...stopVruActors,
            ...overtakeLeadActors,
            ...trafficActors,
            ...heavyFillActors,
            // Curb parking is OUR placement code, not SUMO's — but it still has
            // to dedup against the SUMO population, or a parked car lands on a
            // scheduled vehicle's spawn.
            ...sumoAmbientActors,
          ],
        })
      : [];
  const generatedActors = finalizeGeneratedActorBehaviors([
    ...nextActors,
    ...overtakeLeadActors,
    ...stopLeadActors,
    ...stopVruActors,
    ...jamLeadActors,
    ...trafficActors,
    ...heavyFillActors,
    ...sumoAmbientActors,
    ...parkedActors,
  ]);
  const stamped = stampNominalGeneratedOutput({
    generator: "simforge.batch_normal_driving.v1",
    seed: input.seed,
    strategy: input.candidate.strategy,
    actors: generatedActors,
    stopVariant: input.stopPlan?.variant,
    traffic: input.trafficProfile,
    parked: input.parkedDensity,
    weather: `${input.environmentPreset.weather} ${input.environmentPreset.roadSurface}`,
    environmentPreset: input.environmentPreset,
    heavyVehicles: input.heavyVehiclesEnabled,
  });
  return {
    ...input.draft,
    // AUTOMATED PATH: author our own semantic binding for any actor the worker will
    // compile a timed-instruction plan for (turns / lane changes). Without it the
    // worker rejects the plan outright (invalid_timed_instruction_runtime_plan) —
    // the editor gets this binding from a human clicking a corridor; we derive it
    // from the road anchor we already chose. Route-followers are left untouched
    // (no plan to validate, and the binding patch would clobber their route).
    metadata: {
      ...input.draft.metadata,
      scenarioIntention: stamped.scenarioIntention,
      scenarioMetadata: stamped.scenarioMetadata,
      // Rule 3: pin the actor-randomness authority to the generation seed so a
      // later single-actor edit does not re-roll the semantic_default TM seed
      // (which hashes the whole actors array) for every ambient actor.
      actorRandomnessSeed: input.seed,
    },
    actors: stamped.actors,
    // Authored junctions ride at DRAFT level, not on any actor: a junction
    // belongs to the scene. `signalPlans` is the NORMALIZED draft's spelling —
    // draft-normalization renames it to the spec's `signal_plans` at payload
    // build. An empty list would be a no-op, so the draft's own plans (normally
    // absent) survive when SUMO contributes none.
    ...(sumoSignalPlans.length > 0 ? { signalPlans: sumoSignalPlans } : {}),
    selectedActorId: nextActors[0]?.id ?? input.draft.selectedActorId,
    // Seeded per-scenario daylight weather, carried on the draft's render
    // config (the submit-batch route hoists it into the render job's
    // environment_preset).
    renderConfig: {
      ...(input.draft.renderConfig ?? {
        renderOutputProfile: "playback" as const,
        outputSpec: {
          version: 1 as const,
          profile: "playback" as const,
          modalities: [],
          annotations: [],
          metadata: [],
          encodings: [],
        },
      }),
      environmentPreset: input.environmentPreset,
    },
    // Traffic is emitted as explicit, placement-aware actors above; keep the
    // legacy subject-lane cloning OFF so submit-batch doesn't double-spawn
    // blockading lead vehicles.
    carLedTrafficEnabled: false,
  };
}
