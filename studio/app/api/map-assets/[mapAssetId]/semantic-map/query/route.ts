import { NextRequest, NextResponse } from "next/server";
import { SemanticSiteQuerySchema } from "@simforge-oss/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import {
  executeSemanticSiteQuery,
  SemanticSiteQueryBudgetError,
} from "@/app/lib/maps/topology/server/semantic-site-query-engine";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!(await getCurrentSession())) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const { mapAssetId } = await context.params;
  if (!(await getMapAssetByIdFromDb(mapAssetId))) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }
  const query = SemanticSiteQuerySchema.safeParse(await request.json().catch(() => null));
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid semantic site query.", details: query.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const publication = await readAcceptedSemanticGraphPublication({ mapAssetId, runtime: "carla_ue5" });
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    const result = executeSemanticSiteQuery({
      query: query.data,
      manifest: publication.manifest,
      semanticMap: publication.semanticMap,
      featureGraph: publication.semanticFeatureGraph,
    });
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SemanticSiteQueryBudgetError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: 429 },
      );
    }
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        { error: "The accepted semantic map publication failed integrity validation.", code: error.code },
        { status: 503 },
      );
    }
    console.error("semantic site query route error", error);
    return NextResponse.json({ error: "Failed to execute semantic site query." }, { status: 500 });
  }
}
