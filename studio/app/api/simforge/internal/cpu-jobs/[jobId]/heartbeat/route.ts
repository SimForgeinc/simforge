import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { HeartbeatCpuJobSchema } from "@/app/lib/scenario/jobs/contracts";
import { heartbeatCpuJob } from "@/app/lib/scenario/jobs/cpu-control-store";

type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = HeartbeatCpuJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_cpu_job_heartbeat", details: parsed.error.flatten() }, { status: 400 });
  const { jobId } = await route.params;
  const result = await heartbeatCpuJob(jobId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
