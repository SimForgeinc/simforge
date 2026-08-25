"use client";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { cn } from "@/app/lib/utils";
import type { MapAssetEnrichmentSnapshot } from "@simforge/studio-shared";

type EnrichmentSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  showEnrich: boolean;
  enrichBusy: boolean;
  enrichErr: string | null;
  onEnrich: () => void;
};

/** Display third-party Overture enrichment snapshot and trigger enrichment
 *  runs. The parent enqueues the job and polls /enrichment/status,
 *  reflecting progress through the busy + error props. Standalone
 *  street-name resolution is now a header-level action (see
 *  MapDetailHeader). */
export function EnrichmentSection({
  open,
  onToggleOpen,
  enrichment,
  enrichmentLoading,
  showEnrich,
  enrichBusy,
  enrichErr,
  onEnrich,
}: EnrichmentSectionProps) {
  const attribution = enrichment?.summary?.attribution;
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
          Third-Party Enrichment
        </button>
        {showEnrich && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onEnrich}
                  disabled={enrichBusy}
                  className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  aria-label="Run 3rd-party enrichment"
                >
                  {enrichBusy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Sparkles className="size-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {enrichment ? "Re-run 3rd-party enrichment (replaces existing)" : "Run 3rd-party enrichment (1–2 min)"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-3">
          {enrichmentLoading && (
            <p className="text-xs text-muted-foreground">Loading saved snapshot…</p>
          )}
          {!enrichmentLoading && !enrichment && (
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                No enrichment snapshot yet. Run 3rd-party enrichment to pull bus stops,
                schools, hospitals, and named road segments for this map.
              </p>
              {showEnrich && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={enrichBusy}
                  onClick={onEnrich}
                >
                  {enrichBusy ? (
                    <>
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      Enriching… (1–2 min)
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 size-3.5" />
                      Run 3rd-party enrichment
                    </>
                  )}
                </Button>
              )}
              {enrichErr && <p className="text-xs text-destructive">{enrichErr}</p>}
            </div>
          )}
          {enrichment && (
            <>
              <p className="text-xs text-muted-foreground">
                Enrichment data loaded. See <span className="text-foreground/80">Map Provenance</span> for source details.
              </p>
              {enrichErr && <p className="mt-1.5 text-xs text-destructive">{enrichErr}</p>}
              {attribution && (
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {attribution}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
