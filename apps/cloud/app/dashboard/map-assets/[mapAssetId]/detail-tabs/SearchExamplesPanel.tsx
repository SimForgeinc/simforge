"use client";

import { cn } from "@/app/lib/utils";
import { SEARCH_EXAMPLE_GROUPS, type SearchExample } from "./search-examples";

interface SearchExamplesPanelProps {
  /** Submit a query — usually the page's `onSubmitSearch`. Available-tier
   *  examples call this; coming-soon chips are muted and non-interactive. */
  onRunExample: (query: string) => void;
}

/**
 * Empty-state panel shown below the search input when no query is active.
 * The panel *is* the tutorial: each chip is a one-click demo of a supported
 * query shape. Groups are rendered in roadmap order so `available` rows
 * come first and `coming soon` rows sit below as aspirational teases.
 */
export function SearchExamplesPanel({ onRunExample }: SearchExamplesPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      {SEARCH_EXAMPLE_GROUPS.map((group) => (
        <section key={group.id} className="space-y-2">
          <header className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.title}
            </h3>
            {group.tier === "coming_soon" ? (
              <span className="rounded-sm bg-secondary/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                Coming soon
              </span>
            ) : null}
          </header>
          <div className="flex flex-wrap gap-1.5">
            {group.examples.map((example) => (
              <Chip key={example.label} example={example} onRun={onRunExample} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface ChipProps {
  example: SearchExample;
  onRun: (query: string) => void;
}

function Chip({ example, onRun }: ChipProps) {
  const isAvailable = example.tier === "available";
  return (
    <button
      type="button"
      disabled={!isAvailable}
      onClick={() => isAvailable && onRun(example.query)}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        isAvailable
          ? "border-border bg-secondary/30 text-foreground hover:border-primary/40 hover:bg-primary/10"
          : "cursor-not-allowed border-dashed border-border/60 bg-transparent text-muted-foreground/70",
      )}
      title={isAvailable ? `Run search: ${example.query}` : "Coming in the next release"}
    >
      {example.label}
    </button>
  );
}
