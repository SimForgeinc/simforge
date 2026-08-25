"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/app/components/ui/tooltip";
import { cn } from "@/app/lib/utils";
import type { CandidateLocation } from "@simforge/studio-shared";
import {
  humanizeTag,
  getAllCandidateTags,
  buildCompactEvidence,
  buildTooltipDetail,
  type ScenarioFamily,
} from "@/app/lib/scenario-intelligence-ui";

const MAX_VISIBLE_TAGS = 3;

interface CandidateLocationCardProps {
  candidate: CandidateLocation;
  selected: boolean;
  onSelect: (id: string | null) => void;
  family?: ScenarioFamily;
  compact?: boolean;
}

/** Selectable candidate location card with label, confidence, tags, and evidence. */
export function CandidateLocationCard({
  candidate,
  selected,
  onSelect,
  family,
  compact: _compact = false,
}: CandidateLocationCardProps) {
  const allTags = getAllCandidateTags(candidate);
  const visibleTags = allTags.slice(0, MAX_VISIBLE_TAGS);
  const overflowCount = allTags.length - MAX_VISIBLE_TAGS;
  const evidence = buildCompactEvidence(candidate);
  const tooltipText = buildTooltipDetail(candidate);
  const explanation = candidate.evidence[0]?.explanation ?? "";

  return (
    <TooltipProvider delayDuration={300}>
    <Tooltip>
    <TooltipTrigger asChild>
    <button
      type="button"
      onClick={() => onSelect(selected ? null : candidate.id)}
      className={cn(
        "w-full rounded border px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-orange-400/70 bg-orange-500/10"
          : "border-border bg-muted/20 hover:bg-muted/40",
      )}
    >
      {/* Row 1: Label + confidence */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-foreground">{candidate.label}</p>
        <span
          className={cn(
            "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium",
            candidate.confidence >= 0.9
              ? "bg-emerald-950/40 text-emerald-400 border border-emerald-700/40"
              : candidate.confidence >= 0.75
                ? "bg-blue-950/40 text-blue-400 border border-blue-700/40"
                : "bg-muted text-muted-foreground border border-border",
          )}
        >
          {Math.round(candidate.confidence * 100)}%
        </span>
      </div>

      {/* Row 2: One-line explanation */}
      {explanation && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground/70">{explanation}</p>
      )}

      {/* Row 3: Family chip + tag chips */}
      {(family || visibleTags.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {family && (
            <span className="rounded-full bg-muted/60 px-2 py-px text-[10px] font-medium text-muted-foreground border border-border">
              {family.name}
            </span>
          )}
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-border bg-muted/40 px-1 py-px text-[10px] text-muted-foreground"
            >
              {humanizeTag(tag)}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="px-1 text-[10px] text-muted-foreground/60">
              +{overflowCount}
            </span>
          )}
        </div>
      )}

      {/* Row 4: Compact evidence */}
      {evidence && (
        <p className="mt-0.5 text-[10px] text-muted-foreground/50">{evidence}</p>
      )}
    </button>
    </TooltipTrigger>
    {tooltipText && (
      <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
        {tooltipText}
      </TooltipContent>
    )}
    </Tooltip>
    </TooltipProvider>
  );
}
