"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, CircleDashed, Play, TriangleAlert } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";
import { cn } from "@/app/lib/utils";
import { fetchRenderJobDetail } from "./api";
import { RenderProgressBar, RenderStateChip } from "./RenderStatePieces";
import {
  failureMessage,
  formatBytes,
  formatElapsed,
  formatTimestamp,
  humanizeCode,
  jobModeLabel,
  latestRenderEvent,
  renderPipelineStages,
  renderStateVisual,
  shortDigest,
} from "./render-view-model";
import type { UniScenarioRenderJobDetailDto } from "@/app/lib/uniscenario/render/contracts";

/** Faster than the gallery's 5s: this view exists to be watched, so it should keep up. */
const DETAIL_POLL_MS = 2000;

/**
 * What a submitted render is doing, while it does it.
 *
 * Submitting used to drop the author straight into the theater, which is built for finished footage:
 * a queued CARLA job showed a chip, an empty video frame and nothing else for minutes. The complaint
 * that follows is always the same — it looks like nothing is happening.
 *
 * So everything the control plane actually exposes is on screen, and something visibly moves every
 * second even though the worker reports coarsely and the poll is every two:
 *
 *  - the pipeline's real stages, ticked off from the job's own event stream, with the one being
 *    waited on called out rather than left as an unmarked gap;
 *  - `progressPercent` when a worker has reported one, and an honest indeterminate bar when not;
 *  - elapsed time and time-since-last-event, recomputed on a local clock so the surface stays alive
 *    between polls instead of freezing for two seconds at a time;
 *  - which worker claimed it and on which attempt, because "a machine has this" is the single most
 *    reassuring fact available and it was previously buried in a details tab;
 *  - artifacts as they land, each with its size, so output arriving is visible before the job ends.
 *
 * Nothing here is derived from a timer pretending to be progress. Every number and every tick comes
 * from the job, and when the job says nothing the surface says that too.
 */
