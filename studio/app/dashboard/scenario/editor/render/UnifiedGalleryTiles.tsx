"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Film, FlaskConical } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { downloadExportArtifact } from "@/app/lib/scenario/editor/api";
import { getBrowserRecordingClient as getBrowserRecording } from "@/app/lib/scenario/recording-client";
import { useNearViewport } from "./useArtifactPreviewUrl";
import { formatTimestamp } from "./render-view-model";
import type { BrowserRecordingSummaryDto } from "@/app/lib/scenario/recording-contracts";
import type { ScenarioValidationRunDto } from "./api";

/**
 * The non-managed cards of the unified render gallery. They share the managed tile's card anatomy —
 * aspect-video, tag chips top-left, gradient footer — so every render kind reads as one gallery
 * rather than three stacked sections.
 */

const RECORDING_STATE_CHIP: Record<BrowserRecordingSummaryDto["status"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-primary/20 text-primary" },
  succeeded: { label: "Done", className: "bg-primary/15 text-primary" },
  failed: { label: "Failed", className: "bg-destructive/20 text-destructive" },
  cancelled: { label: "Cancelled", className: "render-chip text-muted-foreground" },
};

export function RecordingGalleryTile({
  recording,
  onOpen,
}: {
  recording: BrowserRecordingSummaryDto;
  onOpen: () => void;
}) {
  const [cardRef, nearViewport] = useNearViewport<HTMLDivElement>();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [artifactRoles, setArtifactRoles] = useState<readonly string[]>([]);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The recording summary DTO deliberately carries no artifact URLs, so the hover-play preview is
  // resolved lazily — one detail read per finished tile, and only once it nears the viewport.
  useEffect(() => {
    if (!nearViewport || recording.status !== "succeeded" || detailLoaded) return;
    const abort = new AbortController();
    void getBrowserRecording(recording.id, abort.signal)
      .then((detail) => {
        const video = detail.artifacts.find((artifact) => artifact.role === "video" && artifact.downloadUrl);
        if (abort.signal.aborted) return;
        setArtifactRoles(detail.artifacts.map((artifact) => artifact.role));
        setDetailLoaded(true);
        if (video?.downloadUrl) setVideoUrl(video.downloadUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setDetailLoaded(true);
      });
    return () => abort.abort();
  }, [detailLoaded, nearViewport, recording.id, recording.status]);

  function play() {
    if (!videoUrl) return;
    window.requestAnimationFrame(() => {
      const result = videoRef.current?.play();
      if (result && typeof result.catch === "function") void result.catch(() => undefined);
    });
  }

  function reset() {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  }

  const chip = RECORDING_STATE_CHIP[recording.status];
  const progressPercent = Math.round(recording.progress * 100);

  return (
    <div
      ref={cardRef}
      className={cn(
        "editor-motion group relative flex aspect-video w-full flex-col render-glass render-surface-motion overflow-hidden border text-left",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background",
        recording.status === "failed" ? "border-destructive/60" : "render-lift hover:border-primary/60",
      )}
      data-testid="scenario-recording-tile"
      data-recording-id={recording.id}
      onMouseEnter={play}
      onMouseLeave={reset}
    >
      <button
        type="button"
        aria-label={`Open Three.js recording from ${formatTimestamp(recording.createdAt)}`}
        className="absolute inset-0 z-10 focus-visible:outline-none"
        onClick={onOpen}
        onFocus={play}
        onBlur={reset}
      />

      <div className="absolute inset-0 render-glass">
        {videoUrl ? (
          <video
            ref={videoRef}
            aria-hidden="true"
            className="size-full object-cover"
            loop
            muted
            playsInline
            preload="metadata"
            src={videoUrl}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="grid size-full place-items-center">
            <Film aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1">
        <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
          Three.js clip
        </span>
        <span className={cn("px-1.5 py-0.5 text-micro uppercase tracking-meta", chip.className)}>
          {chip.label}
        </span>
        {artifactRoles.includes("frames") ? (
          <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
            Frames
          </span>
        ) : null}
        {artifactRoles.includes("sensor_archive") ? (
          <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
            {artifactRoles.filter((role) => role === "sensor_archive").length} sensor archives
          </span>
        ) : null}
        {artifactRoles.includes("sensor_video") ? (
          <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
            {artifactRoles.filter((role) => role === "sensor_video").length} sensor videos
          </span>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 render-scrim px-2.5 pb-2 pt-6">
        {recording.status === "running" ? (
          <div
            aria-label="Recording progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressPercent}
            className="render-chip h-1"
            role="progressbar"
          >
            <div className="h-full bg-primary" style={{ width: `${Math.max(2, progressPercent)}%` }} />
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-meta text-foreground">{formatTimestamp(recording.createdAt)}</span>
          {recording.status === "running" ? (
            <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">
              {progressPercent}%
            </span>
          ) : null}
        </div>
        {recording.failureCode ? (
          <p className="line-clamp-2 text-micro text-destructive">
            {recording.failureCode.replaceAll("_", " ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const ESMINI_STATE_CHIP: Record<string, { label: string; className: string }> = {
  passed: { label: "Done", className: "bg-primary/15 text-primary" },
  running: { label: "Running", className: "bg-primary/20 text-primary" },
  queued: { label: "Queued", className: "bg-secondary text-secondary-foreground" },
  failed: { label: "Failed", className: "bg-destructive/20 text-destructive" },
  errored: { label: "Failed", className: "bg-destructive/20 text-destructive" },
};

export function EsminiGalleryTile({ run }: { run: ScenarioValidationRunDto }) {
  const chip = ESMINI_STATE_CHIP[run.validation_state] ?? {
    label: run.validation_state,
    className: "bg-secondary text-secondary-foreground",
  };
  const summary = (run.summary ?? {}) as {
    esmini?: { entities?: string[]; durationS?: number };
  };
  const detail = summary.esmini
    ? `${summary.esmini.entities?.length ?? 0} entities · ${summary.esmini.durationS ?? 0}s`
    : null;

  return (
    <div
      className={cn(
        "render-glass render-surface-motion group relative flex aspect-video w-full flex-col overflow-hidden border",
        run.validation_state === "failed" || run.validation_state === "errored"
          ? "border-destructive/60"
          : "render-lift hover:border-primary/60",
      )}
      data-testid="scenario-esmini-tile"
      data-esmini-run-state={run.validation_state}
    >
      <div className="absolute inset-0 grid place-items-center render-glass">
        <FlaskConical aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
      </div>

      <div className="pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1">
        <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
          esmini replay
        </span>
        <span className={cn("px-1.5 py-0.5 text-micro uppercase tracking-meta", chip.className)}>
          {chip.label}
        </span>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 render-scrim px-2.5 pb-2 pt-6">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-meta text-foreground">{formatTimestamp(run.created_at)}</span>
          {detail ? (
            <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">{detail}</span>
          ) : null}
        </div>
        {run.trace_artifact_id || run.report_artifact_id ? (
          <div className="flex items-center gap-1.5">
            {run.trace_artifact_id ? (
              <button
                className="editor-motion inline-flex items-center gap-1 render-glass render-glass-hover border px-2 py-1 text-micro uppercase tracking-meta text-foreground backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void downloadExportArtifact(run.trace_artifact_id!)}
                type="button"
              >
                <Download aria-hidden="true" className="size-3" />
                Trace
              </button>
            ) : null}
            {run.report_artifact_id ? (
              <button
                className="editor-motion inline-flex items-center gap-1 render-glass render-glass-hover border px-2 py-1 text-micro uppercase tracking-meta text-foreground backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void downloadExportArtifact(run.report_artifact_id!)}
                type="button"
              >
                <Download aria-hidden="true" className="size-3" />
                Report
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
