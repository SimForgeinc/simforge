import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { ScenarioDatasetsClient } from "./ScenarioDatasetsClient";

export default async function ScenarioPage() {
  await connection();
  await requireAppContext("/dashboard/scenario");
  return <ScenarioDatasetsClient />;
}
