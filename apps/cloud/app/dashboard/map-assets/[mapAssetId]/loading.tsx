import { RouteLoading } from "@/app/components/ui/sim-loader";

export default function MapDetailLoading() {
  return <RouteLoading depth={2} label="Map" detail="Loading map details…" />;
}
