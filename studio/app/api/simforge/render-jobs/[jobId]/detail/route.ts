import { NextResponse } from "next/server";
import { getRenderJobDetail } from "@/app/lib/scenario/render/detail-store";
import {
  requireScenarioContext,
  requireScenarioMutableRenderJobContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ jobId: string }> };

/**
 * One render job with its attempts, its event log, and its artifact metadata (manifest #136, #151).
 *
 * Distinct from `[jobId]/route.ts`, which returns the flat control-plane row. This is the details-tab
 * payload: it adds `attempts[]`, `events[]`, and `artifacts[]` in a single response so the tab opens
 * without a fan-out of follow-up requests.
 *
 * DYNAMIC, never cached. `job_state`, `progress`, `attempt_count`, every attempt row and the whole
 * event log are worker-advanced — the event log exists precisely to be appended to while this tab is
 * open, so caching would defeat the feature rather than merely risk staleness.
 *
 * ARTIFACTS HERE CARRY NO URLs, deliberately. Presigning every artifact on every detail poll would
 * mint signatures nobody uses and put a 3600s-lived credential in a payload that is refreshed every
 * few seconds. The client fetches `[jobId]/artifacts` when the user actually opens the artifacts tab
 * or a preview.
 *
 * Returns a HIDDEN job rather than 404ing. Hiding is a gallery-listing concept, so a deep link into a
 * hidden render must still resolve — `hiddenAt` and `hiddenByUserId` are on the response so the UI can
 * show that state and offer to unhide. 404ing would make a hidden render unrecoverable through the UI.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;

  const access = await requireScenarioMutableRenderJobContext(auth.context, jobId, "read");
  if (access.response) return access.response;

  try {
    const detail = await getRenderJobDetail(auth.context, jobId);
    return detail
      ? NextResponse.json(detail, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
      : NextResponse.json({ error: "render_job_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "uniscenario_render_lineage_invalid") {
      return NextResponse.json(
        { error: "render_job_lineage_unavailable" },
        { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
    }
    throw error;
  }
}
