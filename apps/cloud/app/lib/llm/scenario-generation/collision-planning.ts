import {
  SIMULATION_DEFAULTS,
  TARGET_COLLISION_TIME_S,
  type CollisionFamilyId,
} from "@simcloud/shared";
import type { GeometryReport } from "@/app/lib/maps/search/server/inspect-location-geometry";
import {
  loadCollisionLaneGraph,
  planCollisionRoutesWithGraph,
  type PlanCollisionRoutesResult,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import { validateCollisionDraft } from "@/app/lib/llm/scenario-generation/validation/draft-validator";
import {
  planRearEndTopology,
  planRightTurnHookGated,
  planUnprotectedLeftTurnGated,
  topologyJunctionCentroid,
} from "@/app/lib/llm/scenario-generation/planner/gated-collision-planner";
import {
  planPedestrianCrossingForSite,
  pickFirstValidatingSite,
  type PedTopoResult,
} from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-topology-planner";
import { selectPedestrianCrossingSite } from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-site-selector";
import { loadProjectedPedestrianRegions } from "@/app/lib/llm/scenario-generation/load-pedestrian-regions";
import { getMapTopologyIndex } from "@/app/lib/maps/topology/server/topology-index-service";
import { plannedCollisionToDraftActors } from "@/app/lib/llm/scenario-generation/validation/planned-to-draft";
import { readSemanticRoadSegmentsByMapAssetId } from "@/app/lib/maps/topology/server/semantic-road-network";
import {
  snapDraftActorsToRuntimeRoads,
  type RuntimeRoadSegment,
} from "@/app/lib/llm/scenario-generation/runtime-road-snap";

/** Cap on the number of proximity-ranked pedestrian-crossing sites the builder
 *  probes in the topological-reachability re-pick loop. Each probed site costs
 *  exactly one snap + one kinematic validate, so this bounds the per-eval cost
 *  to ≤ MAX_PED_SITE_ATTEMPTS validations for the ped path. */
const MAX_PED_SITE_ATTEMPTS = 6;

type CollisionTemplateForPlanning = {
  durationSeconds: number;
  collisionTimeWindow?: { min: number; max: number; ideal: number } | null;
};

export interface CollisionPlanningResult {
  intendedLocation: { x: number; y: number } | null;
  validationFixedDeltaS: number;
  plannerResult: PlanCollisionRoutesResult | null;
  plannerError: string | null;
  pedTopo: PedTopoResult | null;
  repairStrategies: string[];
  repairAttempts: number;
  repairSucceeded: boolean;
  acceptWin: { min: number; max: number } | undefined;
  runtimeRoadSegments: RuntimeRoadSegment[];
  pedRepick: { sitesTried: number; sitesPassed: number } | null;
}

export async function planCollisionScenarioDraft(input: {
  family: CollisionFamilyId;
  mapAssetId: string;
  backendMapName: string;
  geometry: GeometryReport;
  approachGeometries: readonly GeometryReport[];
  template: CollisionTemplateForPlanning;
  subjectSpeedKph: number;
  npcSpeedKph: number;
  npcVehicleType: "car" | "bicycle" | "motorcycle" | null;
}): Promise<CollisionPlanningResult> {
  // ── Tier-1 deterministic auto-repair ──────────────────────────────────
  //
  // Re-plan over a small NPC/subject speed grid and keep the first plan our
  // in-process kinematic simulator confirms produces the requested
  // collision near the location. The lane graph is loaded ONCE (S3) and
  // every attempt is a sync re-plan + in-memory replay — no extra DB rows,
  // no LLM round trip. The baseline plan is retained as the fallback to
  // assemble even if no tune passes (a populated, if imperfect, draft is
  // more useful — and more diagnosable — than none).
  // intendedLocation seeds from the geojson document the user clicked
  // on, but gets replaced by the XODR junction centroid the moment the
  // Tier-0 gated planner resolves one — that's the authoritative
  // location of the scenario in XODR-space, and the validator's
  // region/spawn-offset checks belong there, not against the geojson
  // anchor (which can differ by tens of metres on big junctions).
  let intendedLocation = input.geometry.documentCenter
    ? { x: input.geometry.documentCenter.x, y: input.geometry.documentCenter.y }
    : null;
  const validationFixedDeltaS = SIMULATION_DEFAULTS.fixedDeltaSeconds;
  const SPEED_TUNE_GRID: ReadonlyArray<{ npc: number; subject: number; label: string }> = [
    { npc: 1, subject: 1, label: "baseline" },
    { npc: 1.25, subject: 1, label: "npc speed +25%" },
    { npc: 0.8, subject: 1, label: "npc speed -20%" },
    { npc: 1.5, subject: 1, label: "npc speed +50%" },
    { npc: 1.25, subject: 0.85, label: "npc +25% / subject -15%" },
  ];

  let plannerResult: PlanCollisionRoutesResult | null = null;
  let plannerError: string | null = null;
  // Set when the deterministic pedestrian-crossing topology planner produced
  // the plan. Carries the planner's own trace so the authoritative-validation
  // pass below can stamp the verdict onto a `PlannerTrace`. When set, the
  // legacy SPEED_TUNE_GRID is skipped (the topology plan IS the plan, same as
  // the Tier-0 gated solvers for turn families).
  let pedTopo: PedTopoResult | null = null;
  const repairStrategies: string[] = [];
  let repairAttempts = 0;
  let repairSucceeded = false;

  const laneGraph = await loadCollisionLaneGraph(input.geometry).catch((err) => {
    plannerError = err instanceof Error ? err.message : String(err);
    return null;
  });

  // ── Tier-0: gate-driven planning (deterministic, topology-based) ──────
  //
  // For turn families (unprotected_left_turn, right_turn_hook), select
  // subject + conflicting lanes from the XODR MapTopologyIndex gates (the
  // turn affordances CARLA actually drives) instead of the legacy
  // yaw-heuristic successor picker. On a validated
  // pass this IS the plan and the speed-tune grid is skipped; otherwise
  // we fall through to the legacy grid unchanged (graceful degradation
  // for un-backfilled maps / locations with no resolvable Left gate).
  let gateDriven = false;
  const gatedSolver =
    input.family === "unprotected_left_turn"
      ? planUnprotectedLeftTurnGated
      : input.family === "right_turn_hook"
        ? planRightTurnHookGated
        : input.family === "rear_end"
          ? planRearEndTopology
          : null;
  // Note: Tier-0 no longer needs the runtime lane-graph — it sources
  // gate geometry from `topology.lanes[rsl].polyline` directly and walks
  // `topology.lanes[rsl].predecessors` for run-up. The lane-graph remains
  // a prerequisite for the legacy SPEED_TUNE_GRID below.
  if (gatedSolver && input.geometry.documentCenter) {
    repairAttempts += 1;
    try {
      const topology = await getMapTopologyIndex(input.mapAssetId, "carla_ue5");
      const gated = gatedSolver({
        topology,
        documentCenter: {
          x: input.geometry.documentCenter.x,
          y: input.geometry.documentCenter.y,
        },
        subjectSpeedKph: input.subjectSpeedKph,
        npcSpeedKph: input.npcSpeedKph,
        // Uniform planned time-of-impact (~10s into the ~20s scenario).
        arrivalTimeS: TARGET_COLLISION_TIME_S,
      });
      if (gated) {
        const candidate: PlanCollisionRoutesResult = {
          collision: gated,
          walker: null,
        };
        // Re-anchor intendedLocation to the XODR junction centroid
        // (the authoritative scenario location) the moment Tier-0
        // resolved one. Validator's region/spawn-offset checks now
        // measure against the XODR-side ground truth — fixing the
        // "57 m off-region" failure on junctions whose geojson
        // anchor differs from the XODR centroid by more than the
        // validator tolerance.
        if (gated.subjectGate?.junctionId) {
          const c = topologyJunctionCentroid(topology, gated.subjectGate.junctionId);
          if (c) intendedLocation = c.center;
        }
        const probe = validateCollisionDraft({
          family: input.family,
          actors: plannedCollisionToDraftActors(candidate),
          intendedLocation,
          conflict: {
            conflictPoint: gated.conflictPoint,
            arrivalTimeS: gated.arrivalTimeS,
            // Tier-0 plans carry the authoritative gate identity;
            // the validator's maneuver_executed consults this
            // instead of inferring turn from waypoint headings.
            subjectTurnRelation: gated.subjectGate?.turnRelation ?? null,
            // The gated solvers (left/right/rear_end) are vehicle-NPC
            // families; none defines a `collisionTimeWindow`, so this is
            // a no-op for them. Pedestrian_crossing never reaches this
            // dispatch (it has its own topology block above).
          },
          durationS: input.template.durationSeconds,
          fixedDeltaS: validationFixedDeltaS,
        });
        if (probe.verdict === "pass") {
          plannerResult = candidate;
          plannerError = null;
          gateDriven = true;
          repairStrategies.push(`gate-driven ${input.family} (topology)`);
        } else if (!plannerResult) {
          // Keep as a populated fallback even if imperfect; the legacy
          // grid below still gets a chance to find a passing plan.
          plannerResult = candidate;
        }
      }
    } catch (err) {
      // Topology unavailable (un-backfilled map / no xodr) — not fatal;
      // legacy grid handles it.
      plannerError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Tier-0: deterministic pedestrian-crossing topology planner ────────
  //
  // `pedestrian_crossing` is not a `gatedSolver` family (the conflicting
  // principal is a walker, not a vehicle), so it has its own topology path.
  // Back-walk the subject STRAIGHT through a junction-approach gate by
  // `subjectSpeed × idealTimeS` and synthesise a perpendicular walker whose
  // curb-hold is solved to meet the subject at the conflict point. On a
  // non-null return this IS the plan: we set `plannerResult` so the
  // existing planner-emit branch assembles the walker draft from the
  // `PlannedWalker`, and skip the legacy SPEED_TUNE_GRID. On null we leave
  // `plannerResult` untouched and fall through to the heuristic ped path
  // below (no regression vs today).
  // Single source of the ped accept-window object reused at the probe,
  // legacy-grid fallback, and authoritative validation below.
  const win = input.template.collisionTimeWindow ?? null;
  const acceptWin: { min: number; max: number } | undefined = win
    ? { min: win.min, max: win.max }
    : undefined;

  // Read the accepted semantic execution road network ONCE. The pedestrian-crossing re-pick
  // probe (below) snaps each candidate site onto these segments before its
  // kinematic probe, and the authoritative snap further down reuses the same
  // segments, without composing a central runtime bundle.
  const runtimeRoadSegments =
    (await readSemanticRoadSegmentsByMapAssetId(input.mapAssetId)) ?? [];

  // Tracks the re-pick search outcome so the planner trace can record how many
  // ranked sites were probed before one was topologically reachable.
  let pedRepick: { sitesTried: number; sitesPassed: number } | null = null;

  if (input.family === "pedestrian_crossing" && input.geometry.documentCenter) {
    const idealTimeS = win?.ideal ?? TARGET_COLLISION_TIME_S;
    // Room guard requires only the window MINIMUM run-up (default to idealTimeS
    // for any non-windowed caller → no behavior change). The planner then
    // floats the subject's arrival time in [minTimeS, idealTimeS] at full speed.
    const minTimeS = win?.min ?? idealTimeS;
    repairAttempts += 1;
    try {
      const topology = await getMapTopologyIndex(input.mapAssetId, "carla_ue5");
      // Real pedestrian-spawn geometry (crosswalks + road-network sidewalks +
      // pedestrian-origin POIs), projected into runtime metres. Feeds the
      // crossing-line resolver so the walker spawns on a real curb. A
      // candidate/projection miss yields empty regions and the resolver falls
      // back to the legacy fixed-width crossing — no hard failure.
      const pedRegions = await loadProjectedPedestrianRegions(
        input.mapAssetId,
      ).catch(() => ({ crosswalks: [], sidewalks: [], poiPoints: [] }));
      const anchor = {
        x: input.geometry.documentCenter.x,
        y: input.geometry.documentCenter.y,
      };

      // Topological-reachability gate. The selector returns the proximity-
      // ranked viable sites (nearest-to-anchor first). We try them in order
      // and accept the FIRST site whose snapped draft passes a kinematic
      // probe (subject makes contact with the walker inside the accept window).
      // A site the subject can't actually reach fails the probe → we skip it and
      // try the next-nearest. Reachability thus takes precedence over upstream
      // room / run-up timing / anchor proximity: we never adopt a placement
      // the subject can't reach. If NONE of the top N pass, `pedTopo` stays null
      // and the heuristic ped fallback below runs unchanged (no hard failure).
      const selected = selectPedestrianCrossingSite({
        topology,
        anchor,
        subjectSpeedKph: input.subjectSpeedKph,
        minTimeS,
      });
      const rankedSites = (selected?.sites ?? []).slice(
        0,
        MAX_PED_SITE_ATTEMPTS,
      );

      // Probe a single site: assemble its ped draft, snap onto the runtime
      // roads, and run the kinematic validator. Exactly one validate per
      // attempted site (NO Tier-1 speed-tune grid here). Confined to the ped
      // path. A snap that throws `location_off_runtime_road` means this site is
      // unreachable on the runtime network → treat as a probe FAIL (skip it).
      const probeSite = (
        plan: PedTopoResult,
      ): { verdict: "pass" | "fail" } => {
        // Re-anchor intendedLocation to the candidate's XODR junction centroid
        // so the validator's region/spawn-offset checks measure against XODR
        // ground truth (matching the gated-turn families). This mirrors the
        // accepted-site re-anchor below; on a fail the value is harmless (the
        // next site overwrites it, or the heuristic path recomputes nothing
        // from it).
        let probeIntendedLocation = intendedLocation;
        if (plan.collision.subjectGate?.junctionId) {
          const c = topologyJunctionCentroid(
            topology,
            plan.collision.subjectGate.junctionId,
          );
          if (c) probeIntendedLocation = c.center;
        }
        const probeActors = plannedCollisionToDraftActors({
          collision: plan.collision,
          walker: plan.walker,
        });
        try {
          snapDraftActorsToRuntimeRoads(probeActors, runtimeRoadSegments);
        } catch {
          // Implausibly far from any runtime lane → unreachable site.
          return { verdict: "fail" };
        }
        const probe = validateCollisionDraft({
          family: input.family,
          actors: probeActors,
          intendedLocation: probeIntendedLocation,
          conflict: {
            conflictPoint: plan.collision.conflictPoint,
            arrivalTimeS: plan.collision.arrivalTimeS,
            subjectTurnRelation: "Straight",
            acceptWindowS: acceptWin,
          },
          durationS: input.template.durationSeconds,
          fixedDeltaS: validationFixedDeltaS,
        });
        return { verdict: probe.verdict === "pass" ? "pass" : "fail" };
      };

      const picked = pickFirstValidatingSite<PedTopoResult>(
        rankedSites,
        (site) =>
          planPedestrianCrossingForSite(site, {
            topology,
            subjectSpeedKph: input.subjectSpeedKph,
            idealTimeS,
            minTimeS,
            siteTrace: selected?.trace,
            crosswalks: pedRegions.crosswalks,
            sidewalks: pedRegions.sidewalks,
            poiPoints: pedRegions.poiPoints,
          }),
        probeSite,
      );

      if (picked) {
        pedTopo = picked.plan;
        pedRepick = { sitesTried: picked.sitesTried, sitesPassed: 1 };
        // Re-anchor intendedLocation to the ACCEPTED site's XODR junction
        // centroid so the authoritative region/spawn-offset checks match.
        if (pedTopo.collision.subjectGate?.junctionId) {
          const c = topologyJunctionCentroid(
            topology,
            pedTopo.collision.subjectGate.junctionId,
          );
          if (c) intendedLocation = c.center;
        }
        plannerResult = {
          collision: pedTopo.collision,
          walker: pedTopo.walker,
        };
        plannerError = null;
        gateDriven = true;
        repairStrategies.push(
          `topology pedestrian_crossing (site ${picked.sitesTried}/${rankedSites.length} reachable)`,
        );
      }
      // No site in the top N validated → leave plannerResult null / gateDriven
      // false → the heuristic ped fallback below runs unchanged.
    } catch (err) {
      // Topology unavailable (un-backfilled map / no xodr) — not fatal;
      // fall through to the heuristic ped path below.
      plannerError = err instanceof Error ? err.message : String(err);
    }
  }

  if (laneGraph && !gateDriven) {
    for (const tune of SPEED_TUNE_GRID) {
      repairAttempts += 1;
      let candidate: PlanCollisionRoutesResult | null = null;
      try {
        candidate = planCollisionRoutesWithGraph(laneGraph, {
          family: input.family,
          geometry: input.geometry,
          approachGeometries: input.approachGeometries,
          subjectSpeedKph: input.subjectSpeedKph * tune.subject,
          npcSpeedKph: input.npcSpeedKph * tune.npc,
          durationS: input.template.durationSeconds,
          npcVehicleType: input.npcVehicleType,
        });
      } catch (err) {
        plannerError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!candidate) {
        plannerError = plannerError ?? "planner returned null (no feasible route)";
        continue;
      }
      if (!plannerResult) plannerResult = candidate; // baseline fallback
      const probe = validateCollisionDraft({
        family: input.family,
        actors: plannedCollisionToDraftActors(candidate),
        intendedLocation,
        conflict: {
          conflictPoint: candidate.collision.conflictPoint,
          arrivalTimeS: candidate.collision.arrivalTimeS,
          subjectTurnRelation: candidate.collision.subjectGate?.turnRelation ?? null,
          // Apply the ped accept window when the legacy grid is the ped
          // fallback (topology planner returned null). Undefined for every
          // other family (none defines a `collisionTimeWindow`).
          acceptWindowS:
            input.family === "pedestrian_crossing" ? acceptWin : undefined,
        },
        durationS: input.template.durationSeconds,
        fixedDeltaS: validationFixedDeltaS,
      });
      if (tune.label !== "baseline") repairStrategies.push(tune.label);
      if (probe.verdict === "pass") {
        plannerResult = candidate;
        plannerError = null;
        repairSucceeded = tune.label !== "baseline";
        break;
      }
    }
  } else if (!laneGraph && !plannerError) {
    plannerError = "lane graph unavailable (no resolvable center / segments)";
  }

  return {
    intendedLocation,
    validationFixedDeltaS,
    plannerResult,
    plannerError,
    pedTopo,
    repairStrategies,
    repairAttempts,
    repairSucceeded,
    acceptWin,
    runtimeRoadSegments: [...runtimeRoadSegments],
    pedRepick,
  };
}
