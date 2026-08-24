import { requireAppContext } from "@/app/lib/db/app-context";
import { connection } from "next/server";
import { redirect } from "next/navigation";

/** Deep-link compatibility only: the canonical editor is `/dashboard/scenario?dataset&document`. */
export default async function ScenarioEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ datasetId?: string; documentId?: string }>;
}) {
  await connection();
  await requireAppContext("/dashboard/scenario/editor");
  const { datasetId, documentId } = await searchParams;
  const query = new URLSearchParams();
  if (datasetId) query.set("dataset", datasetId);
  if (datasetId && documentId) query.set("document", documentId);
  redirect(`/dashboard/scenario${query.size ? `?${query}` : ""}`);
}
