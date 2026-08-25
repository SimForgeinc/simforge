import { NextResponse } from "next/server";
import { getHifiPreviewRequest } from "@/app/lib/hifi-preview/store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ requestId: string }> };

/** Poll one preview request: status, then artifact URL + provenance. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { requestId } = await route.params;
  const record = await getHifiPreviewRequest(auth.context, requestId);
  return record
    ? NextResponse.json(record, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "hifi_preview_not_found" }, { status: 404 });
}
