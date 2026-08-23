"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { cn } from "@/app/lib/utils";
import { useVideoGroupContext } from "./VideoGroupPlayer";

export function VideoPreviewTile({
  label,
  videoUrl,
  posterUrl,
  eyebrow,
  badge,
  className,
  emptyLabel = "No video",
  maxRetries = 3,
  preload,
  onError,
}: {
  label: string;
  videoUrl: string | null;
  posterUrl?: string | null;
  eyebrow?: string;
  badge?: ReactNode;
  className?: string;
  emptyLabel?: string;
  maxRetries?: number;
  preload?: "none" | "metadata" | "auto";
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const wasPlayingBeforeScrub = useRef(false);
  const retryCount = useRef(0);
  const lastUrl = useRef(videoUrl);
  const group = useVideoGroupContext();
  const synced = Boolean(group);

  const videoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoRef.current) group?.unregister(videoRef.current);
      videoRef.current = el;
      if (el) group?.register(el);
    },
    [group],
  );

  useEffect(() => {
    if (videoUrl === lastUrl.current) return;
    lastUrl.current = videoUrl;
    retryCount.current = 0;
    setHasError(false);
    setProgress(0);
  }, [videoUrl]);

  useEffect(() => {
    if (!scrubbing) return;

    function handleMove(event: MouseEvent) {
      seekToPosition(event.clientX);
    }

    function handleEnd() {
      setScrubbing(false);
      if (
        videoRef.current &&
        wasPlayingBeforeScrub.current &&
        hovering &&
        !hasError
      ) {
        void videoRef.current.play().catch(() => undefined);
      }
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
    };
  }, [hasError, hovering, scrubbing]);

  function handleEnter() {
    setHovering(true);
    if (synced) return;
    if (videoRef.current && videoUrl && !hasError && !scrubbing) {
      void videoRef.current.play().catch(() => undefined);
    }
  }

  function handleLeave() {
    if (scrubbing) return;
    setHovering(false);
    if (synced) return;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    setProgress(0);
  }

  function handleTimeUpdate() {
    if (synced) return;
    const video = videoRef.current;
    if (!video?.duration || scrubbing) return;
    setProgress(video.currentTime / video.duration);
  }

  function handleError() {
    if (retryCount.current < maxRetries && videoRef.current && videoUrl) {
      retryCount.current += 1;
      window.setTimeout(() => {
        if (!videoRef.current || !videoUrl) return;
        videoRef.current.src = videoUrl;
        videoRef.current.load();
      }, retryCount.current * 1000);
      return;
    }

    setHasError(true);
    onError?.();
  }

  function blockContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
  }

  function seekToPosition(clientX: number) {
    const video = videoRef.current;
    const progressEl = progressRef.current;
    if (!video?.duration || !progressEl) return;

    const rect = progressEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setProgress(ratio);
  }

  function handleScrubStart(event: ReactMouseEvent<HTMLDivElement>) {
    if (!videoRef.current) return;
    event.preventDefault();
    wasPlayingBeforeScrub.current = !videoRef.current.paused;
    videoRef.current.pause();
    setScrubbing(true);
    seekToPosition(event.clientX);
  }

  const showVideo = Boolean(videoUrl) && !hasError;

  return (
    <div
      className={cn(
        "group/video relative aspect-video overflow-hidden bg-black",
        className,
      )}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onContextMenu={blockContextMenu}
      role="figure"
    >
      {showVideo ? (
        <video
          ref={videoCallbackRef}
          className="block h-full w-full object-cover transition duration-300 group-hover/video:scale-[1.03] group-hover/video:brightness-110"
          src={videoUrl ?? undefined}
          poster={posterUrl ?? undefined}
          muted
          loop={!synced}
          playsInline
          preload={preload ?? (synced ? "auto" : posterUrl ? "none" : "metadata")}
          controlsList="nodownload"
          onContextMenu={blockContextMenu}
          onTimeUpdate={handleTimeUpdate}
          onError={handleError}
        >
          <track kind="captions" />
        </video>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-14 items-start justify-between gap-3 bg-gradient-to-b from-black/75 via-black/35 to-transparent px-3 py-2">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-white/55">
              {eyebrow}
            </div>
          ) : null}
          <div className="truncate text-xs font-semibold capitalize text-white drop-shadow">
            {label}
          </div>
        </div>
        {badge ? <div className="pointer-events-auto shrink-0">{badge}</div> : null}
      </div>

      {!synced && (
        <div
          ref={progressRef}
          className={cn(
            "absolute inset-x-0 bottom-0 z-30 flex h-4 cursor-pointer items-end opacity-0 transition-opacity group-hover/video:opacity-100",
            scrubbing && "opacity-100",
          )}
          onMouseDown={handleScrubStart}
        >
          <div
            className={cn(
              "h-[3px] w-full bg-white/15 transition-all hover:h-[5px]",
              scrubbing && "h-[5px]",
            )}
          >
            <div
              className="relative h-full bg-primary transition-[width] duration-75"
              style={{ width: `${progress * 100}%` }}
            >
              <div
                className={cn(
                  "absolute right-[-5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 scale-0 rounded-full bg-primary transition-transform group-hover/video:scale-100",
                  scrubbing && "scale-100",
                )}
              />
            </div>
          </div>
        </div>
      )}

      {!showVideo ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950 px-6 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
          {hasError ? "Video unavailable" : emptyLabel}
        </div>
      ) : null}
    </div>
  );
}
