import { requireAppContext } from "@/app/lib/db/app-context";
import { connection } from "next/server";
import { redirect } from "next/navigation";

/** Deep-link compatibility only: the canonical editor is `/dashboard/uniscenario?dataset&document`. */
export default async function UniScenarioEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ datasetId?: string; documentId?: string }>;
}) {
  await connection();
  await requireAppContext("/dashboard/uniscenario/editor");
  const { datasetId, documentId } = await searchParams;
  const query = new URLSearchParams();
  if (datasetId) query.set("dataset", datasetId);
  if (datasetId && documentId) query.set("document", documentId);
  redirect(`/dashboard/uniscenario${query.size ? `?${query}` : ""}`);
}
