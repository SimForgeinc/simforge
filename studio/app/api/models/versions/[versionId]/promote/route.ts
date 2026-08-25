import { NextResponse } from "next/server";
import { PromoteModelVersionSchema } from "@/app/lib/models/contracts";
import { promoteModelVersion } from "@/app/lib/models/model-registry-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ versionId: string }> };

/**
 * Promotion is gated in the database: the referenced run must be a SUCCEEDED
 * openloop/policy_episode run of this version, or this returns 409.
 */
export async function POST(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = PromoteModelVersionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_promotion", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { versionId } = await route.params;
  const result = await promoteModelVersion(auth.context, versionId, parsed.data.runId);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "model_version_not_found" }, { status: 404 });
  }
  if (result.kind === "invalid_promotion") {
    return NextResponse.json(
      { error: "promotion_requires_succeeded_eval_run", detail: result.message },
      { status: 409 },
    );
  }
  return NextResponse.json(result.version);
}
