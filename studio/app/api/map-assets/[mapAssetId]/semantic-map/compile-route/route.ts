/**
 * Compile an autopilot actor's intent into an explicit route.
 *
 * Server-side because the client's semantic overlay is a viewport neighborhood
 * — `SEMANTIC_OVERLAY_MAX_VIEW_SPAN_M` is 400 m, cropped to a 2 MiB contract —
 * and a minute of driving is roughly twice that. The full graph lives here, so
 * the walk happens here. Nothing in this path talks to CARLA.
 *
 * The response is DERIVED data the caller caches on the actor, stamped with
 * what it was derived from (`graphRevision`, the spawn, the seed). A route
 * whose stamp no longer matches is stale, and a stale route is worse than none
 * — the car confidently drives a path the map no longer has.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  RuntimeTopologyFamilySchema,
  compileAutopilotRoute,
} from "@simforge-oss/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getSemanticMapGraph,
  SemanticGraphBundleChangedError,
} from "@/app/lib/maps/topology/server/semantic-map-service";
import { TopologyUnavailableError } from "@/app/lib/maps/topology/server/topology-index-service";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Who still calls this: `scripts/agent/compiled-route-parity.mjs`, and nothing else.
 *
 * It was built for the editor, which compiled an autopilot actor's route once and
 * cached it on the draft. The one-motion model removed the reason to: a vehicle's
 * route is DERIVED from its lane placement on every read, so there is nothing to
 * compile and nothing to go stale (`plans/2026-07-29-one-motion-model.md` §2.1).
 * The client half — `compile-actor-route-client.ts` — is deleted.
 *
 * The endpoint survives its own caller because the parity harness drives the real
 * chain through it to answer a question nothing else answers: whether the browser
 * engine and CARLA execute the same anchor list the same way. Retiring
 * `compileAutopilotRoute` means giving that harness `deriveRunway` to drive
 * instead, which belongs with the runtime route-graph retirement rather than here —
 * the seeded junction pick is the one behaviour `deriveRunway` would still need.
 */

/**
 * Margin on the travel budget. A route longer than the run costs nothing — the
 * car simply never reaches the end. A route SHORTER than the run makes it brake
 * to a stop mid-scenario (`reached_path_end` in `actor_control.py`), which
 * reads as a frozen actor. The asymmetry is the whole justification.
 */
const TRAVEL_BUDGET_MARGIN = 1.5;
/** Floor so a stationary-ish actor still gets a usable route to follow. */
const MIN_TRAVEL_BUDGET_M = 100;

const RequestSchema = z
  .object({
    runtime: RuntimeTopologyFamilySchema,
    /** World meters. The authority — never a road id, which UE5 renumbers. */
    start: z.object({ x: z.number(), y: z.number() }).strict(),
    /** Stable per-actor string (the actor id). Decides junction turns. */
    seed: z.string().min(1),
    durationSeconds: z.number().positive().max(3600),
    speedKph: z.number().positive().max(300),
  })
  .strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const body = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid route compile request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { mapAssetId } = await context.params;
  const mapAsset = await getMapAssetByIdFromDb(mapAssetId);
  if (!mapAsset) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }

  let graph;
  try {
    graph = await getSemanticMapGraph({
      mapAssetId,
      runtime: parsed.data.runtime,
    });
  } catch (error) {
    // Only TYPED unavailability is a 422; unexpected errors surface as 500
    // instead of being masked as graph unavailability.
    if (error instanceof TopologyUnavailableError) {
      return NextResponse.json(
        {
          error:
            "The runtime-verified semantic graph is unavailable for this map, so a route cannot be compiled.",
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
    console.error("semantic-map compile-route error:", error);
    return NextResponse.json(
      { error: "Failed to load the semantic map graph." },
      { status: 500 },
    );
  }

  const { start, seed, durationSeconds, speedKph } = parsed.data;
  const travelBudgetM = Math.max(
    MIN_TRAVEL_BUDGET_M,
    (speedKph / 3.6) * durationSeconds * TRAVEL_BUDGET_MARGIN,
  );
  const route = compileAutopilotRoute({ graph, start, travelBudgetM, seed });

  if (route.anchors.length === 0) {
    // Not an error: a car parked off any drivable corridor is a legitimate
    // scenario. The caller shows the reason rather than failing the edit.
    return NextResponse.json(
      {
        status: "unroutable",
        reason:
          "This actor is not on a drivable lane the semantic map knows about, so there is no route to follow from here.",
        graphRevision: graph.graphRevision,
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      status: "compiled",
      // The cache stamp. Recompile when any of these stops matching.
      graphRevision: graph.graphRevision,
      seed,
      start,
      travelBudgetM,
      route,
    },
    { status: 200 },
  );
}
