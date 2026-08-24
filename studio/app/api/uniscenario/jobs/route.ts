import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { SCENARIO_JOB_FAMILIES } from "@/app/lib/scenario/jobs/contracts";
import { listOperationalJobs } from "@/app/lib/scenario/jobs/store";

const QuerySchema = z.object({
  family: z.enum(SCENARIO_JOB_FAMILIES).nullable(),
  revisionId: z.string().trim().min(1).nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const query = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    family: query.get("family"),
    revisionId: query.get("revisionId"),
    limit: query.get("limit") ?? 100,
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid_job_query", details: parsed.error.flatten() }, { status: 400 });
  const jobs = await listOperationalJobs(auth.context, parsed.data);
  return NextResponse.json({ jobs }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
