"use client";

import type { Choreography } from "@simforge/scenario";
import { CarFront } from "lucide-react";
import { cn } from "@/app/lib/utils";
import type { V1TimelineCrashMarker } from "./V1TimelineRail";

import {
  choreographyWindow,
  rangePercent,
  timelineTicks,
} from "@/app/lib/scenario/timeline";

/**
 * The time axis above the interaction rows — manifest 84.
 *
 * It shares the same [0, clipSeconds] clock as browser playback.
 */
export function TimelineRuler({
  choreography,
  crashes = [],
  className,
}: {
  choreography: Choreography;
  crashes?: readonly V1TimelineCrashMarker[];
  className?: string;
}) {
  const window = choreographyWindow(choreography);
  const ticks = timelineTicks(window);

  return (
    <div
      className={cn("relative mb-1 h-5 select-none border-b border-white/10 bg-black/20", className)}
      data-testid="timeline-ruler"
    >
      {ticks.map((tick) => {
        const isOrigin = tick.timeMs === 0;
        const percent = rangePercent(tick.timeMs, window);
        const labelPosition = percent <= 0
          ? "left-0.5"
          : percent >= 100
            ? "right-0.5"
            : "left-1/2 -translate-x-1/2";
        return (
          <div
            key={tick.id}
            aria-hidden="true"
            className={`absolute inset-y-0 w-px ${isOrigin ? "bg-[#E8E044]/60" : "bg-white/10"}`}
            style={{ left: `${percent}%` }}
          >
            {/*
              Labels hang to the right of their tick except the last one, which would otherwise
              overflow the column and be clipped. `-translate-x-full` flips it to the left of the line
              rather than shrinking the rail to make room.
            */}
            <span
              data-testid={`timeline-tick-label-${tick.timeMs}`}
              className={`absolute top-1/2 -translate-y-1/2 font-mono text-[0.5625rem] leading-none ${
                isOrigin ? "text-white" : "text-white/35"
              } ${labelPosition}`}
            >
              {tick.title}
            </span>
          </div>
        );
      })}
      {crashes.map((crash, index) => {
        const percent = rangePercent(crash.timeS * 1000, window);
        const actors = crash.actorLabels.filter(Boolean);
        const actorSummary = actors.length > 0 ? ` involving ${actors.join(" and ")}` : "";
        const label = `Crash at ${crash.timeS.toFixed(1)} seconds${actorSummary}`;
        return (
          <span
            aria-label={label}
            className="absolute top-1/2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-red-300 bg-red-950 text-red-200 shadow-[0_0_8px_rgba(248,113,113,0.7)]"
            data-testid="timeline-crash-marker"
            key={`${crash.timeS}-${actors.join("-")}-${index}`}
            role="img"
            style={{ left: `${percent}%` }}
            title={label}
          >
            <CarFront aria-hidden="true" className="size-2.5" strokeWidth={2.5} />
          </span>
        );
      })}
      {/*
        The axis is decorative for assistive tech — every interaction's timing is already stated in
        words on its own row by `triggerLabel`, so announcing tick positions would be noise, and a
        screen-reader user gets the times without needing the geometry.
      */}
      <span className="sr-only">
        Timeline over {choreography.clipSeconds} seconds.
      </span>
    </div>
  );
}
