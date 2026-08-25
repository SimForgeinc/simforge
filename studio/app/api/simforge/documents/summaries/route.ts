import { NextResponse } from "next/server";
import { ListScenarioDocumentSummariesSchema } from "@/app/lib/scenario/contracts";
import { listScenarioDocumentSummaries } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  requireScenarioMutableContext,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

/**
 * Cursor-paginated document list.
 *
 * Backed by `listScenarioDocumentSummaries`, which never selects `canonical_content` — see the
 * comment on `DOCUMENT_SUMMARY_SELECT`. The editor's full-document read stays on
 * `/api/uniscenario/documents`.
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const parsed = ListScenarioDocumentSummariesSchema.safeParse({
    datasetId: url.searchParams.get("datasetId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const access = await requireScenarioMutableContext(
    auth.context,
    parsed.data.datasetId,
    "read",
  );
  if (access.response) return access.response;
  const page = await listScenarioDocumentSummaries(auth.context, parsed.data);
  return await scenarioJsonWithEtag(request, page);
}
