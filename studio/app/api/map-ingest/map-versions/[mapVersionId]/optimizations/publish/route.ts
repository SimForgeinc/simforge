import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { simforgeEnv } from "@/lib/compat-env";

import { OptimizeMapVersionInputSchema } from "@/app/lib/map-ingest/contracts";
import { planUploadedMapClosure } from "@/app/lib/map-ingest/server/closure";
import {
  carriedPublishInputs,
  carryDescriptorForward,
  diffOptimizedClosure,
  loadOptimizationSource,
  OptimizationSourceError,
} from "@/app/lib/map-ingest/server/optimization";
import { publishUploadedMapVersion } from "@/app/lib/map-ingest/server/publication";
import { publishedMapReleaseId, RELEASE_SUFFIX_PATTERN } from "@/app/lib/map-ingest/server/release-id";
import {
  mapClosureKey,
  readMapClosureMember,
  verifyMapClosureMember,
} from "@/app/lib/map-ingest/server/storage";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import { queryOne } from "@/app/lib/db/data-api";
import { readJson, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

/** Generating variants is local work; publishing them is still S3 plus a transaction. */
export const maxDuration = 300;

type ReleaseRow = { derivative_release_id: string };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ mapVersionId: string }> },
) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = OptimizeMapVersionInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_map_optimization", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }
  const { releaseSuffix, members } = parsed.data;
  if (!RELEASE_SUFFIX_PATTERN.test(releaseSuffix)) {
    return auth.apply(
      NextResponse.json({ error: "invalid_release_suffix", details: { releaseSuffix } }, { status: 400 }),
    );
  }

  const { mapVersionId } = await params;
  const context = getAppContext(auth.session);
  try {
    const source = await loadOptimizationSource(mapVersionId, context.workspaceId);
    // Repeated deliberately: the planning call is advisory, so every guard that
    // matters has to hold here too.
    const delta = diffOptimizedClosure(source.members, members);

    const missing: string[] = [];
    await Promise.all(
      members.map(async (member) => {
        const verification = await verifyMapClosureMember(member.sha256, member.byteLength);
        if (!verification.ok) missing.push(`${member.relativePath} ${verification.reason}`);
      }),
    );
    if (missing.length > 0) {
      return auth.apply(
        NextResponse.json(
          { error: "optimized_closure_incomplete", details: { missing: missing.sort() } },
          { status: 409 },
        ),
      );
    }

    const release = await queryOne<ReleaseRow>(
      `SELECT id AS derivative_release_id
         FROM simforge.editor_asset_releases
        WHERE workspace_id = :workspace_id AND release_state = 'active'
        LIMIT 1`,
      { workspace_id: context.workspaceId },
    );
    if (!release) {
      return auth.apply(
        NextResponse.json({ error: "active editor asset release not found for workspace" }, { status: 409 }),
      );
    }

    const artifactBucket = simforgeEnv("ARTIFACT_BUCKET")?.trim();
    if (!artifactBucket) throw new Error("SIMFORGE_ARTIFACT_BUCKET is required.");
    const closureMembers = members.map((member) => ({
      relativePath: member.relativePath,
      sha256: member.sha256,
      byteLength: member.byteLength,
      mediaType: member.mediaType,
      bucket: artifactBucket,
      key: mapClosureKey(member.sha256),
    }));

    const derivativeReleaseId = publishedMapReleaseId({
      activeReleaseId: release.derivative_release_id,
      members: closureMembers,
      releaseSuffix,
    });
    // The planner validates that every file the city manifest references is a
    // closure member, so it needs the manifest itself. An optimization may not
    // change it, so its bytes are read from the source closure by digest.
    const manifestMember = source.members.find((member) => member.relativePath === "3d/manifest.json");
    if (!manifestMember) {
      throw new OptimizationSourceError(`map version ${mapVersionId} has no 3d/manifest.json member`, 409);
    }
    const manifest: unknown = JSON.parse(
      (await readMapClosureMember(manifestMember.sha256)).toString("utf8"),
    );
    if (manifest === null || typeof manifest !== "object") {
      throw new OptimizationSourceError("the published city manifest is not an object", 409);
    }

    const plan = planUploadedMapClosure({
      workspaceId: context.workspaceId,
      sourceMapId: source.sourceMapId,
      derivativeReleaseId,
      manifest,
      members: closureMembers,
    });
    const carried = carriedPublishInputs(source.descriptor);

    const map = await publishUploadedMapVersion({
      draftId: source.draftId,
      plan,
      workspaceId: context.workspaceId,
      sourceMapId: source.sourceMapId,
      sourceMapAssetId: source.sourceMapAssetId,
      assetCatalogVersionId: source.assetCatalogVersionId,
      derivativeReleaseId,
      label: source.label,
      locality: source.locality,
      carlaMapName: source.carlaMapName,
      provenance: carryDescriptorForward({
        descriptor: source.descriptor,
        closureSha256: plan.closureSha256,
        releaseSuffix,
        sourceMapVersionId: source.mapVersionId,
      }),
      thumbnail: {
        bucket: source.thumbnail.bucket,
        key: source.thumbnail.key,
        sha256: source.thumbnail.sha256,
        byteLength: source.thumbnail.byteLength,
        // The thumbnail artifact is reused as-is; its media type is fixed by the
        // publisher's own contract, so a source row carrying anything else is a
        // corrupted record rather than something to pass through.
        mediaType: "image/webp",
        recipe: "simforge.map-upload-thumbnail/v1",
        sourceBucket: source.thumbnail.bucket,
        sourceKey: source.thumbnail.key,
      },
      mapIntel: carried.mapIntel,
      triangleCount: carried.triangleCount,
    });

    return auth.apply(NextResponse.json({ map, delta }, { status: 200 }));
  } catch (error) {
    if (error instanceof OptimizationSourceError) {
      return auth.apply(NextResponse.json({ error: error.message }, { status: error.status }));
    }
    throw error;
  }
}
