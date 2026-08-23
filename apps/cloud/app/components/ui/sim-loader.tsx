"use client";

import { useMemo } from "react";
import {
  dashboardRouteLoadingSource,
  useDashboardLoadingSource,
} from "@/app/components/DashboardLoadingCoordinator";

export function RouteLoading({
  label,
  detail = "Loading…",
  depth = 1,
}: {
  label: string;
  detail?: string;
  depth?: number;
}) {
  const source = useMemo(
    () => dashboardRouteLoadingSource({ label, detail, depth }),
    [depth, detail, label],
  );
  useDashboardLoadingSource(source);

  return (
    <span aria-hidden="true" data-testid="route-loading-marker">
      <span className="sr-only">Loading {label}</span>
    </span>
  );
}
