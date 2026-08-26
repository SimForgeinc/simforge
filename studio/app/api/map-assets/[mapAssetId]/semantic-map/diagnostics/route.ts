import { NextRequest, NextResponse } from "next/server";
import { RuntimeTopologyFamilySchema } from "@simforge-oss/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  if (!(await getCurrentSession())) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const runtime = RuntimeTopologyFamilySchema.safeParse(request.nextUrl.searchParams.get("runtime"));
  if (!runtime.success) {
    return NextResponse.json({ error: "A valid runtime is required." }, { status: 400 });
  }
  const { mapAssetId } = await context.params;
  if (!(await getMapAssetByIdFromDb(mapAssetId))) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }
  try {
    const publication = await readAcceptedSemanticGraphPublication({ mapAssetId, runtime: runtime.data });
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    const severity = request.nextUrl.searchParams.get("severity");
    const diagnostics = severity
      ? publication.semanticMap.diagnostics.filter((item) => item.severity === severity)
      : publication.semanticMap.diagnostics;
    return NextResponse.json({
      schemaVersion: "simforge.semantic-map-diagnostics.v1",
      publicationRevision: publication.manifest.publicationRevision,
      graphRevision: publication.semanticMap.graphRevision,
      diagnostics,
    }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        { error: "The accepted semantic map publication failed integrity validation.", code: error.code },
        { status: 503 },
      );
    }
    console.error("semantic map diagnostics route error", error);
    return NextResponse.json({ error: "Failed to read semantic map diagnostics." }, { status: 500 });
  }
}
