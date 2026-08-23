import { NextResponse } from "next/server";
import { getArtifactUpload } from "@/app/lib/uniscenario/control-plane-store";
import { requireUniScenarioContext } from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ uploadId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { uploadId } = await route.params;
  const upload = await getArtifactUpload(auth.context, uploadId);
  return upload
    ? NextResponse.json(upload)
    : NextResponse.json({ error: "artifact_upload_not_found" }, { status: 404 });
}

