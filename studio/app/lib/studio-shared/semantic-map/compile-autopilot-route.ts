/**
 * Compile an ambient/autopilot actor down to an explicit route.
 *
 * Traffic Manager is reproducible only for one CARLA build and map revision,
 * while an explicit route exports to OpenSCENARIO and is identical in preview
 * and CARLA. The semantic lane graph is therefore the authority.
 *
 * This function used to contain a second graph walker beside `deriveRunway`.
 * They chose junctions with different PRNGs, handled forks differently, and
 * repeatedly acquired fixes independently. On the nine-map 2026-07-31 corpus,
 * the same start, seed, and 500 m budget disagreed on 2249 of 3469 routes
 * (64.83%). Delegating to the one authored-motion walker makes route choice a
 * single contract; conformance no longer depends on keeping copied loops in
 * sync by hand.
 */

import { deriveRunway } from "./derive-runway";
import type { SemanticMapGraph } from "./types";
import type { TurnRelation } from "@simforge-oss/maps/topology";

/** A route anchor: a world position the runtime steers through. */
export type CompiledRouteAnchor = {
  x: number;
  y: number;
  z: number;
  /** Degrees, runtime/frontend frame — the heading of travel AT this anchor. */
  yaw: number;
  /** The lane's posted limit, reported as map data and never commanded. */
  speed_limit_kph: number | null;
  /** Runtime lane (`road:section:lane`), null inside junctions. */
  rsl: string | null;
  /** Fraction along the runtime lane's road `+s` axis. Null with `rsl`. */
  s_fraction: number | null;
};

/** One explainable leg of the compiled route. */
export type CompiledRouteLeg = {
  kind: "corridor" | "junction";
  id: string;
  lengthM: number;
  /** Only for junction legs: which way the car went. */
  turn?: TurnRelation;
};

export type CompiledRouteTermination = "budget" | "dead_end" | "cycle_guard";

export type CompiledRoute = {
  anchors: CompiledRouteAnchor[];
  legs: CompiledRouteLeg[];
  travelledM: number;
  terminated: CompiledRouteTermination;
};

export type CompileAutopilotRouteArgs = {
  graph: SemanticMapGraph;
  /** Where the actor sits, in world metres. The authority — never a road id. */
  start: { x: number; y: number };
  /** Optional facing used to disambiguate overlapping/opposed corridors. */
  startHeadingDeg?: number;
  /** Distance to cover before simplification, in metres. */
  travelBudgetM: number;
  /** Stable per-actor string used for deterministic junction choices. */
  seed: string;
  /** `FollowRouteActionSchema` caps production routes at 32 anchors. */
  anchorCap?: number;
  /** Maximum simplification deviation. Negative disables simplification for QA. */
  toleranceM?: number;
};

/**
 * Compile the same weighted, seeded graph walk the editor derives.
 *
 * `startHeadingDeg` remains optional because the legacy compile endpoint does
 * not receive actor heading. Callers that do know it can now disambiguate
 * overlapping/opposed corridors the same way as `deriveRunway`.
 */
export function compileAutopilotRoute(
  args: CompileAutopilotRouteArgs,
): CompiledRoute {
  const runway = deriveRunway({
    graph: args.graph,
    start: args.start,
    ...(args.startHeadingDeg === undefined
      ? {}
      : { startHeadingDeg: args.startHeadingDeg }),
    travelBudgetM: args.travelBudgetM,
    pick: { kind: "weighted", seed: args.seed },
    ...(args.anchorCap === undefined ? {} : { anchorCap: args.anchorCap }),
    ...(args.toleranceM === undefined ? {} : { toleranceM: args.toleranceM }),
  });
  return {
    anchors: runway.anchors,
    legs: runway.legs,
    travelledM: runway.travelledM,
    terminated: runway.terminated,
  };
}
