import { NextRequest, NextResponse } from "next/server";
import {
  CompleteGalleryUploadInputSchema,
  GalleryVersionIdSchema,
} from "@/app/lib/asset-gallery/contracts";
import { completeGalleryAssetVersion } from "@/app/lib/asset-gallery/store";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import {
  readJson,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsedParams = GalleryVersionIdSchema.safeParse((await params).versionId);
  const parsedBody = CompleteGalleryUploadInputSchema.safeParse(await readJson(request));
  if (!parsedParams.success || !parsedBody.success) {
    return auth.apply(
      NextResponse.json(
        {
          error: "invalid_gallery_completion",
          details: {
            params: parsedParams.success ? undefined : parsedParams.error.flatten(),
            body: parsedBody.success ? undefined : parsedBody.error.flatten(),
          },
        },
        { status: 400 },
      ),
    );
  }

  const result = await completeGalleryAssetVersion(parsedParams.data, auth.session.sub);
  if (result.kind === "not_found") {
    return auth.apply(NextResponse.json({ error: "gallery_upload_not_found" }, { status: 404 }));
  }
  if (result.kind === "forbidden") {
    return auth.apply(NextResponse.json({ error: "gallery_upload_forbidden" }, { status: 403 }));
  }
  if (result.kind === "quarantined") {
    return auth.apply(
      NextResponse.json(
        { error: "gallery_upload_verification_failed", reason: result.reason },
        { status: 409 },
      ),
    );
  }

  return auth.apply(
    NextResponse.json(
      { asset: result.asset },
      { headers: { "Cache-Control": "private, no-store" } },
    ),
  );
}
