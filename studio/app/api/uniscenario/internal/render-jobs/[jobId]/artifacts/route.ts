import { NextResponse } from "next/server";
import { renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { ReserveRenderArtifactV2Schema } from "@/app/lib/uniscenario/render-wire-contracts";
import { reserveRenderArtifactV2 } from "@/app/lib/uniscenario/render-worker-control-store";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ReserveRenderArtifactV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_artifact_reservation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { jobId } = await route.params;
  const reservation = await reserveRenderArtifactV2({
    ...parsed.data,
    jobId,
    workerNodeId: renderWorkerNodeId(request)!,
  });
  return reservation ? NextResponse.json(reservation, { status: 201 }) : rejectedLeaseResponse();
}
