import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  RuntimeTopologyFamilySchema,
  ScenarioEditorActorDraftSchema,
} from "@simforge-oss/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getSemanticMapGraph,
  SemanticGraphBundleChangedError,
} from "@/app/lib/maps/topology/server/semantic-map-service";
import { TopologyUnavailableError } from "@/app/lib/maps/topology/server/topology-index-service";
import { classifyExistingActorSemanticAnchor } from "@/app/lib/scenario-editor/semantic-actor-binding";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

const RequestSchema = z.object({
  runtime: RuntimeTopologyFamilySchema,
  actor: ScenarioEditorActorDraftSchema,
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid semantic classification request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { mapAssetId } = await context.params;
  if (!(await getMapAssetByIdFromDb(mapAssetId))) {
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
    console.error("semantic-bindings classify route error:", error);
    return NextResponse.json(
      { error: "Failed to load the semantic map graph." },
      { status: 500 },
    );
  }
  return NextResponse.json(
    classifyExistingActorSemanticAnchor(graph, parsed.data.actor),
  );
}
