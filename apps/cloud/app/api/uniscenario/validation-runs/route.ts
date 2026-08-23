import { NextResponse } from "next/server";
import { CreateValidationRunSchema } from "@/app/lib/uniscenario/contracts";
import {
  createValidationRun,
  listValidationRuns,
} from "@/app/lib/uniscenario/control-plane-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableRevisionContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

export async function GET(request: Request) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const revisionId = new URL(request.url).searchParams.get("revisionId");
  return NextResponse.json(
    { validationRuns: await listValidationRuns(auth.context, revisionId) },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateValidationRunSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_validation_run", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // Validation is derived work over readable content, not a dataset mutation.
  const access = await requireUniScenarioMutableRevisionContext(
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
