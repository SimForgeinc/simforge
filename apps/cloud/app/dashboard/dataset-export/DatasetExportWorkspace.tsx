"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, LoaderCircle } from "lucide-react";
import { useSetPageTitle } from "@/app/components/TopBarSlot";
import { PageHeader } from "@/app/components/ui/page-header";
import { EmptyState } from "@/app/components/ui/empty-state";
import { cn } from "@/app/lib/utils";
import { DatasetExportPanel } from "./DatasetExportPanel";

type DatasetSummary = {
  id: string;
  name: string;
  description?: string | null;
  mutability?: string | null;
  scope?: string | null;
};

export function DatasetExportWorkspace() {
  useSetPageTitle("Dataset Export");
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const loadDatasets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/datasets", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        datasets?: DatasetSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Failed to load datasets.");
      const nextDatasets = body.datasets ?? [];
      setDatasets(nextDatasets);
      setSelectedDatasetId((current) => {
        if (current && nextDatasets.some((dataset) => dataset.id === current)) {
          return current;
        }
        return nextDatasets[0]?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load datasets.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  return (
    <div className="flex min-h-full flex-col bg-background">
      <PageHeader
        eyebrow="Dataset operations"
        title="Dataset Export"
        description="Select a dataset, review its contents, and prepare a downloadable export."
        actions={
          <button
            type="button"
            onClick={() => void loadDatasets()}
            disabled={loading}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <LoaderCircle className={cn("size-3", loading && "animate-spin")} />
            Refresh datasets
          </button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="max-h-[36vh] min-h-0 border-b border-border/70 bg-card/25 lg:max-h-none lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">
              Datasets
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {datasets.length}
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto p-3">
            {loading && datasets.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground" role="status" aria-live="polite">
                <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
                Loading datasets…
              </div>
            ) : error ? (
              <div className="border border-rose-400/30 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100/80">
                {error}
              </div>
            ) : datasets.length === 0 ? (
              <div className="border border-white/10 bg-[#0a0a0c]/60 px-4 py-4 text-sm text-foreground/55">
                No datasets.
              </div>
            ) : (
              <div className="space-y-2">
                {datasets.map((dataset) => {
                  const active = dataset.id === selectedDatasetId;
                  return (
                    <button
                      key={dataset.id}
                      type="button"
                      onClick={() => setSelectedDatasetId(dataset.id)}
                      className={cn(
                        "group flex w-full gap-3 border px-3 py-3 text-left transition-colors",
                        active
                          ? "border-[#E8E044]/70 bg-[#E8E044]/[0.08]"
                          : "border-white/10 bg-[#0a0a0c]/55 hover:border-white/25 hover:bg-[#0a0a0c]",
                      )}
                    >
                      <Database
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          active ? "text-[#E8E044]" : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {dataset.name}
                        </span>
                        {dataset.description ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                            {dataset.description}
                          </span>
                        ) : (
                          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60">
                            {dataset.id}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-5">
          {selectedDatasetId && selectedDataset ? (
            <div className="space-y-4">
              <section className="border border-border/60 bg-card/35 px-4 py-4">
                <div className="text-xs font-medium text-muted-foreground">
                  Selected dataset
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {selectedDataset.name}
                </div>
                {selectedDataset.description ? (
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                    {selectedDataset.description}
                  </p>
                ) : null}
              </section>
              <DatasetExportPanel datasetId={selectedDatasetId} />
            </div>
          ) : (
            <EmptyState
              icon={<Database className="size-6" />}
              title="Select a dataset"
              description="Choose a dataset from the list to review its export options."
              className="min-h-[360px] rounded-lg border border-border bg-card/30"
            />
          )}
        </main>
      </div>
    </div>
  );
}
