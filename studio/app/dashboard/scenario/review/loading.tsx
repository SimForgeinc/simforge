import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function ScenarioReviewLoading() {
  return <RouteLoading depth={2} label="Review queue" detail="Loading scenarios to review…" />;
}
