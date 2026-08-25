import { NextResponse } from "next/server";
import { getEpisodePayload } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ campaignId: string; episodeId: string }> };

/** Playback payload: normalized trace ticks + events + score + provenance. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId, episodeId } = await route.params;
  const payload = await getEpisodePayload(campaignId, episodeId);
  if (!payload) return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  return NextResponse.json(payload, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
