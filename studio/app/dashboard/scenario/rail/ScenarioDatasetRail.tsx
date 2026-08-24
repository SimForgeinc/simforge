"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ClipboardCheck,
  Layers,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import type { ScenarioDatasetDto } from "@/app/lib/scenario/contracts";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

/**
 * The dataset list inside the datasets workspace's shared floating sidebar.
 *
 * ## Design
 *
 * The rail owns its label, count, filter, review queue, and create action. These controls describe and
 * affect only this list, so keeping them in its header makes the workspace legible without scanning the
 * global application bar.
 *
 * Rows carry a 2px left accent rather than a fill or a border colour change. A dataset row is two lines
 * of text at two weights; recolouring its whole surface on hover makes the text move around in your
 * peripheral vision, while a spine lights up cleanly and reads at a glance down a long list.
 *
 * Templates are a labelled group at the bottom instead of the toggle the old table had. A toggle hides
 * the answer to "why is my dataset not here?" behind a control you have to know about; a group that is
 * always visible, always last, cannot do that.
 *
 * Its host owns the dimensions so this list and the scenario list remain exactly the same size.
 */
export function ScenarioDatasetRail({
  datasets,
  loading,
  error,
  creating,
  busyDatasetId,
  activeDatasetId = null,
  onSelectDataset,
  onPrefetchDataset,
  onOpenNewDatasetDialog,
  onEditDatasetDetails,
  onDeleteDataset,
}: {
  datasets: ScenarioDatasetDto[];
  loading: boolean;
  error: string | null;
  creating: boolean;
  busyDatasetId: string | null;
  /** Highlighted row, when the rail is showing which dataset the scene belongs to. */
  activeDatasetId?: string | null;
  onSelectDataset: (datasetId: string) => void;
  onPrefetchDataset?: (datasetId: string) => void;
  onOpenNewDatasetDialog: () => void;
  onEditDatasetDetails?: (dataset: ScenarioDatasetDto) => void;
  onDeleteDataset?: (dataset: ScenarioDatasetDto) => void;
}) {
  const [query, setQuery] = useState("");

  const { owned, templates, matched } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? datasets.filter(
          (dataset) =>
            dataset.name.toLowerCase().includes(needle) ||
            (dataset.description ?? "").toLowerCase().includes(needle),
        )
      : datasets;
    return {
      owned: visible.filter((dataset) => !dataset.isSystemManaged),
      templates: visible.filter((dataset) => dataset.isSystemManaged),
      matched: visible.length,
    };
  }, [datasets, query]);

  const searching = query.trim().length > 0;

  return (
    <aside
      className="pointer-events-auto flex h-full w-full min-w-0 flex-col bg-transparent"
      data-testid="scenario-dataset-rail"
      aria-label="Datasets"
    >
      <header className="border-b border-white/15 px-3 pt-3">
        <div
          className="flex min-w-0 items-center justify-between gap-2"
          data-testid="scenario-dataset-header"
        >
          <h2 className="flex min-w-0 items-center gap-1.5 font-meta text-micro font-bold uppercase tracking-meta-wider text-foreground">
            <Layers className="size-3 shrink-0" aria-hidden="true" />
            Datasets &amp; Scenarios
            {/* The count reflects what is on screen, so a search that hides rows explains itself. */}
            <span
              className="tabular-nums font-normal text-white/70"
              aria-hidden="true"
            >
              {searching
                ? `${matched}/${datasets.length}`
                : datasets.length || ""}
            </span>
          </h2>
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 rounded-none bg-transparent hover:bg-transparent hover:text-primary"
            title="Review queue"
          >
            <Link
              href="/dashboard/scenario/review"
              aria-label="Review queue"
            >
              <ClipboardCheck className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="relative mt-3 border-t border-white/10">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/70"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter datasets"
            aria-label="Filter datasets"
            className="h-10 w-full border-0 border-b border-transparent bg-transparent pl-8 pr-7 font-meta text-micro text-white placeholder:text-white/65 focus-visible:border-primary/70 focus-visible:outline-none"
          />
          {searching ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={creating}
          className="h-10 w-full justify-center gap-1.5 rounded-none border-0 border-t border-white/10 bg-[#E8E044] px-0 font-meta text-micro font-bold uppercase tracking-meta text-black hover:bg-[#f1e949] hover:text-black"
          data-testid="scenario-new-dataset"
          onClick={onOpenNewDatasetDialog}
        >
          {creating ? (
            <CloudActivityIndicator />
          ) : (
            <Plus className="size-3" aria-hidden="true" />
          )}
          New dataset
        </Button>
      </header>

      <div className="scenario-glass-scrollbar min-h-0 flex-1 overflow-y-auto px-3">
        {error ? (
          <p
            className="mb-1 border-b border-destructive/40 px-2 py-2 text-meta text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {loading && datasets.length === 0 ? (
          <WorkspacePaneLoading
            className="min-h-52"
            hint="Reading this workspace."
            message="Loading datasets"
          />
        ) : datasets.length === 0 ? (
          <div className="px-1.5 py-6 text-center">
            <p className="text-meta text-white/75">No datasets yet.</p>
            <p className="mt-1 font-meta text-micro uppercase tracking-meta text-white/60">
              A dataset holds your scenarios
            </p>
          </div>
        ) : matched === 0 ? (
          // Distinct from "no datasets": the fix is to change the filter, not to create anything.
          <p className="px-1.5 py-6 text-center text-meta text-white/75">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          <>
            <RailGroup
              datasets={owned}
              activeDatasetId={activeDatasetId}
              busyDatasetId={busyDatasetId}
              onSelectDataset={onSelectDataset}
              onPrefetchDataset={onPrefetchDataset}
              onEditDatasetDetails={onEditDatasetDetails}
              onDeleteDataset={onDeleteDataset}
            />
            {templates.length > 0 ? (
              <>
                <p className="px-1.5 pb-1 pt-3 font-meta text-micro uppercase tracking-meta-wider text-white/60">
                  Templates
                </p>
                <RailGroup
                  datasets={templates}
                  activeDatasetId={activeDatasetId}
                  busyDatasetId={busyDatasetId}
                  onSelectDataset={onSelectDataset}
                  onPrefetchDataset={onPrefetchDataset}
                  onEditDatasetDetails={onEditDatasetDetails}
                  onDeleteDataset={onDeleteDataset}
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function RailGroup({
  datasets,
  activeDatasetId,
  busyDatasetId,
  onSelectDataset,
  onPrefetchDataset,
  onEditDatasetDetails,
  onDeleteDataset,
}: {
  datasets: ScenarioDatasetDto[];
  activeDatasetId: string | null;
  busyDatasetId: string | null;
  onSelectDataset: (datasetId: string) => void;
  onPrefetchDataset?: (datasetId: string) => void;
  onEditDatasetDetails?: (dataset: ScenarioDatasetDto) => void;
  onDeleteDataset?: (dataset: ScenarioDatasetDto) => void;
}) {
  if (datasets.length === 0) return null;
  return (
    <ul className="divide-y divide-white/10">
      {datasets.map((dataset) => {
        const busy = busyDatasetId === dataset.id;
        const active = dataset.id === activeDatasetId;
        return (
          <li key={dataset.id} className="group/row relative">
            <button
              type="button"
              disabled={busy}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelectDataset(dataset.id)}
              onMouseEnter={() => onPrefetchDataset?.(dataset.id)}
              onFocus={() => onPrefetchDataset?.(dataset.id)}
              className={cn(
                "flex w-full flex-col gap-1 border-l-2 py-3 pl-2.5 pr-2 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                active
                  ? "border-l-primary text-foreground"
                  : "border-l-transparent hover:border-l-primary/60 hover:text-foreground",
                busy && "opacity-50",
              )}
              data-dataset-id={dataset.id}
            >
              {/* Right padding clears the row actions so a long name never runs under them. */}
              <span
                className={cn(
                  "line-clamp-2 pr-12 text-sm font-medium leading-snug",
                  active ? "text-white" : "text-white/95",
                )}
              >
                {dataset.name}
              </span>
            </button>

            {/* Revealed with opacity rather than mounted on hover, so both controls stay in the
                accessibility tree and reachable by keyboard. */}
            {onEditDatasetDetails || onDeleteDataset ? (
              <span className="absolute right-1 top-1.5 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                {onEditDatasetDetails ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-6 bg-transparent hover:bg-transparent hover:text-primary"
                    disabled={busy}
                    aria-label={`Edit ${dataset.name}`}
                    title="Edit dataset details"
                    onClick={() => onEditDatasetDetails(dataset)}
                  >
                    <Pencil className="size-3" aria-hidden="true" />
                  </Button>
                ) : null}
                {onDeleteDataset && !dataset.isSystemManaged ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-6 bg-transparent text-muted-foreground hover:bg-transparent hover:text-destructive"
                    disabled={busy}
                    aria-label={`Delete ${dataset.name}`}
                    title="Delete dataset"
                    onClick={() => onDeleteDataset(dataset)}
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                  </Button>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
