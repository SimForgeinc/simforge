import { NextResponse } from "next/server";
import { BindArtifactUploadSchema } from "@/app/lib/uniscenario/contracts";
import { bindArtifactUpload, renderWorkerNodeId } from "@/app/lib/uniscenario/control-plane-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ jobId: string; uploadId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = BindArtifactUploadSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_upload_binding", details: parsed.error.flatten() }, { status: 400 });
  }
  const { jobId, uploadId } = await route.params;
  try {
    const result = await bindArtifactUpload(jobId, uploadId, {
      ...parsed.data,
      workerNodeId: renderWorkerNodeId(request)!,
    });
    return result ? NextResponse.json(result) : rejectedLeaseResponse();
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "upload_binding_failed";
    return NextResponse.json({ error: code }, { status: 409 });
  }
}
