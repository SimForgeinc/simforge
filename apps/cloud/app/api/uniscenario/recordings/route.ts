import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import { listBrowserRecordings } from "@/app/lib/uniscenario/recording-store";

const QuerySchema = z.strictObject({
  revisionId: z.string().trim().min(1).max(200).nullable(),
  documentId: z.string().trim().min(1).max(200).nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
