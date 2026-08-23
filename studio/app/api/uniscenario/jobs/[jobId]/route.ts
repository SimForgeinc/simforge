import { NextResponse } from "next/server";
import {
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import { cancelOperationalJob, getOperationalJob } from "@/app/lib/uniscenario/jobs/store";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const job = await getOperationalJob(auth.context, jobId);
  return job
    ? NextResponse.json(job, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "job_not_found" }, { status: 404 });
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const job = await cancelOperationalJob(auth.context, jobId);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "job_not_found" }, { status: 404 });
}
