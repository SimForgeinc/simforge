"use client";

import { useId, useMemo, useState } from "react";
import { MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import type { ScenarioDatasetDto } from "@/app/lib/scenario/contracts";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import { datasetTileTransitionName } from "./datasetMorph";
import { formatDocumentCoverage, formatLastUpdated } from "./document-list-utils";

/** The row grid, shared by the column header and every row so the columns actually line up. */
const ROW_GRID = "md:grid-cols-[minmax(260px,1fr)_112px_112px_132px_40px]";

type DatasetBrowserProps = {
  datasets: ScenarioDatasetDto[];
  orderedDatasets: ScenarioDatasetDto[];
  datasetsLoading: boolean;
  /** Live document counts, when a dataset's list has already been fetched. */
  documentCountsByDataset?: Record<string, number>;
  expanded?: boolean;
  creatingDataset: boolean;
  busyDatasetId?: string | null;
  onSelectDataset: (datasetId: string) => void;
  onPrefetchDataset?: (datasetId: string) => void;
  onOpenNewDatasetDialog: () => void;
  onEditDatasetDetails?: (dataset: ScenarioDatasetDto) => void;
  onDeleteDataset?: (dataset: ScenarioDatasetDto) => void;
};

export function ScenarioDatasetBrowser({
  datasets,
  orderedDatasets,
  datasetsLoading,
  documentCountsByDataset = {},
  expanded = false,
  creatingDataset,
  busyDatasetId = null,
  onSelectDataset,
  onPrefetchDataset,
  onOpenNewDatasetDialog,
  onEditDatasetDetails,
  onDeleteDataset,
}: DatasetBrowserProps) {
  const searchId = useId();
  const [datasetSearchQuery, setDatasetSearchQuery] = useState("");

  const filteredDatasets = useMemo(() => {
    if (!expanded) return orderedDatasets;
    const query = datasetSearchQuery.trim().toLowerCase();
    if (!query) return orderedDatasets;
    return orderedDatasets.filter((dataset) => datasetMatchesSearch(dataset, query));
  }, [datasetSearchQuery, expanded, orderedDatasets]);

  return (
    <div
      className={expanded ? "flex h-full min-h-0 flex-col" : "space-y-1.5 p-3"}
      data-testid="scenario-dataset-list"
    >
      {datasets.length === 0 && datasetsLoading ? (
        // A skeleton, not `null`. v2's list rendered an empty grid while loading, which reads as
        // "no datasets" to a screen reader and flashes empty for everyone else.
        <WorkspacePaneLoading
          className="min-h-40"
          hint="Reading locally stored scenarios."
          message="Loading datasets"
        />
      ) : datasets.length === 0 ? (
        <div className="border border-border bg-surface-raised px-4 py-4 text-sm text-muted-foreground">
          No datasets yet. Create one to start authoring scenarios.
        </div>
      ) : expanded ? (
        <div className="flex min-h-0 flex-1 flex-col border border-border bg-surface-deep">
          <div
            className="relative overflow-hidden border-b border-border bg-surface-deep"
            data-testid="scenario-dataset-hero"
          >
            {/*
              Five stacked layers: photo, diagonal veil, lateral veil, brand glow, scanlines. Each is
              a utility in globals.css — see the `.list-hero-*` block there for why the gradient
              stops cannot be arbitrary Tailwind values.
            */}
            <div aria-hidden="true" className="absolute inset-0 list-hero-photo" />
            <div aria-hidden="true" className="absolute inset-0 list-hero-veil-diagonal" />
            <div aria-hidden="true" className="absolute inset-0 list-hero-veil-lateral" />
            <div aria-hidden="true" className="absolute inset-0 list-hero-veil-glow" />
            <div aria-hidden="true" className="absolute inset-0 list-hero-scanlines" />
            <div aria-hidden="true" className="absolute inset-x-4 top-0 h-px bg-border sm:inset-x-7" />
            <div aria-hidden="true" className="absolute bottom-0 left-0 h-px w-full bg-border" />
            <div className="relative z-10 flex min-h-[104px] flex-col justify-end gap-3 px-4 py-4 sm:px-5 sm:py-4 lg:flex-row lg:items-end lg:justify-between">
              <DatasetHero />
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center lg:w-auto lg:shrink-0">
                <div className="relative min-w-0 sm:w-[300px] lg:w-[280px]">
                  <label htmlFor={searchId} className="sr-only">
                    Search datasets
                  </label>
                  <Search
                    className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    id={searchId}
                    type="search"
                    value={datasetSearchQuery}
                    onChange={(event) => setDatasetSearchQuery(event.target.value)}
                    placeholder="Search datasets"
                    className="h-9 w-full appearance-none border border-input bg-surface-deep pl-10 pr-3 font-meta text-micro uppercase tracking-meta-wider text-foreground ring-offset-background [color-scheme:dark] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
                <DatasetCreateRowAction busy={creatingDataset} onClick={onOpenNewDatasetDialog} />
              </div>
            </div>
          </div>
          <div
            className={cn(
              "hidden border-b border-border px-4 py-2 font-meta text-micro uppercase tracking-meta-widest text-muted-foreground md:grid md:gap-3",
              ROW_GRID,
            )}
          >
            <span>Dataset</span>
            <span>Renders</span>
            <span>Revisions</span>
            <span>Last Updated</span>
            <span aria-hidden="true" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="scenario-dataset-scroll">
            <div className="flex min-h-full flex-col">
              {filteredDatasets.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No datasets match that search.
                </div>
              ) : (
                filteredDatasets.map((dataset) => (
                  <DatasetListRow
                    key={dataset.id}
                    dataset={dataset}
                    documentCount={documentCountsByDataset[dataset.id]}
                    busy={busyDatasetId === dataset.id}
                    onSelect={() => onSelectDataset(dataset.id)}
                    onPrefetch={
                      onPrefetchDataset ? () => onPrefetchDataset(dataset.id) : undefined
                    }
                    onEditDetails={
                      onEditDatasetDetails ? () => onEditDatasetDetails(dataset) : undefined
                    }
                    onDelete={onDeleteDataset ? () => onDeleteDataset(dataset) : undefined}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        orderedDatasets.map((dataset) => (
          <DatasetCompactRow
            key={dataset.id}
            dataset={dataset}
            documentCount={documentCountsByDataset[dataset.id]}
            busy={busyDatasetId === dataset.id}
            onSelect={() => onSelectDataset(dataset.id)}
            onPrefetch={onPrefetchDataset ? () => onPrefetchDataset(dataset.id) : undefined}
            onEditDetails={onEditDatasetDetails ? () => onEditDatasetDetails(dataset) : undefined}
            onDelete={onDeleteDataset ? () => onDeleteDataset(dataset) : undefined}
          />
        ))
      )}
      {!expanded ? (
        <DatasetCreateRowAction busy={creatingDataset} onClick={onOpenNewDatasetDialog} />
      ) : null}
    </div>
  );
}

function DatasetHero() {
  return (
    <div className="min-w-0 max-w-[620px]" data-testid="scenario-dataset-hero-copy">
      <p className="font-meta text-micro font-medium uppercase tracking-meta-tight text-muted-foreground sm:text-xs">
        Local scenario library
      </p>
      <h2 className="mt-1 max-w-none font-display text-[clamp(24px,3.6vw,42px)] font-semibold leading-tight tracking-[-0.03em] text-foreground">
        Scenario Datasets
      </h2>
      <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-muted-foreground">
        Search scenario collections, review stored activity, and open the next authoring lane.
      </p>
    </div>
  );
}


function datasetMatchesSearch(dataset: ScenarioDatasetDto, query: string) {
  return [
    dataset.name,
    dataset.description,
    dataset.id,
    dataset.visibility,
    dataset.systemSlug,
    dataset.isSystemManaged ? "read_only system" : "editable",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

/** System-managed fixture datasets remain read-only in the local library. */
function isEditableDataset(dataset: ScenarioDatasetDto) {
  return dataset.visibility === "workspace" && !dataset.isSystemManaged;
}

function DatasetCreateRowAction({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      data-testid="scenario-new-dataset"
      disabled={busy}
      onClick={onClick}
      className="h-9 px-4 font-meta text-micro font-bold uppercase tracking-meta active:scale-[0.97]"
    >
      {busy ? (
        <CloudActivityIndicator />
      ) : (
        <Plus className="size-4 stroke-[2.5]" aria-hidden="true" />
      )}
      New Dataset
    </Button>
  );
}

function DatasetListRow({
  dataset,
  documentCount,
  busy,
  onSelect,
  onPrefetch,
  onEditDetails,
  onDelete,
}: {
  dataset: ScenarioDatasetDto;
  documentCount?: number;
  busy: boolean;
  onSelect: () => void;
  onPrefetch?: () => void;
  onEditDetails?: () => void;
  onDelete?: () => void;
}) {
  // `documentCount` from the DTO, never `itemCount`. `itemCount` counts pinned revision×render-job
  // pairs and reads 0 for every dataset until someone pins one — which is exactly the number v2's
  // old grid showed.
  const total = documentCount ?? dataset.documentCount;
  const readOnly = !isEditableDataset(dataset);
  const documentLabel = total === 1 ? "1 scenario" : `${total.toLocaleString()} scenarios`;

  return (
    <div
      style={{ viewTransitionName: datasetTileTransitionName(dataset.id) }}
      className="group border-b border-border transition-colors last:border-b-0 hover:bg-accent/40"
    >
      <div className={cn("grid gap-3 px-4 py-3 md:items-center", ROW_GRID)}>
        <button
          type="button"
          onClick={onSelect}
          onFocus={onPrefetch}
          onPointerEnter={onPrefetch}
          data-scenario-dataset-tile=""
          data-dataset-id={dataset.id}
          className="min-w-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block truncate font-display text-base font-semibold leading-tight tracking-[-0.02em] text-foreground transition-colors group-hover:text-primary">
            {dataset.name}
          </span>
          <span className="mt-1 block line-clamp-2 text-xs leading-snug text-muted-foreground">
            {dataset.description?.trim() || "No description"}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-meta text-micro uppercase tracking-meta-wider text-muted-foreground">
            <span>{documentLabel}</span>
            {readOnly ? (
              <span className="border border-border px-1.5 py-px text-micro tracking-meta-widest text-muted-foreground">
                Read-only
              </span>
            ) : null}
          </span>
        </button>
        <DatasetMetric
          label="Renders"
          value={formatDocumentCoverage(dataset.renderCompletedCount, total)}
        />
        <DatasetMetric
          label="Revisions"
          value={formatDocumentCoverage(dataset.exportCompletedCount, total)}
        />
        <DatasetMetric label="Last Updated" value={formatLastUpdated(dataset.updatedAt)} />
        <DatasetRowActions
          dataset={dataset}
          busy={busy}
          mutable={!readOnly}
          onEditDetails={onEditDetails}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function DatasetRowActions({
  dataset,
  busy,
  mutable,
  onEditDetails,
  onDelete,
}: {
  dataset: ScenarioDatasetDto;
  busy: boolean;
  mutable: boolean;
  onEditDetails?: () => void;
  onDelete?: () => void;
}) {
  const canEditDetails = mutable && Boolean(onEditDetails);
  const canDelete = mutable && Boolean(onDelete) && !dataset.isSystemManaged;
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={busy}
            aria-label={`Dataset actions for ${dataset.name}`}
          >
            {busy ? (
              <CloudActivityIndicator iconClassName="size-3.5" />
            ) : (
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem disabled={!canEditDetails} onSelect={onEditDetails}>
            <Pencil className="mr-2 size-3.5" aria-hidden="true" />
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={!canDelete}
            onSelect={onDelete}
          >
            <Trash2 className="mr-2 size-3.5" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DatasetMetric({ label, value }: { label: string; value: number | string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 font-meta text-micro uppercase tracking-meta-wider md:block">
      <span className="text-muted-foreground md:hidden">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** The rail variant: same data, `scn/rdr/rev` counters, one line. */
function DatasetCompactRow({
  dataset,
  documentCount,
  busy,
  onSelect,
  onPrefetch,
  onEditDetails,
  onDelete,
}: {
  dataset: ScenarioDatasetDto;
  documentCount?: number;
  busy: boolean;
  onSelect: () => void;
  onPrefetch?: () => void;
  onEditDetails?: () => void;
  onDelete?: () => void;
}) {
  const total = documentCount ?? dataset.documentCount;
  const readOnly = !isEditableDataset(dataset);
  return (
    <div className="group relative flex w-full items-center justify-between gap-2 border border-border bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-primary/50">
      <button
        type="button"
        onClick={onSelect}
        onFocus={onPrefetch}
        onPointerEnter={onPrefetch}
        data-dataset-id={dataset.id}
        className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div className="truncate text-sm font-medium text-foreground">{dataset.name}</div>
        <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {dataset.description?.trim() || "No description"}
        </div>
        <div className="mt-1 flex items-center gap-2 font-meta text-micro uppercase tracking-meta-wider text-muted-foreground">
          <span>{total} scn</span>
          <span aria-hidden="true">/</span>
          <span>
            {dataset.renderCompletedCount}/{dataset.renderSubmittedCount} rdr
          </span>
          <span aria-hidden="true">/</span>
          <span>{dataset.exportCompletedCount} rev</span>
          {readOnly ? (
            <span className="border border-border px-1.5 py-px text-micro tracking-meta-widest">
              R/O
            </span>
          ) : null}
        </div>
      </button>
      <span
        aria-hidden="true"
        className="font-meta text-micro tracking-meta-widest text-muted-foreground transition-transform duration-150 group-hover:translate-x-1 group-hover:text-primary motion-reduce:transition-none"
      >
        ▶
      </span>
      <DatasetRowActions
        dataset={dataset}
        busy={busy}
        mutable={!readOnly}
        onEditDetails={onEditDetails}
        onDelete={onDelete}
      />
    </div>
  );
}
