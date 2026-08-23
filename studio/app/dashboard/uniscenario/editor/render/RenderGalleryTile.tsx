"use client";

import { useRef } from "react";
import { Camera, EyeOff, Film, Sparkles, Undo2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { RenderProgressBar, RenderStateChip } from "./RenderStatePieces";
import {
  failureMessage,
  formatTimestamp,
  galleryItemAccessibleName,
  isPostprocessMode,
  jobModeLabel,
} from "./render-view-model";
import { useArtifactPreviewUrl, useNearViewport } from "./useArtifactPreviewUrl";
import type { UniScenarioGalleryItemDto } from "@/app/lib/uniscenario/render/contracts";

/**
 * One render in the gallery — manifest #137, reshaped onto v2's control plane.
 *
 * v1's card carried a queue tier, an executor profile, a planned-camera count and a live log tail,
 * all of which came from `RuntimeJobRecord`. v2's gallery DTO deliberately carries none of that: it is
 * the narrow list DTO, and widening it to avoid a details fetch is exactly what a test forbids. So the
 * tile shows what the list *does* know — mode, state, progress, attempt count, artifact count,
 * lineage — and everything else lives one click away in the details panel.
 *
 * The hover-to-play preview is ported: poster until hover, then a muted looping `<video>`. It plays
 * on focus as well as hover so the affordance is not mouse-only.
 */
export function RenderGalleryTile({
  item,
  onOpen,
  onHide,
  hideBusy = false,
  outdated = false,
  onRestore,
  restoreBusy = false,
}: {
  item: UniScenarioGalleryItemDto;
  /** Opens this render's own view. The gallery has no selected state: opening replaces it. */
  onOpen: () => void;
  onHide: () => void;
  hideBusy?: boolean;
  /** The scenario has changed since this render's snapshot was frozen. */
  outdated?: boolean;
  /** Restores this render's snapshot over the open draft. Omit to hide the affordance. */
  onRestore?: () => void;
  restoreBusy?: boolean;
}) {
  const [cardRef, nearViewport] = useNearViewport<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isVideoPreview = item.previewMediaType?.startsWith("video/") ?? false;
  const isImagePreview = item.previewMediaType?.startsWith("image/") ?? false;
  const previewUrl = useArtifactPreviewUrl(
    item.previewArtifactId,
    nearViewport && (isVideoPreview || isImagePreview),
  );

  const failure = failureMessage(item.failureCode);
  const postprocess = isPostprocessMode(item.jobMode);

  function play() {
    if (!isVideoPreview || !previewUrl) return;
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

  return (
    <div
      ref={cardRef}
      className={cn(
        "render-glass render-surface-motion group relative flex aspect-video w-full flex-col overflow-hidden border text-left",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background",
        // Lift on hover. The gallery is a wall of near-identical stills, so the tile under the
        // pointer has to separate itself from its neighbours by more than a border colour.
        "render-lift hover:border-primary/60",
        item.jobState === "failed" ? "border-destructive/60" : "",
      )}
      data-testid="uniscenario-render-tile"
      data-render-job-id={item.id}
      onMouseEnter={play}
      onMouseLeave={reset}
    >
      {/* The whole tile is one button so the accessible name covers the picture and every chip; the
          hide control is a sibling, never nested, because a button inside a button is not focusable. */}
      <button
        type="button"
        aria-label={galleryItemAccessibleName(item)}
        className="absolute inset-0 z-10 focus-visible:outline-none"
        onClick={onOpen}
        onFocus={play}
        onBlur={reset}
      />

      <div className="absolute inset-0 render-glass">
        {previewUrl && isImagePreview ? (
          // A presigned S3 URL on a per-request signature: `next/image` would try to proxy and cache
          // it through the optimizer, which is the one thing a 1h signature must not go through.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" aria-hidden="true" className="size-full object-cover" src={previewUrl} />
        ) : previewUrl && isVideoPreview ? (
          <video
            ref={videoRef}
            aria-hidden="true"
            className="size-full object-cover"
            loop
            muted
            playsInline
            poster={undefined}
            // metadata + a decoded first frame double as the poster; hover/focus starts playback.
            preload="metadata"
            src={previewUrl}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="grid size-full place-items-center">
            {postprocess ? (
              <Sparkles aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
            ) : item.previewArtifactId ? (
              <Film aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
            ) : (
              <Camera aria-hidden="true" className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1">
        <span className="render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground">
          {jobModeLabel(item.jobMode)}
        </span>
        <RenderStateChip state={item.jobState} />
        {item.attemptCount > 1 ? (
          <span
            className="render-chip px-1.5 py-0.5 text-micro uppercase tracking-meta text-muted-foreground"
            title={`Attempt ${item.attemptCount}`}
          >
            ×{item.attemptCount}
          </span>
        ) : null}
        {postprocess && item.modelFamily ? (
          <span className="bg-primary/15 px-1.5 py-0.5 text-micro uppercase tracking-meta text-primary">
            {item.modelFamily}
          </span>
        ) : null}
        {outdated ? (
          // The scenario moved on after this render. Stated on the tile rather than as a global
          // banner because it is a property of one render, and two renders of the same scenario can
          // disagree about it.
          <span
            className="bg-amber-500/20 px-1.5 py-0.5 text-micro uppercase tracking-meta text-amber-300"
            data-testid="uniscenario-render-outdated-pill"
            title="The scenario changed after this render. Its saved configuration can be restored."
          >
            Outdated
          </span>
        ) : null}
      </div>

      <button
        type="button"
        aria-label={`Hide this ${jobModeLabel(item.jobMode).toLowerCase()} from the gallery`}
        className="editor-motion absolute right-2 top-2 z-20 inline-flex size-7 items-center justify-center render-overlay-control opacity-0 backdrop-blur hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-40"
        disabled={hideBusy}
        onClick={onHide}
      >
        <EyeOff aria-hidden="true" className="size-3.5" />
      </button>

      {onRestore ? (
        <button
          type="button"
          aria-label={`Restore the scenario this ${jobModeLabel(item.jobMode).toLowerCase()} was rendered from`}
          className="editor-motion absolute right-11 top-2 z-20 inline-flex size-7 items-center justify-center render-overlay-control opacity-0 backdrop-blur hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-40"
          data-testid="uniscenario-render-restore"
          disabled={restoreBusy}
          onClick={onRestore}
          title="Restore this render's saved scenario"
        >
          <Undo2 aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 render-scrim px-2.5 pb-2 pt-6">
        <RenderProgressBar
          label={`${jobModeLabel(item.jobMode)} progress`}
          progressPercent={item.progressPercent}
          state={item.jobState}
        />
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-meta text-foreground">
            {formatTimestamp(item.createdAt)}
          </span>
          <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">
            {item.artifactCount} {item.artifactCount === 1 ? "file" : "files"}
          </span>
        </div>
        {failure ? (
          <p className="line-clamp-2 text-micro text-destructive">{failure}</p>
        ) : null}
      </div>
    </div>
  );
}
