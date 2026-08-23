"use client";

import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";

interface ScenariosTabProps {
  templateScenarios: MapTemplateScenarioRow[];
  onCreateBlankScenario?: () => void;
  createBlankBusy?: boolean;
  onUseTemplate?: (templateScenarioId: string) => void;
  templateCreateId?: string | null;
}

export function ScenariosTab({
  templateScenarios,
  onCreateBlankScenario,
  createBlankBusy = false,
  onUseTemplate,
  templateCreateId = null,
}: ScenariosTabProps) {
  return (
    <div className="space-y-3">
      <section className="rounded border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-medium text-foreground">
              New Scenario
            </h3>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Starts from this map in your default dataset.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreateBlankScenario}
            disabled={!onCreateBlankScenario || createBlankBusy}
            className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {createBlankBusy ? "Creating..." : "Create Scenario"}
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Template Scenarios
        </h3>
        {templateScenarios.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No template scenarios for this map yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {templateScenarios.map((scenario) => {
              const actorCount = scenario.actor_count ?? 0;
              const busy = templateCreateId === scenario.id;
              return (
                <li
                  key={scenario.id}
                  className="flex items-center justify-between gap-3 rounded border border-border p-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {scenario.display_name ?? "Untitled Template"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {actorCount} actor{actorCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUseTemplate?.(scenario.id)}
                    disabled={busy}
                    className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? "Creating..." : "Use Template"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
