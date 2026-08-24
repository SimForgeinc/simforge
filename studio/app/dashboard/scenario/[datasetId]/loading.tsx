import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function ScenarioDatasetLoading() {
  return <RouteLoading depth={2} label="Scenarios" detail="Loading dataset scenarios…" />;
}
