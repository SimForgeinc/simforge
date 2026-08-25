import { NextResponse } from "next/server";
import { CreateValidationRunSchema } from "@/app/lib/scenario/contracts";
import {
  createValidationRun,
  listValidationRuns,
} from "@/app/lib/scenario/control-plane-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableRevisionContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const revisionId = new URL(request.url).searchParams.get("revisionId");
  return NextResponse.json(
    { validationRuns: await listValidationRuns(auth.context, revisionId) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateValidationRunSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_validation_run", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // Validation is derived work over readable content, not a dataset mutation.
  const access = await requireScenarioMutableRevisionContext(
    auth.context,
    parsed.data.revisionId,
    "read",
  );
  if (access.response) return access.response;
  const created = await createValidationRun(auth.context, parsed.data);
  return created
    ? NextResponse.json(created, { status: 201 })
    : NextResponse.json({ error: "revision_not_found" }, { status: 404 });
}
