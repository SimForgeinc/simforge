"use client";

import { useState, useMemo, useCallback, useEffect, useRef, forwardRef } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import type {
  MapAsset,
  MapAssetEnrichmentSnapshot,
  CandidateLocation,
} from "@simcloud/shared";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { CandidateLocationCard } from "@/app/dashboard/map-assets/map-detail-sections/CandidateLocationCard";
import {
  buildScenarioFamilyGroups,
  humanizeTag,
  getAllCandidateTags,
  assignCandidateToFamily,
  type ScenarioFamilyGroup,
} from "@/app/lib/scenario-intelligence-ui";
import { getFamilyIcon } from "@/app/lib/scenario-family-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/app/components/ui/tooltip";

type ActiveFilter = { type: "family"; id: string } | { type: "tag"; id: string } | null;

interface InsightsTabProps {
  asset: MapAsset;
  runs: ScenarioSummary[];
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
  focusFamilyId?: string | null;
  onClearFocusFamily?: () => void;
}

/** Scenario insights tab showing family groups, candidate locations, and filters. */
export function InsightsTab({
  asset,
  runs: _runs,
  enrichment: _enrichment,
  enrichmentLoading: _enrichmentLoading,
  candidateLocations,
  candidateLocationsLoading,
  selectedCandidateLocationId,
  onSelectCandidateLocationId,
  focusFamilyId,
  onClearFocusFamily,
}: InsightsTabProps) {
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);

  const tags = useMemo(() => asset.tags ?? [], [asset.tags]);
  const familyGroups = useMemo(
    () => buildScenarioFamilyGroups(tags, candidateLocations),
    [tags, candidateLocations],
  );

  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const familyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!focusFamilyId) return;
    setExpandedFamilies((prev) => {
      if (prev.has(focusFamilyId)) return prev;
      return new Set([...prev, focusFamilyId]);
    });
    requestAnimationFrame(() => {
      familyRefs.current.get(focusFamilyId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    onClearFocusFamily?.();
  }, [focusFamilyId, onClearFocusFamily]);

  const toggleFamily = useCallback((id: string) => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sortedCandidates = useMemo(() => {
    return [...candidateLocations].sort((a, b) => {
      if (a.rank != null && b.rank != null) return a.rank - b.rank;
      if (a.rank != null) return -1;
      if (b.rank != null) return 1;
      return b.confidence - a.confidence;
    });
  }, [candidateLocations]);

  const filteredCandidates = useMemo(() => {
    if (!activeFilter) return sortedCandidates;
    if (activeFilter.type === "family") {
      return sortedCandidates.filter((c) => assignCandidateToFamily(c).id === activeFilter.id);
    }
    return sortedCandidates.filter((c) => getAllCandidateTags(c).includes(activeFilter.id));
  }, [sortedCandidates, activeFilter]);

  return (
    <div className="space-y-5">
      {familyGroups.length > 0 && (
        <section>
          <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Scenario Families
          </h3>
          <div className="space-y-2">
            {familyGroups.map((group) => (
              <ScenarioFamilyCard
                key={group.family.id}
                ref={(el) => {
                  if (el) familyRefs.current.set(group.family.id, el);
                  else familyRefs.current.delete(group.family.id);
                }}
                group={group}
                expanded={expandedFamilies.has(group.family.id)}
                onToggle={() => toggleFamily(group.family.id)}
                selectedCandidateLocationId={selectedCandidateLocationId}
                onSelectCandidateLocationId={onSelectCandidateLocationId}
                loading={candidateLocationsLoading}
              />
            ))}
          </div>
        </section>
      )}

      {(candidateLocations.length > 0 || candidateLocationsLoading) && (
        <section>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExplorerOpen((o) => !o)}
              className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={explorerOpen}
            >
              <ChevronRight
                className={cn("size-3 shrink-0 transition-transform duration-150", explorerOpen && "rotate-90")}
              />
              Candidate Locations
              {candidateLocationsLoading ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground">
                  <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
                  <span>Loading…</span>
                </span>
              ) : candidateLocations.length > 0 ? (
                <span className="rounded-full bg-orange-950/60 px-1.5 py-px text-[10px] font-semibold text-orange-300">
                  {activeFilter ? `${filteredCandidates.length}/${candidateLocations.length}` : candidateLocations.length}
                </span>
              ) : null}
            </button>
            {activeFilter && (
              <button
                type="button"
                onClick={() => setActiveFilter(null)}
                className="flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                {activeFilter.type === "family"
                  ? familyGroups.find((g) => g.family.id === activeFilter.id)?.family.name ?? activeFilter.id
                  : humanizeTag(activeFilter.id)}
                <X className="size-2.5" />
              </button>
            )}
          </div>

          {explorerOpen && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1">
                {familyGroups.map((group) => {
                  const isActive = activeFilter?.type === "family" && activeFilter.id === group.family.id;
                  return (
                    <button
                      key={group.family.id}
                      type="button"
                      onClick={() =>
                        setActiveFilter(isActive ? null : { type: "family", id: group.family.id })
                      }
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] border transition-colors",
                        isActive
                          ? "bg-primary/15 text-primary border-primary/30"
                          : "bg-muted/30 text-muted-foreground border-border hover:bg-muted/50",
                      )}
                    >
                      {group.family.name}
                      {!candidateLocationsLoading && (
                        <>
                          {" "}
                          <span className="text-muted-foreground/60">({group.candidates.length})</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>

              {candidateLocationsLoading ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Loading…
                </p>
              ) : filteredCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {activeFilter ? "No candidates match this filter." : "No candidate locations computed yet."}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {filteredCandidates.map((candidate) => (
                    <li key={candidate.id}>
                      <CandidateLocationCard
                        candidate={candidate}
                        selected={selectedCandidateLocationId === candidate.id}
                        onSelect={(id) => onSelectCandidateLocationId?.(id)}
                        family={assignCandidateToFamily(candidate)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

    </div>
  );
}

interface ScenarioFamilyCardProps {
  group: ScenarioFamilyGroup;
  expanded: boolean;
  onToggle: () => void;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
  loading?: boolean;
}

const ScenarioFamilyCard = forwardRef<HTMLDivElement, ScenarioFamilyCardProps>(
  function ScenarioFamilyCard({
    group,
    expanded,
    onToggle,
    selectedCandidateLocationId,
    onSelectCandidateLocationId,
    loading = false,
  }, ref) {
    const Icon = getFamilyIcon(group.family);
    const tagTooltip = group.tags.length > 0
      ? group.tags.map((t) => `${t.display}${t.candidateCount > 0 ? ` (${t.candidateCount})` : ""}`).join("\n")
      : null;

    return (
      <div ref={ref} className="rounded-lg border border-border bg-muted/10">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/20"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <Icon className="size-3.5 text-primary shrink-0" />
          <span className="flex-1 text-xs font-medium text-foreground">{group.family.name}</span>
          {loading ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground">
              <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
              <span>Loading…</span>
            </span>
          ) : (
            <span className="rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground">
              {group.candidates.length} location{group.candidates.length !== 1 ? "s" : ""}
            </span>
          )}
        </button>

        {expanded && (
          <div className="border-t border-border px-3 py-2.5 space-y-2.5">
            {tagTooltip ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="text-left text-[11px] text-muted-foreground leading-relaxed cursor-help underline decoration-dotted underline-offset-2">
                      {group.family.description}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
                    {tagTooltip}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <p className="text-[11px] text-muted-foreground leading-relaxed">{group.family.description}</p>
            )}

            {group.candidates.length > 0 && (
              <ul className="space-y-1.5">
                {group.candidates.map((candidate: CandidateLocation) => (
                  <li key={candidate.id}>
                    <CandidateLocationCard
                      candidate={candidate}
                      selected={selectedCandidateLocationId === candidate.id}
                      onSelect={(id) => onSelectCandidateLocationId?.(id)}
                      compact
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  },
);
