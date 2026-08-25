"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  LoaderCircle,
  PackageCheck,
  PackagePlus,
  RefreshCw,
} from "lucide-react";
import {
  DATASET_EXPORT_RECIPES,
  isDatasetExportRecipeQueueable,
  type DatasetExportRecipeId,
} from "@/app/lib/studio-shared/dataset-export-recipes";
import type { ExportFormat } from "@/app/lib/studio-shared/dataset";
import { cn } from "@/app/lib/utils";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";

type ExportJob = {
  id: string;
  status: string;
  phase?: string | null;
  datasetSnapshotId?: string | null;
  format: ExportFormat;
  recipe?: string | null;
  defaultPublicationId?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type ExportDownloadResponse = {
  kind?: string;
  url?: string | null;
  manifestUrl?: string | null;
  s3Bucket?: string | null;
  s3Prefix?: string | null;
  expiresIn?: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type ToastState = {
  kind: "success" | "error";
  message: string;
};

const EXPORT_POLL_INTERVAL_MS = 7000;
const EXPORT_RECIPE_LABELS = DATASET_EXPORT_RECIPES.map((recipe) => ({
  id: recipe.id,
  label: recipe.name,
  description: recipe.description,
  format: recipe.format,
  queueable: isDatasetExportRecipeQueueable(recipe),
}));
const EXPORT_RECIPE_OPTIONS = EXPORT_RECIPE_LABELS.filter(
  (recipe) => recipe.queueable,
);
const DEFAULT_EXPORT_RECIPE_OPTION = EXPORT_RECIPE_OPTIONS[0]!;

function shortId(id: string | null | undefined, chars = 8): string {
  if (!id) return "-";
  return id.length > chars ? id.slice(0, chars) : id;
}

function recipeLabel(recipeId: string | null | undefined, format: ExportFormat) {
  const recipe = EXPORT_RECIPE_LABELS.find((option) => option.id === recipeId);
  return recipe?.label ?? format.replaceAll("_", " ");
}

function formatJobTime(value: string | null | undefined) {
  if (!value) return "Not started";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function exportStatusLabel(status: string, phase: string | null | undefined) {
  if (status === "queued") return "Queued";
  if (status === "running") return phase ? `Running: ${phase.replaceAll("_", " ")}` : "Running";
  if (status === "succeeded") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return status.replaceAll("_", " ");
}

function exportStatusClasses(status: string) {
  switch (status) {
    case "succeeded":
      return "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200";
    case "failed":
    case "cancelled":
      return "border-rose-400/30 bg-rose-400/[0.08] text-rose-200";
    case "running":
      return "border-[#E8E044]/35 bg-[#E8E044]/[0.07] text-[#E8E044]";
    default:
      return "border-white/15 bg-white/[0.04] text-white/65";
  }
}

function canDownloadExport(job: ExportJob) {
  return job.status === "succeeded" || Boolean(job.defaultPublicationId);
}

function hasLiveExportJobs(jobs: ExportJob[]) {
  return jobs.some((job) => job.status === "queued" || job.status === "running");
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(text.length > 180 ? `${text.slice(0, 177)}...` : text);
      }
      throw new Error("Response was not valid JSON.");
    }
  }
  if (typeof response.json === "function") return response.json() as Promise<unknown>;
  return null;
}

function responseError(value: unknown, fallback: string) {
  const record = asRecord(value);
  return typeof record?.error === "string" ? record.error : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExportFormat(value: unknown): value is ExportFormat {
  return (
    value === "REVIEW_BUNDLE" ||
    value === "NATIVE_FULL" ||
    value === "ODVG" ||
    value === "ALPAMAYO_SFT"
  );
}

function parseExportJob(value: unknown): ExportJob | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.id !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !isExportFormat(record.format)
  ) {
    return null;
  }
  return {
    id: record.id,
    status: record.status,
    format: record.format,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    phase: typeof record.phase === "string" ? record.phase : null,
    datasetSnapshotId:
      typeof record.datasetSnapshotId === "string" ? record.datasetSnapshotId : null,
    recipe: typeof record.recipe === "string" ? record.recipe : null,
    defaultPublicationId:
      typeof record.defaultPublicationId === "string" ? record.defaultPublicationId : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
  };
}

function parseExportJobsResponse(value: unknown): ExportJob[] {
  const record = asRecord(value);
  if (!record) return [];
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  return jobs.map(parseExportJob).filter((job): job is ExportJob => Boolean(job));
}

