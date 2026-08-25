import { NextResponse } from "next/server";
import { getModelRun } from "@/app/lib/models/model-run-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { runId } = await route.params;
  const result = await getModelRun(auth.context, runId);
  if (!result) return NextResponse.json({ error: "model_run_not_found" }, { status: 404 });
  return NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
