import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  RuntimeTopologyFamilySchema,
  ScenarioEditorActorDraftSchema,
  corridorStationAnchor,
  deriveRunway,
  resolveActorMotion,
  resolveTurnIntents,
  runwayBudgetM,
} from "@simcloud/shared";
import type { SemanticMapGraph } from "@simcloud/shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getSemanticMapGraph,
  SemanticGraphBundleChangedError,
} from "@/app/lib/maps/topology/server/semantic-map-service";
import { TopologyUnavailableError } from "@/app/lib/maps/topology/server/topology-index-service";

/**
 * The route a placed car will actually drive, derived from the lane graph.
 *
 * The editor has to be able to DRAW this. "Place it and it drives" is only
 * honest if the author can see where — an invisible derivation is a promise, and
 * the anchors it replaces were at least visible. So the runway is a server
 * derivation the map renders as the faint continuation of the lane, never
 * something clicked (`plans/2026-07-29-one-motion-model.md` §2.6).
 *
 * Server-side because the derivation needs the whole semantic graph: 4 MB for San
 * Ramon, already compiled and cached per bundle revision here, and shipping it to
 * the browser to walk it there would be the same walk over a much slower wire.
 *
 * Takes the ACTOR rather than a placement so the answer accounts for the
 * timeline: `resolveTurnIntents` reads the `turn` clips that override the
 * straightest-successor pick, and `resolveActorMotion` decides whether this actor
 * has a derived runway at all (a walker or a parked prop does not).
 */
type RouteContext = { params: Promise<{ mapAssetId: string }> };

const RequestSchema = z
  .object({
    runtime: RuntimeTopologyFamilySchema,
    actor: ScenarioEditorActorDraftSchema,
    /**
     * Scenario duration, which with the baseline speed sets how far to walk.
     * Optional: a 30 s default matches the editor's own default scenario length,
     * and `runwayBudgetM` floors the answer at 50 m regardless.
     */
    durationSeconds: z.number().positive().max(600).optional(),
  })
  .strict();

/**
 * The world pose a lane anchor names, read off the semantic graph.
 *
 * The same walk `semantic-actor-binding` does for its `corridor_station` intent:
 * find the authorable corridor carrying this lane fragment, convert the road `+s`
 * fraction to a travel fraction (the lane-sign convention, which is what the
 * fragment arc ranges are ordered by), and take the point there. Ambiguity —
 * more than one corridor over the same lane — resolves to the first by id, which
 * is deterministic and good enough for a drawing; the runway itself is
 * re-derived from the point, so a wrong pick shows up as a runway in the wrong
 * lane rather than as silently wrong geometry.
 */
function anchorFromGraph(
  graph: SemanticMapGraph,
  actor: { spawn?: { road_id?: string | null; section_id?: number | null; lane_id?: number | null; s_fraction?: number | null } },
): { x: number; y: number; yawDeg: number | null } | null {
  const roadId = actor.spawn?.road_id?.trim();
  const sectionId = actor.spawn?.section_id;
  const laneId = actor.spawn?.lane_id;
  if (!roadId || !Number.isInteger(sectionId) || !Number.isInteger(laneId)) return null;
  const rsl = `${roadId}:${sectionId}:${laneId}`;
  const sFraction = Math.min(1, Math.max(0, actor.spawn?.s_fraction ?? 0.5));
  const travelFraction = laneId! < 0 ? sFraction : 1 - sFraction;
  for (const corridor of [...graph.corridors].sort((left, right) => left.id.localeCompare(right.id))) {
    if (corridor.authoringStatus !== "authorable") continue;
    const fragment = corridor.runtimeFragments.find((row) => row.rsl === rsl);
    if (!fragment) continue;
    const stationM =
      fragment.startArcM + (fragment.endArcM - fragment.startArcM) * travelFraction;
    const anchor = corridorStationAnchor(corridor, stationM);
    if (anchor) return { x: anchor.point.x, y: anchor.point.y, yawDeg: anchor.yaw };
  }
  return null;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid derived runway request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { mapAssetId } = await context.params;
  const mapAsset = await getMapAssetByIdFromDb(mapAssetId);
  if (!mapAsset) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }

  const motion = resolveActorMotion(parsed.data.actor);
  // Not an error: a walker, a parked prop, or a vehicle still carrying its own
  // polyline has geometry of its own to draw. Saying so plainly beats returning
  // an empty polyline the caller would render as "nowhere".
  if (!motion.runwayIsDerived || motion.placement?.kind !== "lane") {
    return NextResponse.json({
      derived: false,
      reason:
        motion.baseline.kind === "parked"
          ? "parked"
          : motion.corridor
            ? "actor_carries_geometry"
            : "no_lane_placement",
    });
  }
  let graph;
  try {
    graph = await getSemanticMapGraph({ mapAssetId, runtime: parsed.data.runtime });
  } catch (error) {
    if (error instanceof TopologyUnavailableError) {
      return NextResponse.json(
        {
          error: "The runtime-verified semantic graph is unavailable for this map.",
          code: error.code,
        },
        { status: 422 },
      );
    }
    if (error instanceof SemanticGraphBundleChangedError) {
      return NextResponse.json(
        { error: error.message, code: "semantic_graph_bundle_changed" },
        { status: 503 },
      );
    }
    console.error("derived-runway route error:", error);
    return NextResponse.json(
      { error: "Failed to load the semantic map graph." },
      { status: 500 },
    );
  }

  // A lane anchor IS the placement, and in the target model it is the ONLY one a
  // vehicle has — `spawn_point` is a cache the editor happens to keep. So when
  // the draft carries no world point, resolve it from the graph the same way
  // `semantic-actor-binding` does: rsl + s fraction -> corridor station -> point.
  // Requiring the cached point instead would fail on exactly the semantic
  // placements this whole model is built on.
  const fromGraph = motion.placement.point ? null : anchorFromGraph(graph, parsed.data.actor);
  const start = motion.placement.point ?? fromGraph;
  if (!start) {
    return NextResponse.json({ derived: false, reason: "no_lane_placement" });
  }
  const startHeadingDeg =
    motion.placement.yawDeg ?? fromGraph?.yawDeg ?? undefined;

  const speedKph = motion.baseline.kind === "drive" ? motion.baseline.speedKph : 0;
  const runway = deriveRunway({
    graph,
    start: { x: start.x, y: start.y },
    startHeadingDeg,
    travelBudgetM: runwayBudgetM(parsed.data.durationSeconds ?? 30, speedKph),
    turnAtJunctions: resolveTurnIntents(parsed.data.actor),
  });

  return NextResponse.json({
    derived: true,
    // The anchors ARE the polyline to draw: `deriveRunway` emits them along the
    // driven geometry with a heading each, which is also the form the payload
    // build materializes into `route`. Sending them rather than a bare point list
    // means the overlay and the runtime are drawing the same thing.
    //
    // Everything after it explains a SHORT runway. One that stops after 20 m is a
    // fact about the map, not a rendering bug, and the editor should be able to
    // say which fact (`DerivedRunwayStopReason`).
    anchors: runway.anchors,
    legs: runway.legs,
    travelledM: runway.travelledM,
    terminated: runway.terminated,
    stopReason: runway.stopReason,
    unmetTurns: runway.unmetTurns,
    startDistanceM: runway.startDistanceM,
  });
}
