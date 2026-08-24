import { NextResponse } from "next/server";
import { getFinalizedArtifact } from "@/app/lib/scenario/control-plane-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ artifactId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { artifactId } = await route.params;
  const disposition = new URL(request.url).searchParams.get("download") === "1"
    ? "attachment"
    : "inline";
  const artifact = await getFinalizedArtifact(auth.context, artifactId, disposition);
  return artifact
    ? NextResponse.json(artifact, {
        headers: { "Cache-Control": "private, no-store" },
      })
    : NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
}
