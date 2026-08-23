import { NextResponse } from "next/server";
import { SetUniScenarioDocumentTagsSchema } from "@/app/lib/uniscenario/contracts";
import { setUniScenarioDocumentTags } from "@/app/lib/uniscenario/tag-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableDocumentContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * Replace a document's organizational tags.
 *
 * Gated on `mutateContent` even though nothing here touches `canonical_content`: unlike a rating,
 * which is one reviewer's own opinion, a tag is shared metadata on somebody else's document, so a
 * read-only or shared dataset must not be re-labelled from outside.
 */
export async function PUT(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireUniScenarioMutableDocumentContext(
    auth.context,
    documentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const parsed = SetUniScenarioDocumentTagsSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_tags", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await setUniScenarioDocumentTags(auth.context, documentId, parsed.data.tagIds);
  return result.kind === "ok"
    ? NextResponse.json({ tags: result.tags })
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}
