import { NextResponse } from "next/server";

import {
  requireScenarioContext,
  scenarioJsonWithEtag,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { getScenarioSignalControlProjection } from "@/app/lib/scenario/signals/projection-store.server";

type Context = { params: Promise<{ mapVersionId: string }> };

/**
 * The editor's traffic-signal projection for one map version.
 *
 * Its own route rather than a field on the map descriptor: the descriptor list is
 * read on every editor boot for every map in the workspace, and this read opens
 * three S3 objects and parses a whole XODR. The panel is the only surface that
 * wants it, and only for the map version currently open.
 *
 * `private` for the same reason the descriptor route sets it: the body is
 * workspace-scoped content and must not land in a shared cache. Revalidated
 * rather than `no-store` because no presigned URL exists on this path, and this
 * is one of the larger bodies on the editor's boot path — an unchanged
 * projection costs a 304 instead of the whole thing.
 *
 * Deliberately NOT `immutable`, even though the projection is keyed on an
 * immutable `(workspaceId, mapVersionId)` pair: the bytes are derived by code
 * that ships with the app, so a deploy that changes the projection would leave
 * every client pinned to a year-old body. Revalidation costs one round trip and
 * cannot go stale.
 */
export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const projection = await getScenarioSignalControlProjection(auth.context, mapVersionId);
  return projection
    ? await scenarioJsonWithEtag(request, projection)
    : NextResponse.json(
        { error: "signal_control_unavailable" },
        { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
}
