import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { UniScenarioDatasetsClient } from "./UniScenarioDatasetsClient";

export default async function UniScenarioPage() {
  await connection();
  await requireAppContext("/dashboard/uniscenario");
  return <UniScenarioDatasetsClient />;
}
