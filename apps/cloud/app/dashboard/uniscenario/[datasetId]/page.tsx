import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";

export default async function UniScenarioDatasetPage({
  params,
}: {
  params: Promise<{ datasetId: string }>;
}) {
  const { datasetId } = await params;
  await connection();
  await requireAppContext(`/dashboard/uniscenario/${datasetId}`);
  const query = new URLSearchParams({ dataset: datasetId });
  redirect(`/dashboard/uniscenario?${query}`);
}
