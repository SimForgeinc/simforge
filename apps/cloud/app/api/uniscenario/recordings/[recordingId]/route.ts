import { NextResponse } from "next/server";
import { FinalizeBrowserRecordingSchema } from "@/app/lib/uniscenario/recording-contracts";
import {
  readJson,
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import {
  finalizeBrowserRecording,
  getBrowserRecording,
} from "@/app/lib/uniscenario/recording-store";
import { rejectUnauthorizedWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ recordingId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { recordingId } = await route.params;
  const recording = await getBrowserRecording(auth.context, recordingId);
  return recording
    ? NextResponse.json(recording, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "browser_recording_not_found" }, { status: 404 });
}

export async function PATCH(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = FinalizeBrowserRecordingSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_browser_recording_completion", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { recordingId } = await route.params;
  const recording = await finalizeBrowserRecording(auth.context, recordingId, parsed.data);
  return recording
    ? NextResponse.json(recording)
    : NextResponse.json({ error: "browser_recording_not_completable" }, { status: 409 });
}
