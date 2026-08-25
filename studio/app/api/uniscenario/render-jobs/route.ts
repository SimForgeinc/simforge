import { NextResponse } from "next/server";
import { SubmitScenarioRenderIntentSchema } from "@/app/lib/scenario/render-wire-contracts";
import { listRenderJobs } from "@/app/lib/scenario/control-plane-store";
import { createRenderIntentJob } from "@/app/lib/scenario/render-intent-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableRevisionContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { renderJobs: await listRenderJobs(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = await readJson(request);
  const parsed = SubmitScenarioRenderIntentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_render_job", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const access = await requireScenarioMutableRevisionContext(
    auth.context,
    parsed.data.revisionId,
    "read",
  );
  if (access.response) return access.response;
  let created;
  try {
    created = await createRenderIntentJob(auth.context, parsed.data);
  } catch (error) {
    if (error instanceof Error && error.message === "uniscenario_workspace_limit_reached") {
      return NextResponse.json(
        { error: "local_job_limit_reached" },
        { status: 429, headers: { "retry-after": "30" } },
      );
    }
    if (error instanceof Error && error.message.startsWith("uniscenario_render_resource_")) {
      return NextResponse.json(
        { error: error.message },
        { status: 422 },
      );
    }
    if (error instanceof Error && error.message === "uniscenario_render_intent_idempotency_conflict") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && (
      error.name === "ZodError"
      || error.message.startsWith("pronto_")
      || error.message.startsWith("carla_")
      || error.message.startsWith("render_sensor_")
    )) {
      return NextResponse.json({ error: "render_intent_invalid" }, { status: 422 });
    }
    throw error;
  }
  return created
    ? NextResponse.json(created, { status: 201 })
    : NextResponse.json({ error: "revision_or_execution_package_not_found" }, { status: 404 });
}
