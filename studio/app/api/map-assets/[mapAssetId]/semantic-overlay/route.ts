import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RuntimeTopologyFamilySchema } from "@simforge/studio-shared";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import {
  projectSemanticMapOverlay,
  SemanticOverlayTooLargeError,
} from "@/app/lib/maps/topology/server/semantic-overlay-service";
import { ServerTimingRecorder } from "@/app/lib/http/server-timing";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

const QuerySchema = z.object({
  runtime: RuntimeTopologyFamilySchema,
  minX: z.coerce.number().finite(),
  minY: z.coerce.number().finite(),
  maxX: z.coerce.number().finite(),
  maxY: z.coerce.number().finite(),
}).superRefine((value, context) => {
  if (value.minX >= value.maxX) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxX"], message: "maxX must exceed minX" });
  }
  if (value.minY >= value.maxY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxY"], message: "maxY must exceed minY" });
  }
});

export async function GET(request: NextRequest, context: RouteContext) {
  const timing = new ServerTimingRecorder();
  const session = await timing.measure("session", getCurrentSession);
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid runtime and viewport are required.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { mapAssetId } = await context.params;
  if (!(await timing.measure("aurora_map_asset", () => getMapAssetByIdFromDb(mapAssetId)))) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }
  try {
    const publication = await timing.measure("s3_semantic_artifacts", () =>
      readAcceptedSemanticGraphPublication({
        mapAssetId,
        runtime: parsed.data.runtime,
      }));
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    const overlay = timing.measureSync("projection", () => projectSemanticMapOverlay({
      graph: publication.semanticMap,
      featureGraph: publication.semanticFeatureGraph,
      viewport: {
        minX: parsed.data.minX,
        minY: parsed.data.minY,
        maxX: parsed.data.maxX,
        maxY: parsed.data.maxY,
      },
    }));
    return timing.finish(timing.measureSync("serialize", () => NextResponse.json(overlay, {
      headers: { "cache-control": "private, max-age=60" },
    })));
  } catch (error) {
    if (error instanceof SemanticOverlayTooLargeError) {
      return NextResponse.json(
        {
          error: "The viewport contains too much semantic map data; zoom in and retry.",
          code: "semantic_overlay_too_large",
          details: { sizeBytes: error.sizeBytes },
        },
        { status: 413 },
      );
    }
    // Only TYPED unavailability is a 422 the client may treat as "this map has
    // no semantic graph"; anything else is an unexpected server error and must
    // surface as one instead of being masked as graph unavailability.
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        {
          error: "The accepted semantic map publication failed integrity validation.",
          code: error.code,
        },
        { status: 503 },
      );
    }
    console.error("semantic-overlay route error:", error);
    return NextResponse.json(
      { error: "Failed to build the semantic overlay." },
      { status: 500 },
    );
  }
}
