import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function ScenarioEditorLoading() {
  return <RouteLoading depth={2} label="Scenario editor" detail="Preparing the editor…" />;
}
