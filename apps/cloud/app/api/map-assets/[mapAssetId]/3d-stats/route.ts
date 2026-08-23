import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { computeThreeDStats, type ThreeDStats } from "@/app/lib/3d-manifest-stats";

// Re-export so existing client imports still resolve
export type { ThreeDStats as ThreeDStatsResponse } from "@/app/lib/3d-manifest-stats";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

// Runtime validation for the manifest shape
const ManifestSchema = z.object({
  version: z.string(),
  generator: z.string(),
  created: z.string(),
  scene: z.object({
    bounds: z.object({ min: z.array(z.number()), max: z.array(z.number()) }),
    totalTriangles: z.number(),
    gridDimensions: z.tuple([z.number(), z.number()]),
    cellSize: z.tuple([z.number(), z.number()]),
    origin: z.array(z.number()),
    lodLevels: z.number(),
    coordinateSystem: z.string(),
  }),
  tiles: z.array(
    z.object({
      id: z.string(),
      gridX: z.number(),
      gridZ: z.number(),
      bounds: z.object({ min: z.array(z.number()), max: z.array(z.number()) }),
      lods: z.array(
        z.object({
          level: z.number(),
          file: z.string(),
          triangles: z.number(),
          fileSize: z.number(),
          geometricError: z.number(),
        }),
      ),
    }),
  ),
  staticLayers: z
    .array(
      z.object({
        id: z.string(),
        file: z.string(),
        triangles: z.number(),
        fileSize: z.number(),
      }),
    )
    .optional(),
  vegetationTiles: z
    .array(
      z.object({
        id: z.string(),
        gridX: z.number(),
        gridZ: z.number(),
        bounds: z.object({ min: z.array(z.number()), max: z.array(z.number()) }),
        lods: z.array(
          z.object({
            level: z.number(),
            file: z.string(),
            triangles: z.number(),
            fileSize: z.number(),
            geometricError: z.number(),
          }),
        ),
        prototypes: z.array(
          z.object({
            meshName: z.string(),
            triangles: z.number(),
            instanceCount: z.number(),
          }),
        ),
        instanceFile: z.string(),
      }),
    )
    .optional(),
});

/**
 * Get 3D digital twin statistics derived from the manifest.json
 * @description Reads the manifest.json from S3 for this map asset's 3D bundle
 *   and returns computed statistics for the attribute panel.
 * @pathParams MapAssetIdParams
 * @response 200
 * @responseSet common
 * @add 404
 * @tag Map assets
 * @openapi
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const { mapAssetId } = await params;

  if (!mapAssetId?.trim()) {
    return NextResponse.json(
      { error: "Missing mapAssetId" },
      { status: 400 },
    );
  }

  const key = `maps/${mapAssetId}/3d/manifest.json`;

  let raw: string;
  try {
    raw = await getS3ObjectUtf8(S3_BUCKET, key);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err?.name === "NoSuchKey" ||
      err?.$metadata?.httpStatusCode === 404
    ) {
      return NextResponse.json(
        { error: "No 3D manifest found for this map asset" },
        { status: 404 },
      );
    }
    if (
      err?.name === "CredentialsProviderError" ||
      String(e).includes("Could not load credentials")
    ) {
      return NextResponse.json(
        { error: "S3 credentials not configured" },
        { status: 503 },
      );
    }
    console.error("3d-stats S3 read error:", e);
    return NextResponse.json(
      { error: "Failed to read 3D manifest" },
      { status: 500 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid manifest.json" },
      { status: 500 },
    );
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    console.error("3d-stats manifest validation error:", result.error.message);
    return NextResponse.json(
      { error: "Malformed manifest.json" },
      { status: 500 },
    );
  }

  const stats: ThreeDStats = computeThreeDStats(result.data);

  return NextResponse.json(stats, {
    headers: {
      // Cache for 5 minutes — manifest rarely changes
      "Cache-Control": "private, max-age=300",
    },
  });
}
