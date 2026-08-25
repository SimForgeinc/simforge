import { requireAppContext } from "@/app/lib/db/app-context";
import { EpisodePlaybackClient } from "./EpisodePlaybackClient";

export default async function EvalEpisodePage({
  params,
}: {
  params: Promise<{ campaignId: string; episodeId: string }>;
}) {
  const { campaignId, episodeId } = await params;
  await requireAppContext(`/dashboard/evaluation/${campaignId}/episodes/${episodeId}`);
  return <EpisodePlaybackClient campaignId={campaignId} episodeId={episodeId} />;
}
