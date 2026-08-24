import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { OptimizeMapVersionInputSchema } from "@/app/lib/map-ingest/contracts";
import {
  diffOptimizedClosure,
  loadOptimizationSource,
  OptimizationSourceError,
} from "@/app/lib/map-ingest/server/optimization";
import { RELEASE_SUFFIX_PATTERN } from "@/app/lib/map-ingest/server/release-id";
import { presignMapClosureUploads } from "@/app/lib/map-ingest/server/storage";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import { readJson, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

/**
 * Plan a deferred optimization: tell the operator which of the closure members
 * they computed locally still need uploading.
 *
 * Advisory only. The publish route repeats every check, because a caller that
 * skipped this one must not gain anything by it.
 */
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
  if (!RELEASE_SUFFIX_PATTERN.test(parsed.data.releaseSuffix)) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_release_suffix", details: { releaseSuffix: parsed.data.releaseSuffix } },
        { status: 400 },
      ),
    );
  }

  const { mapVersionId } = await params;
  const context = getAppContext(auth.session);
  try {
    const source = await loadOptimizationSource(mapVersionId, context.workspaceId);
    const delta = diffOptimizedClosure(source.members, parsed.data.members);
    const uploads = await presignMapClosureUploads(
      parsed.data.members.map((member) => ({
        path: member.relativePath,
        contentType: member.mediaType,
        sha256: member.sha256,
        byteLength: member.byteLength,
      })),
    );
    return auth.apply(NextResponse.json({ delta, uploads }, { status: 200 }));
  } catch (error) {
    if (error instanceof OptimizationSourceError) {
      return auth.apply(
        NextResponse.json({ error: error.message }, { status: error.status }),
      );
    }
    throw error;
  }
}