export function RenderProgressView({
  jobId,
  onBack,
  onWatch,
}: {
  jobId: string;
  onBack: () => void;
  /** Offered once there is something to play. Never automatic: it would yank the view mid-read. */
  onWatch: (jobId: string) => void;
}) {
  const [detail, setDetail] = useState<UniScenarioRenderJobDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A local clock, so elapsed and "last heard" advance every second rather than every poll.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await fetchRenderJobDetail(jobId, signal);
        if (signal?.aborted) return;
        setDetail(next);
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not read this render's status.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [jobId],
  );

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  const live = detail === null ? true : renderStateVisual(detail.jobState).live;
  useVisiblePolling(() => void load(), DETAIL_POLL_MS, live, jobId);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const stages = detail ? renderPipelineStages(detail.events, detail.jobState) : [];
  const newest = detail ? latestRenderEvent(detail.events) : null;
  const attempt = detail?.attempts.at(-1) ?? null;
  const playable = detail?.artifacts.some(
    (artifact) => artifact.mediaType.startsWith("video/") && artifact.artifactState === "available",
  ) ?? false;
  // `now` is read through these so the interval above actually re-renders the elapsed figures.
  const sinceStart = detail
    ? formatElapsed(detail.startedAt ?? detail.createdAt, detail.completedAt ?? new Date(now).toISOString())
    : "—";
  const sinceEvent = newest ? formatElapsed(newest.createdAt, new Date(now).toISOString()) : null;
  const progressRecord = detail?.progressDetail ?? null;
  const progressStage = progressRecord && "stage" in progressRecord ? progressRecord.stage : null;
  const progressAmount = progressRecord?.event === "stage.progress"
    ? `${progressRecord.completed}/${progressRecord.total} ${progressRecord.unit}`
    : null;
  const elapsedSeconds = detail
    ? Math.max(0, (Date.parse(detail.completedAt ?? new Date(now).toISOString()) - Date.parse(detail.startedAt ?? detail.createdAt)) / 1000)
    : 0;
  const etaSeconds = progressRecord?.event === "stage.progress" && progressRecord.completed > 0
    ? Math.max(0, elapsedSeconds * (progressRecord.total - progressRecord.completed) / progressRecord.completed)
    : null;
  const latestSensor = progressRecord?.event === "artifact.ready" && progressRecord.identity.actorId !== null
    ? `${progressRecord.identity.actorId}/${progressRecord.identity.sensorId} · ${progressRecord.identity.modality}`
    : null;

  return (
    <section
      aria-label="Render progress"
      className="render-view-enter flex min-h-0 flex-1 flex-col overflow-hidden"
      data-render-job-id={jobId}
      data-render-state={detail?.jobState ?? "loading"}
      data-testid="render-progress-view"
    >
      <header className="flex shrink-0 items-center gap-3 border-b render-hairline px-6 py-3">
        <button
          aria-label="Back to the render gallery"
          className="editor-motion grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="render-progress-back"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-micro font-bold uppercase tracking-meta text-primary/90">
            {detail ? jobModeLabel(detail.jobMode) : "Render"}
          </p>
          <h2 className="truncate text-base font-extrabold leading-tight tracking-tight text-foreground">
            {detail ? renderStateVisual(detail.jobState).label : "Reading status…"}
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{sinceStart}</span>
          </h2>
        </div>
        {detail ? <RenderStateChip state={detail.jobState} /> : <CloudActivityIndicator />}
        {playable ? (
          <button
            className="editor-motion inline-flex h-8 shrink-0 items-center gap-1.5 bg-primary px-3 text-micro font-bold uppercase tracking-meta text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="render-progress-watch"
            onClick={() => onWatch(jobId)}
            type="button"
          >
            <Play aria-hidden="true" className="size-3.5" />
            Watch
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {error !== null && detail === null ? (
          <p className="border border-dashed render-hairline px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}

        {detail ? (
          <>
            <RenderProgressBar
              className="mb-1"
              label="Render progress"
              progressPercent={detail.progressPercent}
              state={detail.jobState}
            />
            <p className="mb-4 flex flex-wrap items-baseline gap-x-3 text-micro text-muted-foreground">
              <span data-testid="render-progress-percent">
                {detail.progressPercent == null
                  ? "No percentage reported yet"
                  : `${Math.round(detail.progressPercent)}% reported`}
              </span>
              {sinceEvent !== null ? (
                <span data-testid="render-progress-heartbeat">
                  Last event {humanizeCode(newest!.eventKind).toLowerCase()} · {sinceEvent} ago
                </span>
              ) : (
                <span data-testid="render-progress-heartbeat">No events yet</span>
              )}
              {progressStage ? <span>Phase {humanizeCode(progressStage).toLowerCase()}</span> : null}
              {progressAmount ? <span>{progressAmount}</span> : null}
              {etaSeconds !== null ? <span>ETA {Math.ceil(etaSeconds)}s</span> : null}
              {latestSensor ? <span>Sensor {latestSensor}</span> : null}
              {error !== null ? <span className="text-destructive">Status read failed · retrying</span> : null}
            </p>

            <ol className="mb-4 grid gap-0" data-testid="render-progress-stages">
              {stages.map((stage) => (
                <li
                  className={cn(
                    "flex items-baseline gap-2 border-l-2 py-1 pl-3 text-xs",
                    stage.state === "done"
                      ? "border-primary text-foreground"
                      : stage.state === "active"
                        ? "border-primary/60 text-foreground"
                        : "border-border text-muted-foreground",
                  )}
                  data-stage={stage.kind}
                  data-stage-state={stage.state}
                  key={stage.kind}
                >
                  <span aria-hidden="true" className="shrink-0">
                    {stage.state === "done" ? (
                      <Check className="size-3 text-primary" />
                    ) : stage.state === "active" ? (
                      <CloudActivityIndicator iconClassName="size-3" />
                    ) : (
                      <CircleDashed className="size-3 text-muted-foreground/60" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">
                    {stage.label}
                    <span className="ml-2 font-normal text-micro text-muted-foreground">{stage.hint}</span>
                  </span>
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {stage.at ? formatTimestamp(stage.at) : stage.state === "active" ? "waiting" : ""}
                  </span>
                </li>
              ))}
            </ol>

            {detail.failureCode !== null ? (
              <p
                className="mb-4 flex items-start gap-2 border border-destructive/40 px-3 py-2 text-xs text-destructive"
                data-testid="render-progress-failure"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {failureMessage(detail.failureCode) ?? humanizeCode(detail.failureCode)}
                  <span className="ml-1 font-mono text-micro opacity-80">({detail.failureCode})</span>
                </span>
              </p>
            ) : null}

            <dl className="mb-4 grid gap-x-4 gap-y-1 text-micro sm:grid-cols-2" data-testid="render-progress-facts">
              <Fact label="Attempt" value={`${detail.attemptCount} of ${detail.maxAttempts}`} />
              <Fact
                label="Worker"
                value={attempt ? `${attempt.workerClass} · ${attempt.workerNodeId}` : "Not claimed yet"}
              />
              <Fact label="Queued" value={formatTimestamp(detail.createdAt)} />
              <Fact label="Started" value={detail.startedAt ? formatTimestamp(detail.startedAt) : "Not yet"} />
              <Fact label="Runtime" value={attempt ? attempt.runtimeVersion : "—"} />
              <Fact label="Controls" value={shortDigest(detail.executionPackageControlSha256)} />
              <Fact label="Engine" value={detail.rendererEngine ?? "—"} />
              <Fact label="Intent" value={detail.intentSha256 ? shortDigest(detail.intentSha256) : "—"} />
              <Fact
                label="Base image"
                value={attempt?.baseImageDigest ? shortDigest(attempt.baseImageDigest.replace(/^sha256:/, "")) : "—"}
              />
              <Fact
                label="linux/amd64"
                value={attempt?.baseImagePlatformDigest
                  ? shortDigest(attempt.baseImagePlatformDigest.replace(/^sha256:/, ""))
                  : "—"}
              />
            </dl>

            <div>
              <h3 className="mb-1 text-micro font-bold uppercase tracking-meta text-muted-foreground">
                Artifacts
                <span className="ml-2 font-normal normal-case tracking-normal">
                  {detail.artifacts.length === 0
                    ? live ? "none yet" : "none"
                    : `${detail.artifacts.length} so far`}
                </span>
              </h3>
              {detail.artifacts.length === 0 ? (
                <p className="text-micro text-muted-foreground">
                  {live
                    ? "Output appears here as the worker uploads it."
                    : "This render produced no artifacts."}
                </p>
              ) : (
                <ul className="grid gap-0.5" data-testid="render-progress-artifacts">
                  {detail.artifacts.map((artifact) => (
                    <li
                      className="flex items-baseline justify-between gap-2 border-b render-hairline py-1 text-xs last:border-b-0"
                      key={artifact.id}
                    >
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {artifact.identity?.actorId
                          ? `${artifact.identity.actorId}/${artifact.identity.sensorId} · ${artifact.identity.modality} · ${artifact.identity.role}`
                          : humanizeCode(artifact.identity?.role ?? artifact.artifactKind)}
                      </span>
                      <span className="shrink-0 font-mono text-micro text-muted-foreground">
                        {formatBytes(artifact.byteLength)} · {artifact.artifactState}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CloudActivityIndicator />
            Reading this render&apos;s status…
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b render-hairline py-1">
      <dt className="shrink-0 uppercase tracking-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-foreground">{value}</dd>
    </div>
  );
}
