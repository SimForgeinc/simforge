import { NextResponse } from "next/server";
import { getRenderJobProvenance } from "@/app/lib/scenario/control-plane-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const provenance = await getRenderJobProvenance(auth.context, jobId);
  return provenance
    ? NextResponse.json(provenance, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "render_job_not_found" }, { status: 404 });
}
