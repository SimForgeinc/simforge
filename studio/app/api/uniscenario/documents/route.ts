import { connection, NextResponse } from "next/server";
import { CreateScenarioDocumentSchema } from "@/app/lib/scenario/contracts";
import {
  createScenarioDocument,
  listScenarioDocuments,
} from "@/app/lib/scenario/document-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutationOrigin,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const datasetId = new URL(request.url).searchParams.get("datasetId");
  return await scenarioJsonWithEtag(request, {
    documents: await listScenarioDocuments(auth.context, 50, datasetId),
  });
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioDocumentSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // §5.7 FINDING A: creating a document mutates the dataset's contents, so the caller must be
  // allowed to mutate that dataset — not merely be a member of some workspace.
  const access = await requireScenarioMutableContext(
    auth.context,
    parsed.data.datasetId,
    "mutateContent",
  );
  if (access.response) return access.response;
  const document = await createScenarioDocument(auth.context, parsed.data);
  return NextResponse.json(document, { status: 201 });
}
