import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";

export default async function ScenarioDatasetPage({
  params,
}: {
  params: Promise<{ datasetId: string }>;
}) {
  const { datasetId } = await params;
  await connection();
  await requireAppContext(`/dashboard/scenario/${datasetId}`);
  const query = new URLSearchParams({ dataset: datasetId });
  redirect(`/dashboard/scenario?${query}`);
}
