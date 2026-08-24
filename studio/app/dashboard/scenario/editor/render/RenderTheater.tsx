"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Camera, CircleStop, EyeOff } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { cn } from "@/app/lib/utils";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import {
  cancelRenderJob,
  fetchRenderJobDetail,
  fetchRenderJobDownloads,
  setRenderJobHidden,
  type PresignedArtifact,
} from "./api";
import { RenderArtifactList } from "./RenderArtifactList";
import { RenderParityEvidencePanel } from "./RenderParityEvidence";
import { PostprocessPanel } from "./PostprocessPanel";
import { RenderStateChip } from "./RenderStatePieces";
import { VideoPreviewModal } from "./VideoPreviewModal";
import {
  failureMessage,
  formatCostCents,
  formatElapsed,
  formatTimestamp,
  humanizeCode,
  isPlayableVideo,
  isPostprocessMode,
  jobModeLabel,
  renderStateVisual,
  shortDigest,
} from "./render-view-model";
import type { ScenarioRenderJobDetailDto } from "@/app/lib/scenario/render/contracts";

/**
 * The detail sections beside the player.
 *
 * "Videos" is gone as a tab: the video is the view now, playing at full width, and a tab that
 * swapped it out for a file table was the old dialog's compromise for having no room.
 */
const RAIL_TABS = ["files", "behavior", "log", "config"] as const;
type RailTab = (typeof RAIL_TABS)[number];
const RAIL_TAB_LABELS: Record<RailTab, string> = {
  files: "Files",
  behavior: "Behavior",
  log: "Log",
  config: "Config",
};

const POLL_INTERVAL_MS = 5000;

/**
 * One render, filling the render pane.
 *
 * This replaces a centred dialog. A render is a video, and a video wants width — the dialog capped it
 * at 5xl over a dimmed backdrop, on a surface that was itself a panel over the scene, so the author
 * ended up looking at a small picture inside three frames. Here the scenario list slides away, the
 * player takes the freed width, and the run's files, behaviour evidence, log and configuration sit in
 * a rail beside it instead of behind tabs that hid the video.
 *
 * Going back is `onBack`, not a close: the gallery it returns to is the same surface, one level up.
 */
