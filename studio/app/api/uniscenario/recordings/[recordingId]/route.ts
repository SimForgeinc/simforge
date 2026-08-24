import { NextResponse } from "next/server";
import {
  FinalizeBrowserRecordingSchema,
  UpdateBrowserRecordingProgressSchema,
} from "@/app/lib/scenario/recording-contracts";
import {
  readJson,
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import {
  finalizeBrowserRecording,
  getBrowserRecording,
  updateBrowserRecordingProgress,
} from "@/app/lib/scenario/recording-store";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ recordingId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { recordingId } = await route.params;
  const recording = await getBrowserRecording(auth.context, recordingId);
  return recording
    ? NextResponse.json(recording, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "browser_recording_not_found" }, { status: 404 });
}

export async function PUT(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = UpdateBrowserRecordingProgressSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_browser_recording_progress", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { recordingId } = await route.params;
  const updated = await updateBrowserRecordingProgress(auth.context, recordingId, parsed.data);
  return updated
    ? NextResponse.json({ updated: true })
    : NextResponse.json({ error: "browser_recording_not_active" }, { status: 409 });
}

export async function PATCH(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const auth = await requireScenarioContext();
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
