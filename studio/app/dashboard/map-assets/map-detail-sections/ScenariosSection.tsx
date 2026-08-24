"use client";

import { ChevronRight, SquarePen } from "lucide-react";
import Link from "next/link";
import { ScenarioStatusBadge } from "@/app/components/ScenarioStatusBadge";
import { formatRelativeTime } from "@/app/lib/media-utils";
import { cn } from "@/app/lib/utils";
import { buildDashboardScenarioEditorHref } from "@/app/lib/scenario/routes";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import type { ScenarioSummary } from "@/app/lib/scenarios";

/** Props for the ScenariosSection component. */
type ScenariosSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  scenarios: ScenarioSummary[];
  variant: "view" | "select-for-simulation";
  mapName?: string | null;
};

/** Display related scenarios for a map asset with links and status badges. */
export function ScenariosSection({
  open,
  onToggleOpen,
  scenarios,
  variant,
  mapName,
}: ScenariosSectionProps) {
  const primaryEditorHref =
    variant === "view" && scenarios.length > 0
      ? buildDashboardScenarioEditorHref({ scenarioId: scenarios[0]!.id, mapName })
      : null;

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
          Scenarios ({scenarios.length})
        </button>
        {primaryEditorHref && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={primaryEditorHref}
                  className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground"
                  aria-label="Open latest scenario in editor"
                >
                  <SquarePen className="size-3" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Open latest scenario in editor
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open &&
        (scenarios.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No scenarios yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {scenarios.map((scenario) => (
              <li
                key={scenario.id}
                className="flex items-center justify-between gap-2 rounded border border-border p-2"
              >
                <div className="min-w-0">
                  <Link
                    href={buildDashboardScenarioEditorHref({
                      scenarioId: scenario.id,
                      mapName,
                    })}
                    className="block truncate text-xs font-medium hover:underline"
                  >
                    {scenario.displayName}
                  </Link>
                  <span
                    className="text-xs text-muted-foreground"
                    title={new Date(scenario.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  >
                    {formatRelativeTime(scenario.createdAt)}
                  </span>
                </div>
                <ScenarioStatusBadge status={scenario.status} />
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
