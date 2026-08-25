import { NextResponse } from "next/server";
import { CreateHifiPreviewSchema } from "@/app/lib/hifi-preview/contracts";
import { createHifiPreviewRequest } from "@/app/lib/hifi-preview/store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";
import { kickHifiPreviewExecutor } from "@/worker/hifi-preview";

/**
 * Enqueue one high-fidelity preview frame: the current editor scene tick +
 * contract camera report. Responds 202 with the queued request; poll
 * `/api/hifi-preview/[requestId]` for the artifact URL + provenance.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateHifiPreviewSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_hifi_preview_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const record = await createHifiPreviewRequest(auth.context, parsed.data);
  // Local PGlite is single-owner: the server process renders the queue itself.
  kickHifiPreviewExecutor();
  return NextResponse.json(record, { status: 202 });
}
