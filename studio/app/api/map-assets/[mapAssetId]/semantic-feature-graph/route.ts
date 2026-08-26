import { NextRequest, NextResponse } from "next/server";
import { RuntimeTopologyFamilySchema } from "@simforge-oss/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  if (!(await getCurrentSession())) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const runtime = RuntimeTopologyFamilySchema.safeParse(
    request.nextUrl.searchParams.get("runtime"),
  );
  if (!runtime.success) {
    return NextResponse.json({ error: "A valid runtime is required." }, { status: 400 });
  }
  const { mapAssetId } = await context.params;
  try {
    const publication = await readAcceptedSemanticGraphPublication({ mapAssetId, runtime: runtime.data });
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    return NextResponse.json(publication.semanticFeatureGraph, {
      headers: { "cache-control": "private, max-age=60" },
    });
  } catch (error) {
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        { error: "The accepted semantic map publication failed integrity validation.", code: error.code },
        { status: 503 },
      );
    }
    if (error instanceof Error && error.message.startsWith("Map asset not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("semantic-feature-graph route error:", error);
    return NextResponse.json({ error: "Failed to build semantic feature graph." }, { status: 500 });
  }
}
