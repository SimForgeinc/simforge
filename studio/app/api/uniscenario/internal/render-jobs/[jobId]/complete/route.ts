import { NextResponse } from "next/server";
import { CompleteRenderJobV2Schema } from "@/app/lib/uniscenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { completeRenderJobV2 } from "@/app/lib/uniscenario/render-worker-control-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = CompleteRenderJobV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_completion", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { jobId } = await route.params;
  try {
    const result = await completeRenderJobV2({
      ...parsed.data,
      jobId,
      workerNodeId: renderWorkerNodeId(request)!,
    });
    return result ? NextResponse.json(result) : rejectedLeaseResponse();
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "artifact_verification_failed";
    const details = error instanceof Error
      && "verificationDetails" in error
      && typeof error.verificationDetails === "object"
      ? error.verificationDetails
      : undefined;
    return NextResponse.json({ error: code, ...(details ? { details } : {}) }, { status: 409 });
  }
}
