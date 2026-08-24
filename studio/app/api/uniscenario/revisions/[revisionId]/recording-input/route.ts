import { NextResponse } from "next/server";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { getScenarioRecordingRevisionInput } from "@/app/lib/scenario/recording-revision-store";

type Context = { params: Promise<{ revisionId: string }> };

/** Immutable authoring input for resolving a browser capture manifest. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const revision = await getScenarioRecordingRevisionInput(
    auth.context,
    revisionId,
  );
  return revision
    ? NextResponse.json(revision, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json(
        { error: "revision_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
}
