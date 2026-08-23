"use client";

import { Loader2 } from "lucide-react";
import type {
  CandidateLocation,
  MapAsset,
  MapAssetEnrichmentSnapshot,
} from "@simcloud/shared";
import type { ThreeDStats as ThreeDStatsResponse } from "@/app/lib/3d-manifest-stats";
import type { ViewMode } from "../MapDetailHeader";
import { MapStatsDisplay } from "@/app/dashboard/map-assets/map-detail-sections/MapStatsDisplay";
import { DigitalTwinStatsDisplay } from "@/app/dashboard/map-assets/map-detail-sections/DigitalTwinStatsDisplay";

interface AnalyticsTabProps {
  asset: MapAsset;
  viewMode?: ViewMode;
  threeDStats?: ThreeDStatsResponse | null;
  threeDStatsLoading?: boolean;
  candidateLocations?: CandidateLocation[];
  /** Dedup'd count of Overture crosswalks not covered by in-house data (≥0). */
  overtureCrosswalkSurvivors?: number;
  /** Enrichment snapshot — drives the Third-party data section in MapStatsDisplay. */
  enrichment?: MapAssetEnrichmentSnapshot | null;
}

export function AnalyticsTab({
  asset,
  viewMode = "2d",
  threeDStats,
  threeDStatsLoading,
  candidateLocations,
  overtureCrosswalkSurvivors,
  enrichment,
}: AnalyticsTabProps) {
  // 3D mode: show digital twin analytics
  if (viewMode === "3d") {
    if (threeDStatsLoading) {
      return (
        <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
          <Loader2 className="size-5 text-muted-foreground animate-spin" aria-hidden="true" />
          <span className="sr-only">Loading 3D statistics</span>
        </div>
      );
    }

    if (!threeDStats) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground"
            >
              <path d="M3 3v18h18" />
              <path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </div>
          <p className="text-sm font-medium text-foreground">No 3D statistics available</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-[240px]">
            Upload 3D digital twin assets to see scene analytics.
          </p>
        </div>
      );
    }

    return (
      <div>
        <DigitalTwinStatsDisplay stats={threeDStats} />
      </div>
    );
  }

  // 2D mode: existing road network stats
  const mapStats = asset.map_stats ?? null;

  if (!mapStats) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 mb-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground"
          >
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-3 3" />
          </svg>
        </div>
        <p className="text-sm font-medium text-foreground">No statistics available</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-[240px]">
          Run &quot;Re-extract Metadata&quot; from the actions menu to compute map statistics.
        </p>
      </div>
    );
  }

  return (
    <div>
      <MapStatsDisplay
        stats={mapStats}
        candidateLocations={candidateLocations}
        overtureCrosswalkSurvivors={overtureCrosswalkSurvivors}
        enrichment={enrichment}
      />
    </div>
  );
}
