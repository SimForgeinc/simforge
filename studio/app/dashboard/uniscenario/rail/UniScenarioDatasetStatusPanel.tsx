"use client";

import { useMemo } from "react";
import type {
  UniScenarioDatasetReadinessDto,
  UniScenarioDocumentSummaryDto,
} from "@/app/lib/uniscenario/contracts";
import { cn } from "@/app/lib/utils";

type ReadinessSummary = UniScenarioDatasetReadinessDto["summary"];

function CoverageBar({
  label,
  covered,
  total,
}: {
  label: string;
  covered: number;
  total: number;
}) {
  const ratio = total > 0 ? Math.min(1, covered / total) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 font-meta text-micro uppercase tracking-meta-wider">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">
          {covered} / {total}
        </span>
      </div>
      <div
        className="mt-1 h-1 w-full bg-muted"
        role="progressbar"
        aria-label={`${label} coverage`}
        aria-valuenow={covered}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="h-full bg-primary" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * In-editor dataset status: coverage, and who has been working in this dataset.
 *
 * **Two v1 sections are deliberately absent.** v1's panel read `/api/datasets/[id]/activity` for a
 * per-contributor authored/rendered/simulated breakdown and `/render-gallery` for nine trailing render
 * thumbnails. Neither endpoint exists in v2, and inventing one for the gallery would fork the render
 * control plane. The contributor table here is derived from the loaded summaries' `createdByUserName` /
 * `updatedByUserName` instead, so it needs no new endpoint and cannot disagree with the list; the
 * render gallery belongs to the render tab.
 *
 * The counters come from `GET /datasets/[id]/readiness`, whose shape is `{summary, scenarios}` — the
 * same shape v1's `applyDatasetReadiness` consumed.
 */
export function UniScenarioDatasetStatusPanel({
  datasetName,
  readiness,
  documents,
  className,
}: {
  datasetName: string | null;
  readiness: ReadinessSummary | null;
  documents: UniScenarioDocumentSummaryDto[];
  className?: string;
}) {
  const contributors = useMemo(() => {
    const byName = new Map<string, { name: string; authored: number; edited: number }>();
    for (const document of documents) {
      const author = document.createdByUserName?.trim();
      if (author) {
        const entry = byName.get(author) ?? { name: author, authored: 0, edited: 0 };
        entry.authored += 1;
        byName.set(author, entry);
      }
      const editor = document.updatedByUserName?.trim();
      // Only count an edit when somebody other than the author made it; otherwise every document
      // would report one edit by its own author and the column would say nothing.
      if (editor && editor !== author) {
        const entry = byName.get(editor) ?? { name: editor, authored: 0, edited: 0 };
        entry.edited += 1;
        byName.set(editor, entry);
      }
    }
    return [...byName.values()].sort(
      (a, b) => b.authored + b.edited - (a.authored + a.edited) || a.name.localeCompare(b.name),
    );
  }, [documents]);

  const total = readiness?.total ?? documents.length;

  return (
    <div
      className={cn("space-y-4 border border-border bg-surface-raised p-3", className)}
      data-testid="uniscenario-dataset-status"
    >
      <div>
        <p className="font-meta text-micro uppercase tracking-meta-widest text-muted-foreground">
          Dataset status
        </p>
        <p className="truncate text-sm font-semibold text-foreground">{datasetName ?? "Dataset"}</p>
      </div>
      <div className="space-y-2">
        <CoverageBar label="Rendered" covered={readiness?.rendered ?? 0} total={total} />
        <CoverageBar label="Cosmos" covered={readiness?.cosmosed ?? 0} total={total} />
        <CoverageBar label="VLM" covered={readiness?.vlmed ?? 0} total={total} />
      </div>
      <div>
        <p className="font-meta text-micro uppercase tracking-meta-widest text-muted-foreground">
          Contributors
        </p>
        {contributors.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No named contributors yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {contributors.slice(0, 8).map((contributor) => (
              <li
                key={contributor.name}
                className="flex items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-foreground">{contributor.name}</span>
                <span className="shrink-0 font-meta text-micro uppercase tracking-meta text-muted-foreground">
                  {contributor.authored} authored
                  {contributor.edited > 0 ? ` · ${contributor.edited} edited` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
