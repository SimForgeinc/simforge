"use client";

import { ChevronRight, Check, Copy } from "lucide-react";
import type { CandidateLocation, MapStats } from "@simforge-oss/studio-shared";
import { MapStatsDisplay } from "./MapStatsDisplay";
import { cn } from "@/app/lib/utils";

/** Props for the MapStatisticsSection component. */
type MapStatisticsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  mapStats: MapStats | null;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  candidateLocations?: CandidateLocation[];
};

/** Display collapsible map statistics section with copy-to-clipboard support. */
export function MapStatisticsSection({
  open,
  onToggleOpen,
  mapStats,
  copiedKey,
  onCopy,
  candidateLocations,
}: MapStatisticsSectionProps) {
  return (
    <section>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
          Map Statistics
        </button>
        {mapStats != null && (
          <button
            type="button"
            onClick={() =>
              onCopy(JSON.stringify(mapStats, null, 2), "mapStats")
            }
            aria-label="Copy map statistics as JSON"
            title="Copy map statistics as JSON"
            className="shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
          >
            {copiedKey === "mapStats" ? (
              <Check className="size-3 text-green-400" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        )}
      </div>
      {open &&
        (mapStats != null ? (
          <div className="mt-2">
            <MapStatsDisplay stats={mapStats} candidateLocations={candidateLocations} />
          </div>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            No statistics yet. They appear here after map metadata has been computed (requires geojson, xodr, and
            rrdata_xml on the asset).
          </p>
        ))}
    </section>
  );
}
