import { NextResponse } from "next/server";
import { UpsertUniScenarioDocumentRatingSchema } from "@/app/lib/uniscenario/contracts";
import {
  deleteUniScenarioDocumentRating,
  getUniScenarioRatingAggregate,
  upsertUniScenarioDocumentRating,
} from "@/app/lib/uniscenario/rating-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableDocumentContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * Rating a document is review activity, not content authorship, so it is gated on `runDerivedWork`
 * semantics rather than `mutateContent`: a caller who may read a shared dataset may rate what is in
 * it. `read` is therefore the required action — but the origin guard still applies, because this is
 * a cookie-authenticated state change.
 */
export async function PUT(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireUniScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  const parsed = UpsertUniScenarioDocumentRatingSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_rating", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const rating = await upsertUniScenarioDocumentRating(auth.context, documentId, parsed.data);
  if (!rating) {
    return NextResponse.json({ error: "document_revision_or_job_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    rating,
    aggregate: await getUniScenarioRatingAggregate(auth.context, documentId),
  });
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireUniScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  const deleted = await deleteUniScenarioDocumentRating(auth.context, documentId);
  return deleted
    ? NextResponse.json({
        ok: true,
        aggregate: await getUniScenarioRatingAggregate(auth.context, documentId),
      })
    : NextResponse.json({ error: "document_rating_not_found" }, { status: 404 });
}
