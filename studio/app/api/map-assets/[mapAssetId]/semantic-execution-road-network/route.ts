import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { semanticRoadSegments } from "@/app/lib/maps/topology/semantic-road-segments";
import { readAcceptedSemanticGraphPublication } from "@/app/lib/maps/topology/server/semantic-graph-publication-store";

/** Explicit harness/export surface. The interactive editor uses viewport
 * semantic overlays and never calls this full-network endpoint. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ mapAssetId: string }> },
) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;
  const { mapAssetId } = await context.params;
  const publication = await readAcceptedSemanticGraphPublication({
    mapAssetId,
    runtime: "carla_ue5",
  });
  if (!publication) {
    return auth.apply(NextResponse.json(
      { error: "accepted_semantic_publication_missing" },
      { status: 404 },
    ));
  }
  const roadSegments = semanticRoadSegments(
    publication.semanticMap,
    publication.topology,
  );
  return auth.apply(NextResponse.json({
    contract: "simforge.semantic-road-network.v1",
    mapAssetId,
    publicationRevision: publication.manifest.publicationRevision,
    semanticMapGraphRevision: publication.manifest.semanticMapGraphRevision,
    semanticExecutionIndexRevision:
      publication.manifest.semanticExecutionIndexRevision,
    runtime: {
      map_name: publication.manifest.runtimeMapName,
      normalized_map_name: publication.manifest.runtimeMapName,
      road_segments: roadSegments,
    },
  }, {
    headers: {
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: `"${publication.manifest.publicationRevision}"`,
    },
  }));
}
