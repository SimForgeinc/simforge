import { NextResponse } from "next/server";
import {
  CreateUniScenarioRevisionSchema,
  type CreateUniScenarioRevisionResultDto,
  type UniScenarioConflictDto,
} from "@/app/lib/uniscenario/contracts";
import {
  createUniScenarioRevision,
  listUniScenarioRevisions,
} from "@/app/lib/uniscenario/document-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableDocumentContext,
  requireUniScenarioMutationOrigin,
  uniScenarioJsonWithEtag,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  return await uniScenarioJsonWithEtag(request, {
    revisions: await listUniScenarioRevisions(auth.context, documentId),
  });
}

export async function POST(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateUniScenarioRevisionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_revision", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;
  // Cutting a revision advances documents.latest_revision_id, so this is a content mutation.
  const access = await requireUniScenarioMutableDocumentContext(
    auth.context,
    documentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const result = await createUniScenarioRevision(auth.context, documentId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }
  if (result.kind === "conflict") {
    const body: UniScenarioConflictDto = {
      error: "draft_version_conflict",
      refetch: true,
      currentDraftVersion: result.current.draftVersion,
      current: result.current,
    };
    return NextResponse.json(body, { status: 409 });
  }
  const body: CreateUniScenarioRevisionResultDto = {
    revisionId: result.revision.id,
    exportId: result.revision.export.id,
    exportStatus: result.revision.export.status,
    revision: result.revision,
  };
  return NextResponse.json(body, { status: 201 });
}
