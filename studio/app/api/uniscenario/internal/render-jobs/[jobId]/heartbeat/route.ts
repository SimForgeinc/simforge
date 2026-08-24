import { NextResponse } from "next/server";
import { LeaseHeartbeatV2Schema } from "@/app/lib/uniscenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { heartbeatRenderLeaseV2 } from "@/app/lib/uniscenario/render-worker-control-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = LeaseHeartbeatV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_heartbeat", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { jobId } = await route.params;
  const heartbeat = await heartbeatRenderLeaseV2({
    ...parsed.data,
    jobId,
    workerNodeId: renderWorkerNodeId(request)!,
  });
  return heartbeat ? NextResponse.json(heartbeat) : rejectedLeaseResponse();
}