export function RenderTheater({
  jobId,
  onBack,
  onHiddenChange,
}: {
  jobId: string;
  /** Returns to the gallery. */
  onBack: () => void;
  onHiddenChange: () => void;
}) {
  const [tab, setTab] = useState<RailTab>("files");
  const [detail, setDetail] = useState<ScenarioRenderJobDetailDto | null>(null);
  const [downloads, setDownloads] = useState<PresignedArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [preview, setPreview] = useState<PresignedArtifact | null>(null);
  const [heroArtifactId, setHeroArtifactId] = useState<string | null>(null);

  const live = detail ? renderStateVisual(detail.jobState).live : true;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await fetchRenderJobDetail(jobId, signal);
        if (signal?.aborted) return;
        setDetail(next);
        setError(null);
        if (next.artifacts.length > 0) {
          // Signing is per request and scoped to this job; refreshing alongside the detail poll keeps
          // the video sources valid while the view stays open.
          const items = await fetchRenderJobDownloads(jobId, signal);
          if (!signal?.aborted) setDownloads(items);
        }
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? humanizeCode(cause.message) : "render_detail_failed");
      }
    },
    [jobId],
  );

  useEffect(() => {
    setDetail(null);
    setDownloads([]);
    setTab("files");
    setHeroArtifactId(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const poll = useCallback(() => load(), [load]);
  useVisiblePolling(poll, POLL_INTERVAL_MS, live);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack]);

  const videos = useMemo(() => downloads.filter(isPlayableVideo), [downloads]);
  /**
   * The video on the big player.
   *
   * Falls back to the first video rather than pinning an id on load: the poll re-signs the artifacts
   * while a render is still producing them, and the author's pick has to survive that.
   */
  const hero = useMemo(
    () => videos.find((artifact) => artifact.id === heroArtifactId) ?? videos[0] ?? null,
    [heroArtifactId, videos],
  );
  const failure = failureMessage(detail?.failureCode ?? null);
  const cancellable = detail ? renderStateVisual(detail.jobState).live : false;
  const latestAttempt = detail?.attempts.at(-1) ?? null;

  async function cancel() {
    if (!window.confirm("Cancel this render?")) return;
    setActionBusy(true);
    try {
      await cancelRenderJob(jobId);
      await load();
      onHiddenChange();
    } catch {
      setError("The render could not be cancelled.");
    } finally {
      setActionBusy(false);
    }
  }

  async function hide() {
    setActionBusy(true);
    try {
      await setRenderJobHidden(jobId, true);
      onHiddenChange();
      onBack();
    } catch {
      setError("The render could not be hidden.");
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section
      aria-label="Render run details"
      className="render-view-enter flex min-h-0 flex-1 flex-col"
      data-testid="scenario-render-theater"
      data-render-job-id={jobId}
    >
      <header className="flex shrink-0 flex-col gap-2 border-b render-hairline px-5 py-3.5">
        <div className="flex items-center gap-3">
          <button
            aria-label="Back to the render gallery"
            className="editor-motion render-glass grid size-8 shrink-0 place-items-center border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="scenario-render-theater-back"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {detail ? jobModeLabel(detail.jobMode) : "Render"} ·{" "}
              {formatTimestamp(detail?.createdAt ?? null)}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
              <span>{formatElapsed(detail?.startedAt ?? null, detail?.completedAt ?? null)}</span>
              <span>{detail ? formatCostCents(detail.estimatedCostCents) : "—"}</span>
              <span className="inline-flex items-center gap-1">
                <Camera aria-hidden="true" className="size-3" />
                {videos.length} {videos.length === 1 ? "video" : "videos"}
              </span>
              {detail && detail.attemptCount > 1 ? <span>attempt {detail.attemptCount}</span> : null}
            </div>
          </div>
          {detail ? <RenderStateChip state={detail.jobState} /> : null}
          {cancellable ? (
            <button
              aria-label="Cancel this render"
              className="editor-motion inline-flex shrink-0 items-center gap-1.5 border border-destructive/40 bg-destructive/10 px-3 py-1 text-micro font-medium text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={actionBusy}
              onClick={() => void cancel()}
              type="button"
            >
              {actionBusy ? (
                <CloudActivityIndicator />
              ) : (
                <CircleStop aria-hidden="true" className="size-3" />
              )}
              Cancel
            </button>
          ) : (
            <button
              aria-label="Hide this render from the gallery"
              className="editor-motion render-glass inline-flex shrink-0 items-center gap-1.5 border px-3 py-1 text-micro font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={actionBusy}
              onClick={() => void hide()}
              type="button"
            >
              {actionBusy ? (
                <CloudActivityIndicator />
              ) : (
                <EyeOff aria-hidden="true" className="size-3" />
              )}
              Hide
            </button>
          )}
        </div>
        {failure ? (
          <p className="text-xs text-destructive" role="alert">
            {failure}
            {detail?.failureDetail ? ` — ${detail.failureDetail}` : ""}
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </header>

      {!detail ? (
        <WorkspacePaneLoading
          className="min-h-0 flex-1"
          hint="Reading the render job, its attempts and its files."
          message="Loading render…"
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-1">
          <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4">
            {hero ? (
              <figure className="render-glass flex min-h-0 flex-col border" key={hero.id}>
                {/* Presigned URL; a same-origin poster does not exist for managed renders. */}
                <video
                  autoPlay
                  className="aspect-video w-full render-video-mat object-contain"
                  controls
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  src={hero.url ?? undefined}
                >
                  <track kind="captions" />
                </video>
                <figcaption className="flex items-baseline justify-between gap-2 px-3 py-2">
                  <span className="truncate text-xs font-medium text-foreground">
                    {hero.artifactKind}
                  </span>
                  <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">
                    {hero.mediaType}
                  </span>
                </figcaption>
              </figure>
            ) : (
              <div className="render-glass flex min-h-72 flex-1 flex-col items-center justify-center gap-3 border p-8 text-center text-sm text-muted-foreground">
                <Camera aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
                <span>
                  {live ? "Videos will appear here when the render finishes." : "This render has no videos."}
                </span>
              </div>
            )}

            {/* Only worth a strip when there is a choice to make. */}
            {videos.length > 1 ? (
              <div
                aria-label="Videos in this render"
                className="flex shrink-0 flex-wrap gap-2"
                role="tablist"
              >
                {videos.map((artifact) => {
                  const active = hero?.id === artifact.id;
                  return (
                    <button
                      aria-selected={active}
                      className={cn(
                        "editor-motion relative w-40 shrink-0 overflow-hidden border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "border-primary" : "render-glass hover:border-primary/50",
                      )}
                      key={artifact.id}
                      onClick={() => setHeroArtifactId(artifact.id)}
                      role="tab"
                      type="button"
                    >
                      <video
                        aria-hidden="true"
                        className="aspect-video w-full render-video-mat object-cover"
                        muted
                        playsInline
                        preload="metadata"
                        src={artifact.url ?? undefined}
                      >
                        <track kind="captions" />
                      </video>
                      <span className="block truncate px-2 py-1 text-micro uppercase tracking-meta text-muted-foreground">
                        {artifact.artifactKind}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-col render-hairline xl:border-l">
            <div
              aria-label="Render details sections"
              className="flex shrink-0 items-center gap-1 border-b render-hairline px-2 py-1.5"
              role="tablist"
            >
              {RAIL_TABS.map((id) => {
                const active = tab === id;
                return (
                  <button
                    aria-controls="scenario-render-rail-panel"
                    aria-selected={active}
                    id={`scenario-render-rail-tab-${id}`}
                    className={cn(
                      "editor-motion px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "render-glass-raised border text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    key={id}
                    onClick={() => setTab(id)}
                    role="tab"
                    type="button"
                  >
                    {RAIL_TAB_LABELS[id]}
                  </button>
                );
              })}
            </div>
            <div
              aria-labelledby={`scenario-render-rail-tab-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto"
              id="scenario-render-rail-panel"
              role="tabpanel"
            >
              {tab === "files" ? (
                <div className="flex flex-col gap-5 p-3">
                  <RenderArtifactList
                    artifacts={downloads.length > 0 ? downloads : detail.artifacts}
                    emptyMessage="This render has produced no files yet."
                    onPreview={setPreview}
                    signed={downloads.length > 0}
                  />
                  {/* A postprocess job hangs off a succeeded render, so it never offers to postprocess
                      itself. */}
                  {isPostprocessMode(detail.jobMode) ? null : (
                    <PostprocessPanel
                      artifacts={downloads.length > 0 ? downloads : []}
                      parentJobId={detail.id}
                      parentState={detail.jobState}
                    />
                  )}
                </div>
              ) : tab === "behavior" ? (
                <div className="p-3">
                  <RenderParityEvidencePanel
                    artifacts={downloads}
                    executionPackageControlSha256={detail.executionPackageControlSha256}
                    executionPackageId={detail.executionPackageId}
                    jobId={detail.id}
                  />
                </div>
              ) : tab === "log" ? (
                <div className="p-3 font-mono text-micro leading-relaxed text-foreground/75">
                  {detail.events.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      No events recorded yet.
                    </div>
                  ) : (
                    detail.events.map((event) => (
                      <div className="flex gap-3" key={event.eventOrdinal}>
                        <span className="shrink-0 text-muted-foreground">
                          {formatTimestamp(event.createdAt)}
                        </span>
                        <span className="break-all">{humanizeCode(event.eventKind)}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="p-3">
                  <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)]">
                    <ConfigRow label="Mode" value={jobModeLabel(detail.jobMode)} />
                    <ConfigRow label="Status" value={renderStateVisual(detail.jobState).label} />
                    <ConfigRow label="Created" value={formatTimestamp(detail.createdAt)} />
                    <ConfigRow label="Started" value={formatTimestamp(detail.startedAt)} />
                    <ConfigRow label="Completed" value={formatTimestamp(detail.completedAt)} />
                    <ConfigRow
                      label="Attempts"
                      value={`${detail.attemptCount}/${detail.maxAttempts}`}
                    />
                    <ConfigRow label="Estimated cost" value={formatCostCents(detail.estimatedCostCents)} />
                    <ConfigRow label="Worker" value={latestAttempt?.workerNodeId ?? "—"} />
                    <ConfigRow
                      label="Runtime"
                      value={
                        latestAttempt?.runtimeVersion && latestAttempt.imageDigest
                          ? `${latestAttempt.runtimeVersion} · ${shortDigest(latestAttempt.imageDigest)}`
                          : latestAttempt ? "local process" : "—"
                      }
                    />
                    <ConfigRow label="Revision" value={detail.revisionId} mono />
                    <ConfigRow label="Execution package" value={detail.executionPackageId} mono />
                    <ConfigRow
                      label="Package digest"
                      value={shortDigest(detail.executionPackageControlSha256)}
                      mono
                    />
                    <ConfigRow label="Render spec digest" value={shortDigest(detail.renderSpecSha256)} mono />
                    <ConfigRow label="Job ID" value={detail.id} mono />
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <VideoPreviewModal
        mediaType={preview?.mediaType ?? "video/mp4"}
        onClose={() => setPreview(null)}
        open={preview != null}
        title={preview?.artifactKind ?? "Preview"}
        url={preview?.url ?? null}
      />
    </section>
  );
}

function ConfigRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-micro uppercase tracking-meta text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-all text-foreground", mono ? "font-mono text-micro" : "")}>
        {value}
      </dd>
    </>
  );
}
