import { NextResponse } from "next/server";
import { CreateModelVersionSchema } from "@/app/lib/models/contracts";
import { createModelVersion, listModelVersions } from "@/app/lib/models/model-registry-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { versions: await listModelVersions(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateModelVersionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_model_version", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createModelVersion(auth.context, parsed.data);
  if (result.kind === "conflict") {
    return NextResponse.json(
      { error: "model_version_exists", fields: ["family", "checkpointDigest", "quant"] },
      { status: 409 },
    );
  }
  return NextResponse.json(result.version, { status: 201 });
}
