import { NextResponse } from "next/server";
import {
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import { getUniScenarioRecordingRevisionInput } from "@/app/lib/uniscenario/recording-revision-store";

type Context = { params: Promise<{ revisionId: string }> };

/** Immutable authoring input for resolving a browser capture manifest. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const revision = await getUniScenarioRecordingRevisionInput(
    auth.context,
    revisionId,
  );
  return revision
    ? NextResponse.json(revision, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json(
        { error: "revision_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
}
