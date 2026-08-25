import { NextResponse } from "next/server";
import { FailRenderJobV2Schema } from "@/app/lib/scenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { failRenderJobV2 } from "@/app/lib/scenario/render-worker-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = FailRenderJobV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_failure", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { jobId } = await route.params;
  const result = await failRenderJobV2({
    ...parsed.data,
    jobId,
    workerNodeId: renderWorkerNodeId(request)!,
  });
  return result ? NextResponse.json(result, { status: 202 }) : rejectedLeaseResponse();
}
