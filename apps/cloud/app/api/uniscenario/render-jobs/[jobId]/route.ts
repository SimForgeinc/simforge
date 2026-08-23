import { NextResponse } from "next/server";
import { getRenderJob } from "@/app/lib/uniscenario/control-plane-store";
import { cancelOperationalJobWithResult } from "@/app/lib/uniscenario/jobs/store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableRenderJobContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const job = await getRenderJob(auth.context, jobId);
  return job
    ? NextResponse.json(job, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "render_job_not_found" }, { status: 404 });
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;
  const access = await requireUniScenarioMutableRenderJobContext(
    auth.context,
    jobId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const cancellation = await cancelOperationalJobWithResult(auth.context, jobId, {
    family: "openscenario_render",
  });
  return cancellation.job && (cancellation.mutated || cancellation.job.status === "cancelled")
    ? NextResponse.json(cancellation.job)
    : NextResponse.json({ error: "render_job_not_cancellable" }, { status: 409 });
}
