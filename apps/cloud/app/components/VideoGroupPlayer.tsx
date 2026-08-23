"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { cn } from "@/app/lib/utils";

interface VideoGroupContextValue {
  register: (el: HTMLVideoElement) => void;
  unregister: (el: HTMLVideoElement) => void;
}

const VideoGroupCtx = createContext<VideoGroupContextValue | null>(null);

export function useVideoGroupContext() {
  return useContext(VideoGroupCtx);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function playableDuration(video: HTMLVideoElement | undefined) {
  const duration = video?.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : null;
}

function findTimingLeader(videos: HTMLVideoElement[]) {
  return videos.find((video) => playableDuration(video) != null) ?? videos[0];
}

export function VideoGroupPlayer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const videosRef = useRef(new Set<HTMLVideoElement>());
  const [videoCount, setVideoCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const wasPlayingRef = useRef(false);
  const rafId = useRef(0);

  const register = useCallback((el: HTMLVideoElement) => {
    videosRef.current.add(el);
    setVideoCount(videosRef.current.size);
  }, []);

  const unregister = useCallback((el: HTMLVideoElement) => {
    videosRef.current.delete(el);
    setVideoCount(videosRef.current.size);
  }, []);

  // RAF loop: sync progress from leader video and auto-loop
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafId.current);
      return;
    }

    function tick() {
      const videos = [...videosRef.current];
      const leader = findTimingLeader(videos);
      const leaderDuration = playableDuration(leader);
      if (leader && leaderDuration != null) {
        setProgress(leader.currentTime / leaderDuration);
        setDuration(leaderDuration);

        if (leader.ended) {
          for (const v of videos) {
            v.currentTime = 0;
            void v.play().catch(() => {});
          }
        }
      }
      rafId.current = requestAnimationFrame(tick);
    }

    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [playing]);

  // Update duration when video count changes; reset when all removed
  useEffect(() => {
    if (videoCount === 0) {
      setPlaying(false);
      setProgress(0);
      setDuration(0);
      return;
    }
    const leader = findTimingLeader([...videosRef.current]);
    const leaderDuration = playableDuration(leader);
    if (leaderDuration != null) setDuration(leaderDuration);
  }, [videoCount]);

  function seekAllTo(ratio: number) {
    const clamped = Math.max(0, Math.min(1, ratio));
    for (const v of videosRef.current) {
      if (v.duration) v.currentTime = clamped * v.duration;
    }
    setProgress(clamped);
  }

  function handlePlayPause() {
    if (playing) {
      for (const v of videosRef.current) v.pause();
      setPlaying(false);
    } else {
      for (const v of videosRef.current) void v.play().catch(() => {});
      setPlaying(true);
    }
  }

  function handleRestart() {
    seekAllTo(0);
    for (const v of videosRef.current) void v.play().catch(() => {});
    setPlaying(true);
  }

  function handleScrubStart(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    wasPlayingRef.current = playing;
    if (playing) {
      for (const v of videosRef.current) v.pause();
      setPlaying(false);
    }
    setScrubbing(true);
    const bar = progressBarRef.current;
    if (bar) {
      const rect = bar.getBoundingClientRect();
      seekAllTo((e.clientX - rect.left) / rect.width);
    }
  }

  // Scrub drag handling
  useEffect(() => {
    if (!scrubbing) return;

    function handleMove(e: MouseEvent) {
      const bar = progressBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      for (const v of videosRef.current) {
        if (v.duration) v.currentTime = ratio * v.duration;
      }
      setProgress(ratio);
    }

    function handleUp() {
      setScrubbing(false);
      if (wasPlayingRef.current) {
        for (const v of videosRef.current) void v.play().catch(() => {});
        setPlaying(true);
      }
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [scrubbing]);

  const currentTime = duration * progress;
  const hasVideos = videoCount > 0;

  return (
    <VideoGroupCtx.Provider value={{ register, unregister }}>
      <div className={cn("flex flex-col", className)}>
        {hasVideos && (
          <div className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-black/80 px-4 py-2">
            <button
              type="button"
              onClick={handlePlayPause}
              className="flex size-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              aria-label={playing ? "Pause all" : "Play all"}
            >
              {playing ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5 ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={handleRestart}
              className="flex size-7 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Restart"
            >
              <RotateCcw className="size-3" />
            </button>

            <span className="w-10 text-right font-mono text-xs text-white/60">
              {formatTime(currentTime)}
            </span>

            <div
              ref={progressBarRef}
              className="group/bar relative flex h-6 flex-1 cursor-pointer items-center"
              onMouseDown={handleScrubStart}
            >
              <div
                className={cn(
                  "h-[3px] w-full rounded-full bg-white/15 transition-all group-hover/bar:h-[5px]",
                  scrubbing && "h-[5px]",
                )}
              >
                <div
                  className="relative h-full rounded-full bg-primary transition-[width] duration-75"
                  style={{ width: `${progress * 100}%` }}
                >
                  <div
                    className={cn(
                      "absolute right-[-5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 scale-0 rounded-full bg-primary transition-transform group-hover/bar:scale-100",
                      scrubbing && "scale-100",
                    )}
                  />
                </div>
              </div>
            </div>

            <span className="w-10 font-mono text-xs text-white/60">
              {formatTime(duration)}
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </VideoGroupCtx.Provider>
  );
}
