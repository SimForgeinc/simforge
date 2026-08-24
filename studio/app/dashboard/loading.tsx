import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function DashboardLoading() {
  return <RouteLoading depth={0} label="Dashboard" detail="Loading your workspace…" />;
}
