"use client";

import { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { SearchResultsTab } from "./SearchResultsTab";
import { AiSearchPanel } from "./AiSearchPanel";
import type { ComponentProps } from "react";
import type { UseMapSearchLlmResult } from "@/app/lib/maps/frontend/use-map-search-llm";
import type { ScenarioValidationState } from "@/app/lib/maps/frontend/use-scenario-validation";

export type SearchPanelMode = "keyword" | "ai";

interface SearchPanelTabsProps {
  /** Initial active tab. Defaults to keyword search. */
  initialMode?: SearchPanelMode;
  /** Props forwarded to the underlying keyword search panel. */
  keyword: ComponentProps<typeof SearchResultsTab>;
  /** State for the LLM-driven search panel. */
  ai: {
    search: UseMapSearchLlmResult;
    selectedResultId: string | null;
    highlightedRelatedObjectId?: string | null;
    onSelectResult: (id: string) => void;
    onZoomToResult: (id: string) => void;
    onUseInScenario: (id: string) => void;
    onHoverResult?: (id: string | null) => void;
    onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
    /** Currently-highlighted scenario draft id (single-select). Drives the
     *  selected-state ring on the matching draft card AND the trajectory /
     *  spawn-marker / collision-X overlays on the 2D + 3D map. */
    selectedScenarioId: string | null;
    /** Toggle handler for the draft cards. Same id again → deselect; new
     *  id → swap selection. */
    onSelectScenario: (scenarioId: string) => void;
    /** esmini validation state for the highlighted scenario, forwarded to the
     *  AI panel's verdict card. */
    validation?: ScenarioValidationState | null;
  };
}

/**
 * Two-tab wrapper that lives at the top of the left search panel:
 *
 *   [ Search ]  [ ✨ AI Search · Experimental ]
 *
 * Keyword search is the default. The AI tab is gated by an "Experimental"
 * badge so users know it's a preview surface. Mode state is local — it
 * doesn't need to survive page reloads at this stage; switching tabs simply
 * remounts the panel below.
 */
export function SearchPanelTabs({
  initialMode = "keyword",
  keyword,
  ai,
}: SearchPanelTabsProps) {
  const [mode, setMode] = useState<SearchPanelMode>(initialMode);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Search panel mode"
        className="flex shrink-0 items-stretch border-b border-border bg-background"
      >
        <TabButton
          label="Search"
          icon={<Search className="size-3.5" aria-hidden="true" />}
          active={mode === "keyword"}
          onClick={() => setMode("keyword")}
        />
        <TabButton
          label="AI Search"
          icon={<Sparkles className="size-3.5" aria-hidden="true" />}
          active={mode === "ai"}
          experimental
          onClick={() => setMode("ai")}
        />
      </div>
      <div className="min-h-0 flex-1">
        {mode === "keyword" ? (
          <SearchResultsTab {...keyword} />
        ) : (
          <AiSearchPanel
            search={ai.search}
            selectedResultId={ai.selectedResultId}
            highlightedRelatedObjectId={ai.highlightedRelatedObjectId}
            onSelectResult={ai.onSelectResult}
            onZoomToResult={ai.onZoomToResult}
            onUseInScenario={ai.onUseInScenario}
            onHoverResult={ai.onHoverResult}
            onToggleHighlightRelated={ai.onToggleHighlightRelated}
            selectedScenarioId={ai.selectedScenarioId}
            onSelectScenario={ai.onSelectScenario}
            validation={ai.validation}
            autoFocus
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
  experimental = false,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  experimental?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      {experimental ? (
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[9px] uppercase tracking-wider text-amber-300">
          Experimental
        </span>
      ) : null}
      {active ? (
        <span
          className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-primary"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}
