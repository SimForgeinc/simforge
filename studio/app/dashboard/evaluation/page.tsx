import { requireAppContext } from "@/app/lib/db/app-context";
import { EvaluationPageClient } from "./EvaluationPageClient";

export default async function EvaluationPage() {
  await requireAppContext("/dashboard/evaluation");
  return <EvaluationPageClient />;
}
