import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/uniscenario/worker-http";
import { ReserveCpuJobOutputSchema } from "@/app/lib/uniscenario/jobs/contracts";
import { reserveCpuJobOutputs } from "@/app/lib/uniscenario/jobs/cpu-control-store";

type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ReserveCpuJobOutputSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_cpu_job_artifact_reservation", details: parsed.error.flatten() }, { status: 400 });
  const { jobId } = await route.params;
  const artifacts = await reserveCpuJobOutputs(jobId, parsed.data);
  return artifacts ? NextResponse.json({ artifacts }) : NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
