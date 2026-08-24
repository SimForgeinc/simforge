"use client";

import { Play, RotateCcw, Square } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import type { V1TimelineBrowserPlayback } from "./V1TimelineRail";

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
      className={cn(
        "flex items-center gap-1 text-white",
        className,
      )}
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
          <Square aria-hidden="true" className="size-2.5 fill-current" />
        ) : (
          <Play aria-hidden="true" className="size-3 fill-current" />
        )}
      </TransportButton>
      <TransportButton
        disabled={!ready}
        label="Reset scenario"
        onClick={() => playback?.onReset()}
      >
        <RotateCcw aria-hidden="true" className="size-3" />
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
    <Button
      aria-label={label}
      className="size-6 rounded-none border-0 bg-transparent p-0 text-white shadow-none hover:bg-transparent enabled:hover:text-[#E8E044] disabled:text-white/25"
      disabled={disabled}
      onClick={onClick}
      size="icon"
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}
