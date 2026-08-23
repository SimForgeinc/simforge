import { NextResponse } from "next/server";
import { RegisterRenderWorkerV2Schema } from "@/app/lib/uniscenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { registerRenderWorkerV2 } from "@/app/lib/uniscenario/render-worker-control-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = RegisterRenderWorkerV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_registration", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (renderWorkerNodeId(request) !== parsed.data.workerId) {
    return NextResponse.json({ error: "worker_node_identity_mismatch" }, { status: 409 });
  }
  try {
    return NextResponse.json(await registerRenderWorkerV2(parsed.data), { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "worker_registration_failed";
    if (code.startsWith("worker_")) {
      return NextResponse.json({ error: code }, { status: 409 });
    }
    throw error;
  }
}
