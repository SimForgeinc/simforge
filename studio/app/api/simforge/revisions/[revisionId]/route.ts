import { NextResponse } from "next/server";
import { getScenarioRevision } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  scenarioJsonWithEtag,
  SCENARIO_IMMUTABLE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ revisionId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const revision = await getScenarioRevision(auth.context, revisionId);
  return revision
    ? await scenarioJsonWithEtag(request, revision, SCENARIO_IMMUTABLE_CACHE_HEADERS)
    : NextResponse.json({ error: "revision_not_found" }, { status: 404 });
}

