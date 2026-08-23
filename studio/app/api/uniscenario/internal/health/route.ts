import { NextResponse } from "next/server";
import {
  getUniScenarioControlPlaneHealth,
  renderWorkerNodeId,
} from "@/app/lib/uniscenario/control-plane-store";
import {
  rejectUnauthorizedRenderWorker,
  rejectUnauthorizedWorker,
} from "@/app/lib/uniscenario/worker-http";

export async function GET(request: Request) {
  const operatorUnauthorized = rejectUnauthorizedWorker(request);
  const scopedUnauthorized = operatorUnauthorized
    ? await rejectUnauthorizedRenderWorker(request)
    : null;
  if (operatorUnauthorized && scopedUnauthorized) return scopedUnauthorized;
  const workerNodeId = new URL(request.url).searchParams.get("workerNodeId")?.trim() || null;
  if (workerNodeId && workerNodeId.length > 200) {
    return NextResponse.json({ error: "invalid_worker_node_id" }, { status: 400 });
  }
  if (operatorUnauthorized && (!workerNodeId || renderWorkerNodeId(request) !== workerNodeId)) {
    return NextResponse.json({ error: "worker_node_identity_mismatch" }, { status: 409 });
  }
  const health = await getUniScenarioControlPlaneHealth(workerNodeId);
  return NextResponse.json(health, { status: health.status === "ready" ? 200 : 503 });
}
