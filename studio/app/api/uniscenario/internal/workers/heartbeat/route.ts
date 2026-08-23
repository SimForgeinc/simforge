import { NextResponse } from "next/server";
import { RenderWorkerIdleHeartbeatSchema } from "@/app/lib/uniscenario/contracts";
import { heartbeatIdleRenderWorker, renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = RenderWorkerIdleHeartbeatSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_heartbeat", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (renderWorkerNodeId(request) !== parsed.data.workerNodeId) {
    return NextResponse.json({ error: "worker_node_identity_mismatch" }, { status: 409 });
  }
  const heartbeat = await heartbeatIdleRenderWorker(
    parsed.data.workerNodeId,
    parsed.data.identity,
  );
  return heartbeat ? NextResponse.json(heartbeat) : rejectedLeaseResponse();
}
