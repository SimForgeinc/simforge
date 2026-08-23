import { NextResponse } from "next/server";
import { ListUniScenarioDocumentSummariesSchema } from "@/app/lib/uniscenario/contracts";
import { listUniScenarioDocumentSummaries } from "@/app/lib/uniscenario/document-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  uniScenarioJsonWithEtag,
} from "@/app/lib/uniscenario/http";

/**
 * Cursor-paginated document list.
 *
 * Backed by `listUniScenarioDocumentSummaries`, which never selects `canonical_content` — see the
 * comment on `DOCUMENT_SUMMARY_SELECT`. The editor's full-document read stays on
 * `/api/uniscenario/documents`.
 */
export async function GET(request: Request) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const parsed = ListUniScenarioDocumentSummariesSchema.safeParse({
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
  const access = await requireUniScenarioMutableContext(
    auth.context,
    parsed.data.datasetId,
    "read",
  );
  if (access.response) return access.response;
  const page = await listUniScenarioDocumentSummaries(auth.context, parsed.data);
  return await uniScenarioJsonWithEtag(request, page);
}
