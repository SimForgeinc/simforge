import { NextResponse } from "next/server";
import { CreateModelEndpointSchema } from "@/app/lib/models/contracts";
import { createModelEndpoint, listModelEndpoints } from "@/app/lib/models/model-registry-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const modelVersionId = new URL(request.url).searchParams.get("modelVersionId") ?? undefined;
  return NextResponse.json(
    { endpoints: await listModelEndpoints(auth.context, { modelVersionId }) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateModelEndpointSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_model_endpoint", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createModelEndpoint(auth.context, parsed.data);
  if (result.kind === "version_not_found") {
    return NextResponse.json({ error: "model_version_not_found" }, { status: 404 });
  }
  if (result.kind === "conflict") {
    return NextResponse.json({ error: "model_endpoint_name_taken", field: "name" }, { status: 409 });
  }
  return NextResponse.json(result.endpoint, { status: 201 });
}
