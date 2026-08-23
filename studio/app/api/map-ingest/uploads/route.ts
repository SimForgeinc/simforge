import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CreateMapUploadInputSchema } from "@/app/lib/map-ingest/contracts";
import { createMapUploadDraft } from "@/app/lib/map-ingest/server/store";
import { presignMapUploads } from "@/app/lib/map-ingest/server/storage";
import type { MapUploadMember } from "@/app/lib/map-ingest/server/storage";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import {
  readJson,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";


export async function POST(request: NextRequest) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = CreateMapUploadInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_map_upload", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const context = getAppContext(auth.session);
  const draft = await createMapUploadDraft({
    ...parsed.data,
    workspaceId: context.workspaceId,
    createdByUserId: context.userId,
  });
  const members: MapUploadMember[] = [
    {
      path: "map.xodr",
      contentType: "application/xml",
      sha256: draft.xodrSha256,
      byteLength: draft.xodrByteLength,
    },
    ...draft.layers
      .slice()
      .sort((left, right) => left.layerId.localeCompare(right.layerId))
      .map((layer) => ({
        path: `3d/${layer.layerId}.glb`,
        contentType: "model/gltf-binary",
        sha256: layer.sha256,
        byteLength: layer.byteLength,
      })),
    {
      path: "thumbnail.webp",
      contentType: "image/webp",
      sha256: draft.thumbnailSha256,
      byteLength: draft.thumbnailByteLength,
    },
  ];
  const uploads = await presignMapUploads(members);

  return auth.apply(
    NextResponse.json(
      { draftId: draft.id, uploads },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    ),
  );
}
