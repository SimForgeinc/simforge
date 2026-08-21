"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";
import { Play, RotateCcw, Square } from "../icons";
import type { V1TimelineBrowserPlayback } from "./v1-timeline-rail";

export function TimelineTransportControls({
  playback,
  playDisabled = false,
  className,
}: {
  playback?: V1TimelineBrowserPlayback | null;
  playDisabled?: boolean;
  className?: string;
}) {
  const ready = Boolean(playback?.sessionId);
  const playing = Boolean(playback?.playing);

  return (
    <div
      className={cn("ueui-timeline-transport", className)}
      data-testid="timeline-transport-controls"
    >
      <TransportButton
        disabled={!ready || playDisabled}
        label={playing ? "Stop scenario" : "Play scenario"}
        onClick={() => {
          if (playing) playback?.onStop();
          else playback?.onPlay();
        }}
      >
        {playing ? (
          <Square aria-hidden="true" size={10} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play aria-hidden="true" size={12} fill="currentColor" strokeWidth={0} />
        )}
      </TransportButton>
      <TransportButton
        disabled={!ready}
        label="Reset scenario"
        onClick={() => playback?.onReset()}
      >
        <RotateCcw aria-hidden="true" size={12} />
      </TransportButton>
    </div>
  );
}

function TransportButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="ueui-timeline-transport-button"
      data-testid={`timeline-transport-${label.toLowerCase().replace(/\s+.*/, "")}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
