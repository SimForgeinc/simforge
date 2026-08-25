"use client";

import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import type { CandidateLocation } from "@simforge/studio-shared";
import { CandidateLocationCard } from "./CandidateLocationCard";

/** Props for the CandidateLocationsSection component. */
type CandidateLocationsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
};

/** Render selectable candidate simulation locations for a map asset. */
export function CandidateLocationsSection({
  open,
  onToggleOpen,
  candidateLocations,
  candidateLocationsLoading,
  selectedCandidateLocationId,
  onSelectCandidateLocationId,
}: CandidateLocationsSectionProps) {
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
          Candidate Locations
          {candidateLocations.length > 0 && (
            <span className="rounded-full bg-orange-950/60 px-1.5 py-px text-[10px] font-semibold text-orange-300">
              {candidateLocations.length}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {candidateLocationsLoading ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </p>
          ) : candidateLocations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No candidate locations computed yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {candidateLocations.map((candidate) => (
                <li key={candidate.id}>
                  <CandidateLocationCard
                    candidate={candidate}
                    selected={selectedCandidateLocationId === candidate.id}
                    onSelect={(id) => onSelectCandidateLocationId?.(id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
