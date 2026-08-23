import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CreateBrowserRecordingSchema,
  ReserveBrowserRecordingArtifactsSchema,
} from "@/app/lib/uniscenario/recording-contracts";
import {
  readJson,
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/uniscenario/worker-http";
import {
  createBrowserRecording,
  failBrowserRecording,
  listBrowserRecordings,
  reserveBrowserRecordingArtifacts,
} from "@/app/lib/uniscenario/recording-store";

const QuerySchema = z.strictObject({
  revisionId: z.string().trim().min(1).max(200).nullable(),
  documentId: z.string().trim().min(1).max(200).nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateAndReserveSchema = z.strictObject({
  recording: CreateBrowserRecordingSchema,
  artifacts: ReserveBrowserRecordingArtifactsSchema.shape.artifacts,
});

export async function GET(request: Request) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const query = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    revisionId: query.get("revisionId"),
    documentId: query.get("documentId"),
    limit: query.get("limit") ?? 50,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_recording_query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const recordings = await listBrowserRecordings(auth.context, parsed.data);
  return NextResponse.json(
    { recordings },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateAndReserveSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_browser_recording", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const recording = await createBrowserRecording(auth.context, parsed.data.recording);
  if (!recording) {
    return NextResponse.json({ error: "browser_recording_not_eligible" }, { status: 409 });
  }
  const artifacts = await reserveBrowserRecordingArtifacts(
    auth.context,
    recording.id,
    { artifacts: parsed.data.artifacts },
  );
  if (!artifacts) {
    await failBrowserRecording(auth.context, recording.id, {
      code: "artifact_reservation_failed",
      detail: {},
    });
    return NextResponse.json({ error: "browser_recording_not_reservable" }, { status: 409 });
  }
  return NextResponse.json({ recording, artifacts }, { status: 201 });
}
