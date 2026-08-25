import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { ClaimCpuJobSchema } from "@/app/lib/scenario/jobs/contracts";
import { claimCpuJob } from "@/app/lib/scenario/jobs/cpu-control-store";

export async function POST(request: Request) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ClaimCpuJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_cpu_job_claim", details: parsed.error.flatten() }, { status: 400 });
  const claim = await claimCpuJob(parsed.data);
  return claim ? NextResponse.json(claim) : new NextResponse(null, { status: 204 });
}
