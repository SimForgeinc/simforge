import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import {
  CreateBrowserRecordingSchema,
  ReserveBrowserRecordingArtifactsSchema,
} from "@/app/lib/uniscenario/recording-contracts";
import {
  createBrowserRecording,
  listBrowserRecordings,
  reserveBrowserRecordingArtifacts,
} from "@/app/lib/uniscenario/recording-store";

const QuerySchema = z.strictObject({
  revisionId: z.string().trim().min(1).max(200).nullable(),
  documentId: z.string().trim().min(1).max(200).nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
// ReserveBrowserRecordingArtifactsSchema is a refined schema (no .shape); validate
// the artifact list through the full schema after the envelope parse.
const CreateWithArtifactsSchema = z.strictObject({
  recording: CreateBrowserRecordingSchema,
  artifacts: z.array(z.unknown()).min(1).max(132),
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
  const origin = requireUniScenarioMutationOrigin(request);
  if (origin) return origin;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateWithArtifactsSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_recording_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const declarations = ReserveBrowserRecordingArtifactsSchema.safeParse({
    artifacts: parsed.data.artifacts,
  });
  if (!declarations.success) {
    return NextResponse.json(
      { error: "invalid_recording_artifacts", details: declarations.error.flatten() },
      { status: 400 },
    );
  }
  const recording = await createBrowserRecording(auth.context, parsed.data.recording);
  if (!recording) return NextResponse.json({ error: "recording_source_not_found" }, { status: 404 });
  const artifacts = await reserveBrowserRecordingArtifacts(auth.context, recording.id, declarations.data);
  return artifacts
    ? NextResponse.json({ recording, artifacts }, { status: 201 })
    : NextResponse.json({ error: "recording_artifacts_not_reserved" }, { status: 409 });
}
