import { connection, NextResponse } from "next/server";
import { CreateUniScenarioDatasetSchema } from "@/app/lib/uniscenario/contracts";
import { createUniScenarioDataset, listUniScenarioDatasets } from "@/app/lib/uniscenario/dataset-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  uniScenarioJsonWithEtag,
} from "@/app/lib/uniscenario/http";

/**
 * The dataset list.
 *
 * Revalidated rather than `no-store`: `UniScenarioDatasetDto` is names, counts
 * and timestamps — it carries no URL field at all, so the §2.5 presigned-URL
 * rule does not apply. This is the first request the editor makes and the
 * largest JSON body on the boot path, and an unchanged list now costs a 304
 * instead of the whole thing.
 */
export async function GET(request: Request) {
  await connection();
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  return await uniScenarioJsonWithEtag(request, {
    datasets: await listUniScenarioDatasets(auth.context),
  });
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateUniScenarioDatasetSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_dataset", details: parsed.error.flatten() }, { status: 400 });
  const result = await createUniScenarioDataset(auth.context, parsed.data);
  if (result.kind === "name_conflict") {
    return NextResponse.json({ error: "dataset_name_taken", field: "name" }, { status: 409 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
  }
  return NextResponse.json(result.dataset, { status: 201 });
}
