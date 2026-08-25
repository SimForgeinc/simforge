import { NextResponse } from "next/server";
import { ClaimRenderJobV2Schema } from "@/app/lib/scenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { claimResponseV2 } from "@/app/lib/scenario/render-worker-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ClaimRenderJobV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_lease_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const workerNodeId = renderWorkerNodeId(request)!;
  const registered = await claimResponseV2(parsed.data.registrationId, workerNodeId);
  return NextResponse.json(registered);
}
