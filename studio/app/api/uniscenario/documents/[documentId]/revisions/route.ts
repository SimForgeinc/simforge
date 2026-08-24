import { NextResponse } from "next/server";
import {
  CreateScenarioRevisionSchema,
  type CreateScenarioRevisionResultDto,
  type ScenarioConflictDto,
} from "@/app/lib/scenario/contracts";
import {
  createScenarioRevision,
  listScenarioRevisions,
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
  return await scenarioJsonWithEtag(request, {
    revisions: await listScenarioRevisions(auth.context, documentId),
  });
}

export async function POST(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioRevisionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_revision", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;
  // Cutting a revision advances documents.latest_revision_id, so this is a content mutation.
  const access = await requireScenarioMutableDocumentContext(
    auth.context,
    documentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const result = await createScenarioRevision(auth.context, documentId, parsed.data);
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
  const body: CreateScenarioRevisionResultDto = {
    revisionId: result.revision.id,
    exportId: result.revision.export.id,
    exportStatus: result.revision.export.status,
    revision: result.revision,
  };
  return NextResponse.json(body, { status: 201 });
}
