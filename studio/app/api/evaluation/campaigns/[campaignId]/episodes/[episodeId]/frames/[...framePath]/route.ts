import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveEpisodeFramePath } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_IMMUTABLE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = {
  params: Promise<{ campaignId: string; episodeId: string; framePath: string[] }>;
};

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Camera frame thumbnails recorded next to the trace. Resolution is jailed to
 * the episode directory; anything else is a 404.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId, episodeId, framePath } = await route.params;
  const relative = framePath.join("/");
  const extension = relative.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return NextResponse.json({ error: "frame_not_found" }, { status: 404 });
  const resolved = await resolveEpisodeFramePath(campaignId, episodeId, relative);
  if (!resolved) return NextResponse.json({ error: "frame_not_found" }, { status: 404 });
  const body = await readFile(resolved);
  return new NextResponse(new Uint8Array(body), {
    headers: { "Content-Type": contentType, ...SCENARIO_IMMUTABLE_CACHE_HEADERS },
  });
}
