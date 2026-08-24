import { NextResponse } from "next/server";
import { SetScenarioDocumentTagsSchema } from "@/app/lib/scenario/contracts";
import { setScenarioDocumentTags } from "@/app/lib/scenario/tag-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableDocumentContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * Replace a document's organizational tags.
 *
 * Gated on `mutateContent` even though nothing here touches `canonical_content`: unlike a rating,
 * which is one reviewer's own opinion, a tag is shared metadata on somebody else's document, so a
 * read-only or shared dataset must not be re-labelled from outside.
 */
export async function PUT(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(
    auth.context,
    documentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const parsed = SetScenarioDocumentTagsSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_tags", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await setScenarioDocumentTags(auth.context, documentId, parsed.data.tagIds);
  return result.kind === "ok"
    ? NextResponse.json({ tags: result.tags })
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}
