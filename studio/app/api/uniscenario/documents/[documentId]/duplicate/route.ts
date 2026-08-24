import { NextResponse } from "next/server";
import { DuplicateScenarioDocumentSchema } from "@/app/lib/scenario/contracts";
import { duplicateScenarioDocument } from "@/app/lib/scenario/document-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutableDocumentContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

export async function POST(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = DuplicateScenarioDocumentSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_duplicate", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;

  // Two separate checks, because a duplicate reads one dataset and writes another: the source only
  // has to be copyable, the destination has to be mutable.
  const source = await requireScenarioMutableDocumentContext(auth.context, documentId, "copy");
  if (source.response) return source.response;
  const targetDatasetId = parsed.data.datasetId ?? source.access.datasetId;
  const target = await requireScenarioMutableContext(
    auth.context,
    targetDatasetId,
    "mutateContent",
  );
  if (target.response) return target.response;

  const result = await duplicateScenarioDocument(auth.context, documentId, {
    ...parsed.data,
    datasetId: targetDatasetId,
  });
  return result.kind === "created"
    ? NextResponse.json(result.document, { status: 201 })
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}
