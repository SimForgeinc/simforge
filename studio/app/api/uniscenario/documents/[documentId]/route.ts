import { NextResponse } from "next/server";
import {
  type ScenarioConflictDto,
  UpdateScenarioDocumentSchema,
} from "@/app/lib/scenario/contracts";
import {
  getScenarioDocument,
  softDeleteScenarioDocument,
  updateScenarioDocument,
} from "@/app/lib/scenario/document-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableDocumentContext,
  requireScenarioMutationOrigin,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const document = await getScenarioDocument(auth.context, documentId);
  return document
    ? await scenarioJsonWithEtag(request, document)
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}

export async function PATCH(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId: gatedDocumentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(
    auth.context,
    gatedDocumentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const parsed = UpdateScenarioDocumentSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;
  const result = await updateScenarioDocument(auth.context, documentId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }
  if (result.kind === "conflict") {
    const body: ScenarioConflictDto = {
      error: "draft_version_conflict",
      refetch: true,
      currentDraftVersion: result.current.draftVersion,
      current: result.current,
    };
    return NextResponse.json(body, { status: 409 });
  }
  return NextResponse.json(result.document);
}

export const PUT = PATCH;

export async function DELETE(request: Request, route: Context) {
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
  const deleted = await softDeleteScenarioDocument(auth.context, documentId);
  return deleted
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}
