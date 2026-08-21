"use client";

import type { Choreography } from "@uniscenarios/scenario-model";
import { cn } from "../cn";
import { CarFront } from "../icons";
import type { V1TimelineCrashMarker } from "./v1-timeline-rail";

import {
  choreographyWindow,
  rangePercent,
  timelineTicks,
} from "./geometry-grid";

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
      className={cn("ueui-timeline-ruler", className)}
      data-testid="timeline-ruler"
    >
      {ticks.map((tick) => {
        const isOrigin = tick.timeMs === 0;
        const percent = rangePercent(tick.timeMs, window);
        return (
          <div
            key={tick.id}
            aria-hidden="true"
            className={isOrigin ? "ueui-timeline-tick ueui-timeline-tick-origin" : "ueui-timeline-tick"}
            style={{ left: `${percent}%` }}
          >
            {/*
              Labels hang to the right of their tick except the last one, which would otherwise
              overflow the column and be clipped. The edge variants flip the label to the inside
              rather than shrinking the rail to make room.
            */}
            <span
              data-testid={`timeline-tick-label-${tick.timeMs}`}
              className={
                isOrigin
                  ? "ueui-timeline-tick-label ueui-timeline-tick-label-origin"
                  : percent <= 0
                    ? "ueui-timeline-tick-label ueui-timeline-tick-label-left"
                    : percent >= 100
                      ? "ueui-timeline-tick-label ueui-timeline-tick-label-right"
                      : "ueui-timeline-tick-label ueui-timeline-tick-label-center"
              }
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
            className="ueui-timeline-crash-marker"
            data-testid="timeline-crash-marker"
            key={`${crash.timeS}-${actors.join("-")}-${index}`}
            role="img"
            style={{ left: `${percent}%` }}
            title={label}
          >
            <CarFront aria-hidden="true" size={10} strokeWidth={2.5} />
          </span>
        );
      })}
      {/*
        The axis is decorative for assistive tech — every interaction's timing is already stated in
        words on its own row by `triggerLabel`, so announcing tick positions would be noise, and a
        screen-reader user gets the times without needing the geometry.
      */}
      <span className="ueui-sr-only">
        Timeline over {choreography.clipSeconds} seconds.
      </span>
    </div>
  );
}
