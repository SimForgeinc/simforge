import { NextResponse } from "next/server";
import { UpdateUniScenarioDatasetSchema } from "@/app/lib/uniscenario/contracts";
import {
  getUniScenarioDataset,
  softDeleteUniScenarioDataset,
  updateUniScenarioDataset,
} from "@/app/lib/uniscenario/dataset-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  requireUniScenarioMutationOrigin,
  uniScenarioJsonWithEtag,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ datasetId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireUniScenarioMutableContext(auth.context, datasetId, "read");
  if (access.response) return access.response;
  const dataset = await getUniScenarioDataset(auth.context, datasetId);
  return dataset
    ? await uniScenarioJsonWithEtag(request, dataset)
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}

export async function PATCH(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireUniScenarioMutableContext(auth.context, datasetId, "updateMetadata");
  if (access.response) return access.response;
  const parsed = UpdateUniScenarioDatasetSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_dataset_update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await updateUniScenarioDataset(auth.context, datasetId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
  }
  if (result.kind === "name_conflict") {
    // v1's "Name (copy)" duplicate flow never had to handle this, because it had no unique index.
    return NextResponse.json(
      { error: "dataset_name_taken", field: "name" },
      { status: 409 },
    );
  }
  return NextResponse.json(result.dataset);
}

export const PUT = PATCH;

export async function DELETE(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireUniScenarioMutableContext(auth.context, datasetId, "delete");
  if (access.response) return access.response;
  const result = await softDeleteUniScenarioDataset(auth.context, datasetId);
  return result.kind === "deleted"
    ? NextResponse.json({ ok: true, deletedDocumentCount: result.deletedDocumentCount })
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}
