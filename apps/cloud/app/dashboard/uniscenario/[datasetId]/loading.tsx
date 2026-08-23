import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function UniScenarioDatasetLoading() {
  return <RouteLoading depth={2} label="Scenarios" detail="Loading dataset scenarios…" />;
}
