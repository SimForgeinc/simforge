import { NextResponse } from "next/server";
import { DrainRenderWorkerV2Schema } from "@/app/lib/scenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { drainRenderWorkerV2 } from "@/app/lib/scenario/render-worker-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ workerNodeId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = DrainRenderWorkerV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_state", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { workerNodeId } = await route.params;
  if (renderWorkerNodeId(request) !== workerNodeId) {
    return NextResponse.json({ error: "worker_node_identity_mismatch" }, { status: 409 });
  }
  try {
    const updated = await drainRenderWorkerV2(parsed.data.registrationId, workerNodeId);
    return updated
      ? NextResponse.json(updated)
      : NextResponse.json({ error: "worker_not_found" }, { status: 404 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "worker_state_failed";
    if (code.startsWith("worker_")) return NextResponse.json({ error: code }, { status: 409 });
    throw error;
  }
}
