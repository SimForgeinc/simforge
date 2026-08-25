import { NextRequest, NextResponse } from "next/server";
import { RuntimeTopologyFamilySchema } from "@simforge/studio-shared";
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
    const publication = await readAcceptedSemanticGraphPublication({
      mapAssetId,
      runtime: runtime.data,
    });
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    const { manifest, semanticMap, semanticFeatureGraph } = publication;
    const artifacts = Object.fromEntries(
      Object.entries(manifest.artifacts).map(([name, artifact]) => [name, {
        encoding: artifact.encoding,
        sizeBytesRaw: artifact.sizeBytesRaw,
        sizeBytesStored: artifact.sizeBytesStored,
        sha256: artifact.sha256,
      }]),
    );
    return NextResponse.json({
      schemaVersion: manifest.schemaVersion,
      status: manifest.status,
      publicationRevision: manifest.publicationRevision,
      publishedAt: manifest.publishedAt,
      mapAssetId: manifest.mapAssetId,
      runtime: manifest.runtime,
      runtimeMapName: manifest.runtimeMapName,
      runtimeCatalogVersion: manifest.runtimeCatalogVersion,
      bundleVersion: manifest.bundleVersion,
      xodrSha256: manifest.xodrSha256,
      runtimeRoadGraphSha256: manifest.runtimeRoadGraphSha256,
      projectionIdentitySha256: manifest.projectionIdentitySha256,
      compilers: {
        topology: manifest.topologyCompilerVersion,
        semanticMap: manifest.semanticMapCompilerVersion,
        semanticFeatures: manifest.semanticFeatureCompilerVersion,
        semanticExecutionIndex:
          manifest.semanticExecutionIndexCompilerVersion,
      },
      graphRevisions: {
        semanticMap: manifest.semanticMapGraphRevision,
        semanticFeatures: manifest.semanticFeatureGraphRevision,
        semanticExecutionIndex: manifest.semanticExecutionIndexRevision,
      },
      authority: semanticMap.authority,
      authoringReady: semanticMap.authoringReady,
      stats: {
        semanticMap: semanticMap.stats,
        semanticFeatures: semanticFeatureGraph.stats,
        diagnostics: {
          total: semanticMap.diagnostics.length,
          errors: semanticMap.diagnostics.filter((item) => item.severity === "error").length,
          warnings: semanticMap.diagnostics.filter((item) => item.severity === "warning").length,
        },
      },
      artifacts,
    }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        { error: "The accepted semantic map publication failed integrity validation.", code: error.code },
        { status: 503 },
      );
    }
    console.error("semantic map manifest route error", error);
    return NextResponse.json({ error: "Failed to read semantic map publication." }, { status: 500 });
  }
}