function parseExportDownloadResponse(value: unknown): ExportDownloadResponse {
  const record = asRecord(value);
  if (!record) return {};
  return {
    kind: typeof record.kind === "string" ? record.kind : undefined,
    url: typeof record.url === "string" ? record.url : null,
    manifestUrl: typeof record.manifestUrl === "string" ? record.manifestUrl : null,
    s3Bucket: typeof record.s3Bucket === "string" ? record.s3Bucket : null,
    s3Prefix: typeof record.s3Prefix === "string" ? record.s3Prefix : null,
    expiresIn: typeof record.expiresIn === "number" ? record.expiresIn : undefined,
  };
}

export function DatasetExportPanel({ datasetId }: { datasetId: string }) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedRecipe, setSelectedRecipe] =
    useState<DatasetExportRecipeId>("review_bundle");
  const [queueing, setQueueing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [polling, setPolling] = useState(true);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const selected = useMemo(
    () =>
      EXPORT_RECIPE_OPTIONS.find((recipe) => recipe.id === selectedRecipe) ??
      DEFAULT_EXPORT_RECIPE_OPTION,
    [selectedRecipe],
  );
  const latestJob = jobs[0] ?? null;
  const latestReady = latestJob ? canDownloadExport(latestJob) : false;

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 7000);
  }, []);

  const loadExports = useCallback(async (signal: AbortSignal) => {
    if (!datasetId) return;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs`,
        { cache: "no-store", signal },
      );
      const json = await readResponseBody(res);
      if (!res.ok) throw new Error(responseError(json, `status ${res.status}`));
      if (signal.aborted) return;
      const nextJobs = parseExportJobsResponse(json);
      setJobs(nextJobs);
      setPolling(hasLiveExportJobs(nextJobs));
      setState("ready");
      setError(null);
    } catch (loadError) {
      if (
        signal.aborted ||
        (loadError as { name?: string } | null)?.name === "AbortError"
      ) {
        return;
      }
      setPolling(hasLiveExportJobs(jobs));
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "fetch failed");
    }
  }, [datasetId, jobs]);

  useEffect(() => {
    setJobs([]);
    setState("idle");
    setError(null);
    setPolling(true);
  }, [datasetId]);

  useVisiblePolling(
    loadExports,
    EXPORT_POLL_INTERVAL_MS,
    polling,
    `${datasetId}:${refreshGeneration}`,
  );

  const refreshExports = useCallback(() => {
    setPolling(true);
    setRefreshGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleQueue = useCallback(async () => {
    setQueueing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            format: selected.format,
            recipe: selected.id,
          }),
        },
      );
      const json = await readResponseBody(res);
      if (!res.ok) throw new Error(responseError(json, "export failed"));
      const exportId =
        typeof (json as { exportId?: unknown })?.exportId === "string"
          ? (json as { exportId: string }).exportId
          : null;
      showToast({
        kind: "success",
        message: `Queued ${selected.label}${exportId ? `, ${shortId(exportId, 12)}` : ""}`,
      });
      refreshExports();
    } catch (queueError) {
      showToast({
        kind: "error",
        message: queueError instanceof Error ? queueError.message : "Failed to queue export",
      });
    } finally {
      setQueueing(false);
    }
  }, [datasetId, refreshExports, selected, showToast]);

  const handleDownload = useCallback(
    async (job: ExportJob) => {
      setDownloadingId(job.id);
      try {
        const res = await fetch(
          `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs/${encodeURIComponent(job.id)}/download`,
          { cache: "no-store" },
        );
        const json = await readResponseBody(res);
        if (!res.ok) throw new Error(responseError(json, "download failed"));
        const parsed = parseExportDownloadResponse(json);
        const url = parsed.url ?? parsed.manifestUrl ?? null;
        if (!url) {
          throw new Error(
            parsed.s3Bucket && parsed.s3Prefix
              ? `Export is ready at s3://${parsed.s3Bucket}/${parsed.s3Prefix}`
              : "Export is ready, but no browser download URL was returned.",
          );
        }
        window.open(url, "_blank", "noopener,noreferrer");
        showToast({
          kind: "success",
          message: `Opened ${recipeLabel(job.recipe, job.format)} download`,
        });
      } catch (downloadError) {
        showToast({
          kind: "error",
          message: downloadError instanceof Error ? downloadError.message : "Download failed",
        });
      } finally {
        setDownloadingId(null);
      }
    },
    [datasetId, showToast],
  );

  return (
    <section className="border border-border/60 bg-card/40">
      <header className="grid gap-4 border-b border-border/60 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PackageCheck className="size-4 text-[#E8E044]" />
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Export bundle
            </h3>
            {latestJob ? (
              <span
                className={cn(
                  "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
                  exportStatusClasses(latestJob.status),
                )}
              >
                {exportStatusLabel(latestJob.status, latestJob.phase)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
            Create a downloadable package from the current dataset artifacts.
            Exports run as background jobs and become downloadable when publication
            finishes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <button
            type="button"
            onClick={refreshExports}
            disabled={state === "loading"}
            className="inline-flex items-center gap-2 border border-white/15 bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white/70 transition-colors hover:border-white/30 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RefreshCw className={cn("size-3", state === "loading" && "animate-spin")} />
            Refresh
          </button>
          {latestJob ? (
            <button
              type="button"
              onClick={() => void handleDownload(latestJob)}
              disabled={!latestReady || downloadingId === latestJob.id}
              className="inline-flex items-center gap-2 border border-[#E8E044]/60 bg-[#E8E044] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[#0a0a0c] transition-colors hover:bg-[#f5ed5a] disabled:cursor-not-allowed disabled:border-white/15 disabled:bg-white/[0.04] disabled:text-white/35"
            >
              {downloadingId === latestJob.id ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              Download latest
            </button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="border-b border-border/60 lg:border-b-0 lg:border-r">
          <div className="grid gap-0 md:grid-cols-3">
            {EXPORT_RECIPE_OPTIONS.map((recipe) => {
              const active = recipe.id === selectedRecipe;
              return (
                <button
                  key={recipe.id}
                  type="button"
                  onClick={() => setSelectedRecipe(recipe.id)}
                  className={cn(
                    "min-h-[150px] border-b border-r border-border/60 p-4 text-left transition-colors last:border-r-0 md:border-b-0",
                    active
                      ? "bg-[#E8E044]/[0.08] text-foreground"
                      : "bg-background/30 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
                      {recipe.format.replaceAll("_", " ")}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 border",
                        active ? "border-[#E8E044] bg-[#E8E044]" : "border-white/20",
                      )}
                    />
                  </div>
                  <div className="mt-5 text-sm font-semibold text-foreground">
                    {recipe.label}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {recipe.description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 px-4 py-4">
            <button
              type="button"
              onClick={() => void handleQueue()}
              disabled={queueing}
              className="inline-flex items-center gap-2 border border-[#E8E044]/60 bg-[#E8E044] px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[#0a0a0c] transition-colors hover:bg-[#f5ed5a] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {queueing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <PackagePlus className="size-3.5" />
              )}
              Queue export
            </button>
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
              {selected.label} · {selected.format.replaceAll("_", " ")}
            </div>
          </div>
        </div>

        <aside className="min-h-[260px] bg-background/40">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Export jobs
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {jobs.length}
            </span>
          </div>
          {error && jobs.length > 0 ? (
            <div className="m-4 border border-rose-400/30 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100/80">
              {error}
            </div>
          ) : null}
          {state === "loading" && jobs.length === 0 ? (
            <div className="space-y-2 p-4">
              <div className="h-10 animate-pulse bg-white/[0.05]" />
              <div className="h-10 animate-pulse bg-white/[0.05]" />
              <div className="h-10 animate-pulse bg-white/[0.05]" />
            </div>
          ) : error && jobs.length === 0 ? (
            <div className="m-4 border border-rose-400/30 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100/80">
              {error}
            </div>
          ) : jobs.length === 0 ? (
            <div className="p-4 text-xs leading-5 text-muted-foreground">
              No exports yet. Pick a recipe and queue the first bundle.
            </div>
          ) : (
            <ol className="divide-y divide-border/60">
              {jobs.slice(0, 5).map((job) => {
                const downloadable = canDownloadExport(job);
                return (
                  <li key={job.id} className="grid gap-3 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-foreground">
                          {recipeLabel(job.recipe, job.format)}
                        </div>
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
                          {shortId(job.id, 12)} · {formatJobTime(job.createdAt)}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]",
                          exportStatusClasses(job.status),
                        )}
                      >
                        {exportStatusLabel(job.status, job.phase)}
                      </span>
                    </div>
                    {job.errorMessage ? (
                      <div className="text-xs leading-5 text-rose-200/80">
                        {job.errorMessage}
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55">
                        Snapshot {shortId(job.datasetSnapshotId, 8)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDownload(job)}
                        disabled={!downloadable || downloadingId === job.id}
                        className="inline-flex items-center gap-1.5 border border-white/15 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/70 transition-colors hover:border-[#E8E044]/50 hover:text-[#E8E044] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        {downloadingId === job.id ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        Download
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>
      {toast ? (
        <p
          className={cn(
            "border-t px-4 py-3 font-mono text-[11px]",
            toast.kind === "success"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200"
              : "border-rose-400/20 bg-rose-400/[0.05] text-rose-200",
          )}
        >
          {toast.message}
        </p>
      ) : null}
    </section>
  );
}
