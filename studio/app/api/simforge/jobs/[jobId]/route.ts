import { NextResponse } from "next/server";
import {
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { cancelOperationalJob, getOperationalJob } from "@/app/lib/scenario/jobs/store";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const job = await getOperationalJob(auth.context, jobId);
  return job
    ? NextResponse.json(job, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "job_not_found" }, { status: 404 });
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const job = await cancelOperationalJob(auth.context, jobId);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "job_not_found" }, { status: 404 });
}
