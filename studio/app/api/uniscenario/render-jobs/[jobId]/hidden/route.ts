import { NextResponse } from "next/server";
import { z } from "zod";
import { setRenderJobHidden } from "@/app/lib/uniscenario/render/gallery-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableRenderJobContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ jobId: string }> };

const SetHiddenSchema = z.object({ hidden: z.boolean() });

/**
 * Hide or unhide a render job in the gallery.
 *
 * PATCH rather than DELETE, because this is not a deletion and must not be mistaken for one.
 * `[jobId]/route.ts` already owns `DELETE`, and that cancels the job. This is a soft, reversible
 * visibility flag: the row, its attempts, its events and every artifact stay exactly where they are,
 * `[jobId]/detail` still resolves, and `[jobId]/artifacts` still serves downloads. Only the gallery
 * lists filter it out.
 *
 * `hidden` is required and must be an explicit boolean — there is no toggle. A toggle would make the
 * result depend on state the client last saw, so two clicks racing each other could leave the job in
 * either state with no way to tell which. Sending the desired end state makes the request idempotent.
 *
 * A repeated hide preserves the original `hidden_at` and `hidden_by_user_id` (the store COALESCEs
 * them), so "who hid this, and when" survives a double-click rather than being overwritten by whoever
 * clicked last.
 *
 * Authorized as a CONTENT MUTATION, not a read. Hiding changes what every member of the workspace
 * sees in the gallery, so a caller with read-only access to a shared dataset must not be able to do
 * it.
 */
export async function PATCH(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;

  const parsed = SetHiddenSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_hidden_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const access = await requireUniScenarioMutableRenderJobContext(
    auth.context,
    jobId,
    "mutateContent",
  );
  if (access.response) return access.response;

  const updated = await setRenderJobHidden(auth.context, jobId, parsed.data.hidden);
  return updated
    ? NextResponse.json(updated)
    : NextResponse.json({ error: "render_job_not_found" }, { status: 404 });
}
