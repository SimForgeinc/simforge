import { NextResponse } from "next/server";
import { CreateModelRunSchema } from "@/app/lib/models/contracts";
import { createModelRun, listModelRuns } from "@/app/lib/models/model-run-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const search = new URL(request.url).searchParams;
  return NextResponse.json(
    {
      runs: await listModelRuns(auth.context, {
        modelVersionId: search.get("modelVersionId") ?? undefined,
        status: search.get("status") ?? undefined,
      }),
    },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateModelRunSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_model_run", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createModelRun(auth.context, parsed.data);
  if (result.kind === "endpoint_not_found") {
    return NextResponse.json({ error: "model_endpoint_not_found" }, { status: 404 });
  }
  return NextResponse.json(result.run, { status: 201 });
}
