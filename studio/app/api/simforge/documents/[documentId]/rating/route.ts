import { NextResponse } from "next/server";
import { UpsertScenarioDocumentRatingSchema } from "@/app/lib/scenario/contracts";
import {
  deleteScenarioDocumentRating,
  getScenarioRatingAggregate,
  upsertScenarioDocumentRating,
} from "@/app/lib/scenario/rating-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableDocumentContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * Rating a document is review activity, not content authorship, so it is gated on `runDerivedWork`
 * semantics rather than `mutateContent`: a caller who may read a shared dataset may rate what is in
 * it. `read` is therefore the required action — but the origin guard still applies, because this is
 * a cookie-authenticated state change.
 */
export async function PUT(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  const parsed = UpsertScenarioDocumentRatingSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_rating", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const rating = await upsertScenarioDocumentRating(auth.context, documentId, parsed.data);
  if (!rating) {
    return NextResponse.json({ error: "document_revision_or_job_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    rating,
    aggregate: await getScenarioRatingAggregate(auth.context, documentId),
  });
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  const deleted = await deleteScenarioDocumentRating(auth.context, documentId);
  return deleted
    ? NextResponse.json({
        ok: true,
        aggregate: await getScenarioRatingAggregate(auth.context, documentId),
      })
    : NextResponse.json({ error: "document_rating_not_found" }, { status: 404 });
}
