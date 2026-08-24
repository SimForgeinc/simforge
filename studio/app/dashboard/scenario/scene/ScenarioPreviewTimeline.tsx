"use client";

import { Clapperboard, Pause, Play } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { SCENARIO_FLOATING_CARD_CLASSNAME } from "../floating-card";

export type ScenarioPreviewTimelinePlayback = {
  playing: boolean;
  time: number;
  startTime: number;
  endTime: number;
  disabled?: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
};

/**
 * The cinematic director's presentation surface.
 *
 * Cut markers are the honest way to show that the camera is on rails: the user
 * can see where the next angle change lands and scrub straight to it. Absent
 * when the scenario cannot be directed, so the control never promises a
 * sequence that does not exist.
 */
export type ScenarioPreviewTimelineCinematic = {
  available: boolean;
  enabled: boolean;
  shotLabel: string | null;
  /** Shot boundary times, in the same units as the playhead. */
  cutTimes: readonly number[];
  onToggle: () => void;
};

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

/** A list-only playback scrubber with no actor lanes or interaction clips. */
export function ScenarioPreviewTimeline({
  playback,
  cinematic,
}: {
  playback: ScenarioPreviewTimelinePlayback;
  cinematic?: ScenarioPreviewTimelineCinematic;
}) {
  const endTime = Math.max(playback.startTime + 0.1, playback.endTime);
  const time = Math.max(playback.startTime, Math.min(endTime, playback.time));

  return (
    <div
      aria-label="Scenario preview timeline"
      className={cn(
        SCENARIO_FLOATING_CARD_CLASSNAME,
        "relative isolate flex h-12 w-full items-center gap-2.5 overflow-hidden rounded-[20px] border-white/25 bg-black/15 px-2.5 text-white",
        "shadow-[0_18px_54px_-18px_rgba(0,0,0,0.78)] ring-1 ring-inset ring-white/[0.08] backdrop-blur-[72px] backdrop-saturate-[1.85] backdrop-contrast-[1.05]",
      )}
      data-testid="scenario-preview-timeline"
      role="group"
      style={{
        borderRadius: "20px",
        clipPath: "inset(0 round 20px)",
        backdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        WebkitBackdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
        data-testid="scenario-preview-timeline-glass"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-white/[0.11] via-white/[0.025] to-black/10" />
        <div className="absolute -left-8 -top-14 size-28 rounded-full bg-[#E8E044]/10 blur-3xl" />
        <div className="absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      </div>

      <button
        aria-label={playback.playing ? "Pause scenario preview" : "Play scenario preview"}
        className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white/85 shadow-none transition-[color,transform] hover:scale-110 hover:bg-transparent hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]/70 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100"
        disabled={playback.disabled}
        onClick={playback.onPlayPause}
        type="button"
      >
        {playback.playing ? (
          <Pause aria-hidden="true" className="size-4 fill-current" />
        ) : (
          <Play aria-hidden="true" className="ml-0.5 size-4 fill-current" />
        )}
      </button>

      <div className="relative z-10 flex min-w-0 flex-1 items-center">
        <input
          aria-label="Scenario preview time"
          className="relative z-10 h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-[#E8E044] [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[#E8E044] [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-black [&::-moz-range-thumb]:bg-[#E8E044] [&::-webkit-slider-thumb]:mt-[-3px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:bg-[#E8E044] [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full disabled:cursor-not-allowed disabled:opacity-45"
          disabled={playback.disabled}
          max={endTime}
          min={playback.startTime}
          onChange={(event) => playback.onSeek(Number(event.target.value))}
          step={0.1}
          type="range"
          value={time}
        />
        {cinematic?.enabled && cinematic.cutTimes.length > 0 ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-3 -translate-y-1/2" data-testid="scenario-preview-cut-markers">
            {cinematic.cutTimes.map((cutTime) => (
              <span
                className="absolute top-0 h-3 w-px -translate-x-1/2 bg-white/45"
                key={cutTime}
                style={{
                  left: `${((Math.max(playback.startTime, Math.min(endTime, cutTime)) - playback.startTime) / (endTime - playback.startTime)) * 100}%`,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <span className="relative z-10 shrink-0 font-mono text-[9px] tabular-nums text-white/65">
        {formatTime(time - playback.startTime)} / {formatTime(endTime - playback.startTime)}
      </span>

      {cinematic?.available ? (
        <button
          aria-label={cinematic.enabled ? "Turn off the cinematic camera" : "Turn on the cinematic camera"}
          aria-pressed={cinematic.enabled}
          className={cn(
            "relative z-10 flex h-7 shrink-0 items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[10px] font-medium shadow-none transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]/70",
            cinematic.enabled ? "text-[#E8E044]" : "text-white/55",
          )}
          data-cinematic-enabled={cinematic.enabled ? "true" : "false"}
          data-testid="scenario-preview-cinematic-toggle"
          onClick={cinematic.onToggle}
          title={cinematic.enabled ? "Cinematic camera on" : "Cinematic camera off"}
          type="button"
        >
          <Clapperboard aria-hidden="true" className="size-3.5" />
          {cinematic.enabled && cinematic.shotLabel ? (
            <span data-testid="scenario-preview-shot-label">{cinematic.shotLabel}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
