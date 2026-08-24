import { connection, NextResponse } from "next/server";
import { CreateUniScenarioDocumentSchema } from "@/app/lib/uniscenario/contracts";
import {
  createUniScenarioDocument,
  listUniScenarioDocuments,
} from "@/app/lib/uniscenario/document-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  requireUniScenarioMutationOrigin,
  uniScenarioJsonWithEtag,
} from "@/app/lib/uniscenario/http";

export async function GET(request: Request) {
  await connection();
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const datasetId = new URL(request.url).searchParams.get("datasetId");
  return await uniScenarioJsonWithEtag(request, {
    documents: await listUniScenarioDocuments(auth.context, 50, datasetId),
  });
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateUniScenarioDocumentSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // §5.7 FINDING A: creating a document mutates the dataset's contents, so the caller must be
  // allowed to mutate that dataset — not merely be a member of some workspace.
  const access = await requireUniScenarioMutableContext(
    auth.context,
    parsed.data.datasetId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const document = await createUniScenarioDocument(auth.context, parsed.data);
  return NextResponse.json(document, { status: 201 });
}
