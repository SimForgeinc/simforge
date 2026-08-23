import { NextResponse } from "next/server";
import { getUniScenarioRevision } from "@/app/lib/uniscenario/document-store";
import {
  requireUniScenarioContext,
  uniScenarioJsonWithEtag,
  UNISCENARIO_IMMUTABLE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ revisionId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const revision = await getUniScenarioRevision(auth.context, revisionId);
  return revision
    ? await uniScenarioJsonWithEtag(request, revision, UNISCENARIO_IMMUTABLE_CACHE_HEADERS)
    : NextResponse.json({ error: "revision_not_found" }, { status: 404 });
}

