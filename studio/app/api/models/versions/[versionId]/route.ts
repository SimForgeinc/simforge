import { NextResponse } from "next/server";
import { getModelVersion } from "@/app/lib/models/model-registry-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ versionId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { versionId } = await route.params;
  const result = await getModelVersion(auth.context, versionId);
  if (!result) return NextResponse.json({ error: "model_version_not_found" }, { status: 404 });
  return NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
