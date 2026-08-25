import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ScenarioEditorActorDraftSchema,
  SemanticActorIntentSchema,
  RuntimeTopologyFamilySchema,
} from "@simforge/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getSemanticMapGraph,
  SemanticGraphBundleChangedError,
} from "@/app/lib/maps/topology/server/semantic-map-service";
import { TopologyUnavailableError } from "@/app/lib/maps/topology/server/topology-index-service";
import { compileSemanticActorBinding } from "@/app/lib/scenario-editor/semantic-actor-binding";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

const RequestSchema = z.object({
  runtime: RuntimeTopologyFamilySchema,
  actor: ScenarioEditorActorDraftSchema,
  intent: SemanticActorIntentSchema,
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid semantic binding request.", details: parsed.error.flatten() },
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
    console.error("semantic-bindings compile route error:", error);
    return NextResponse.json(
      { error: "Failed to load the semantic map graph." },
      { status: 500 },
    );
  }
  const result = compileSemanticActorBinding({
    graph,
    actor: parsed.data.actor,
    intent: parsed.data.intent,
  });
  return NextResponse.json(result, { status: result.status === "exact" ? 200 : 409 });
}
