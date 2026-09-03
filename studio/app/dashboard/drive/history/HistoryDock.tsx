"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import type { WorldClock, WorldReplayCapabilities, WorldSource } from "@/app/lib/live-world/types";
import {
  coverageTrackBackground,
  latestActivityMs,
  localDateTimeInputToIso,
  toLocalDateTimeInput,
  type DetectionCoverageBucket,
} from "./replay-helpers";

const COVERAGE_BUCKET_SECONDS = 300;
const LIVE_COVERAGE_REFRESH_MS = 60_000;
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

interface HistoryDockProps {
  source: WorldSource;
  capabilities: WorldReplayCapabilities;
  clock: WorldClock;
  replayError: string | null;
}


export function HistoryDock({ source, capabilities, clock, replayError }: HistoryDockProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedMs, setSelectedMs] = useState(() => Date.now() - 10 * 60_000);
  const [dateTimeDraft, setDateTimeDraft] = useState(() => toLocalDateTimeInput(Date.now() - 10 * 60_000));
  const [coverage, setCoverage] = useState<DetectionCoverageBucket[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seekRevision, setSeekRevision] = useState(0);
  const lastPlayingSpeed = useRef(1);
  const retentionMs = capabilities.retentionHours * 60 * 60 * 1_000;
  const startMs = nowMs - retentionMs;
  const replayClockMs = clock.timeIso ? Date.parse(clock.timeIso) : Number.NaN;
  const displayedMs = clock.mode === "replay" && Number.isFinite(replayClockMs) ? replayClockMs : selectedMs;

  useEffect(() => {
    if (clock.mode !== "replay" || !Number.isFinite(replayClockMs)) return;
    setSelectedMs(replayClockMs);
    setDateTimeDraft(toLocalDateTimeInput(replayClockMs));
    if (clock.speed > 0) lastPlayingSpeed.current = clock.speed;
  }, [clock.mode, clock.speed, replayClockMs]);

  const refreshCoverage = useCallback(async (signal?: AbortSignal) => {
    const url = new URL(capabilities.coverageUrl!);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(nowMs).toISOString());
    url.searchParams.set("bucket", String(COVERAGE_BUCKET_SECONDS));
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Detection coverage request failed (${response.status})`);
    const payload: unknown = await response.json();
    const buckets = parseCoverageBuckets(payload);
    if (!buckets) throw new Error("Detection coverage response is invalid");
    setCoverage(buckets);
    setLocalError(null);
  }, [capabilities.coverageUrl, nowMs, startMs]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCoverage(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setLocalError(error instanceof Error ? error.message : String(error));
    });
    if (clock.mode !== "live") return () => controller.abort();
    const interval = window.setInterval(() => setNowMs(Date.now()), LIVE_COVERAGE_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [clock.mode, refreshCoverage, seekRevision]);

  const seek = useCallback(async (targetMs: number, speed = clock.mode === "replay" ? clock.speed : 1) => {
    if (!source.setReplay) return;
    const clampedTarget = Math.max(startMs, Math.min(nowMs, targetMs));
    setBusy(true);
    setLocalError(null);
    try {
      await source.setReplay({ startIso: new Date(clampedTarget).toISOString(), speed });
      setSelectedMs(clampedTarget);
      setDateTimeDraft(toLocalDateTimeInput(clampedTarget));
      if (speed > 0) lastPlayingSpeed.current = speed;
      setSeekRevision((revision) => revision + 1);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [clock.mode, clock.speed, nowMs, source, startMs]);

  const setLive = useCallback(async () => {
    if (!source.setLive) return;
    setBusy(true);
    setLocalError(null);
    try {
      await source.setLive();
      const currentNow = Date.now();
      setNowMs(currentNow);
      setSelectedMs(currentNow);
      setDateTimeDraft(toLocalDateTimeInput(currentNow));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [source]);

  const paint = useMemo(
    () => coverageTrackBackground(coverage, startMs, nowMs),
    [coverage, nowMs, startMs],
  );
  const ticks = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((fraction) => startMs + retentionMs * fraction),
    [retentionMs, startMs],
  );
  const clockDate = new Date(displayedMs);
  const inlineError = replayError ?? localError;

  return (
    <Card className="pointer-events-auto w-full shadow-xl" data-testid="history-dock">
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" aria-label="Twin time mode">
            <Button type="button" size="sm" variant={clock.mode === "live" ? "secondary" : "ghost"} disabled={busy} onClick={() => void setLive()}>
              Live
            </Button>
            <Button type="button" size="sm" variant={clock.mode === "replay" ? "secondary" : "ghost"} disabled={busy} onClick={() => void seek(selectedMs, 1)}>
              History
            </Button>
          </div>
          <Badge variant={clock.mode === "replay" ? "secondary" : "outline"}>
            {clock.mode === "replay" ? `${clock.speed}×` : "Live"}
          </Badge>
          <div className="min-w-52 flex-1 text-xs tabular-nums">
            <p className="font-medium text-foreground" data-testid="history-clock-local">{clockDate.toLocaleString()}</p>
            <p className="text-muted-foreground" data-testid="history-clock-utc">{clockDate.toISOString()}</p>
          </div>
          <span className="text-xs text-muted-foreground"><span className="font-mono text-foreground">{clock.tracks}</span> tracks</span>
        </div>

        <div>
          <input
            type="range"
            min={startMs}
            max={nowMs}
            step={1_000}
            value={Math.max(startMs, Math.min(nowMs, displayedMs))}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setSelectedMs(value);
              setDateTimeDraft(toLocalDateTimeInput(value));
            }}
            onPointerUp={(event) => void seek(Number(event.currentTarget.value))}
            onKeyUp={(event) => void seek(Number(event.currentTarget.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ background: paint }}
            aria-label={`${capabilities.retentionHours} hour detection history`}
          />
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
            {ticks.map((tick) => <span key={tick}>{new Date(tick).toLocaleTimeString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="datetime-local"
            value={dateTimeDraft}
            min={toLocalDateTimeInput(startMs)}
            max={toLocalDateTimeInput(nowMs)}
            onChange={(event) => setDateTimeDraft(event.currentTarget.value)}
            className="h-8 w-auto font-mono text-xs"
            aria-label="Replay date and time"
          />
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
            const iso = localDateTimeInputToIso(dateTimeDraft);
            if (!iso) {
              setLocalError("Enter a valid local date and time");
              return;
            }
            void seek(Date.parse(iso));
          }}>Go</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || clock.mode !== "replay"} aria-label={clock.speed === 0 ? "Play history" : "Pause history"} onClick={() => void seek(displayedMs, clock.speed === 0 ? lastPlayingSpeed.current : 0)}>
            {clock.speed === 0 ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </Button>
          <div className="flex rounded-md border border-border p-0.5" aria-label="Replay speed">
            {REPLAY_SPEEDS.map((speed) => (
              <Button key={speed} type="button" size="sm" variant={clock.mode === "replay" && clock.speed === speed ? "secondary" : "ghost"} disabled={busy} onClick={() => void seek(displayedMs, speed)}>
                {speed}×
              </Button>
            ))}
          </div>
          <Button type="button" size="sm" variant="ghost" disabled={busy || latestActivityMs(coverage) === null} onClick={() => {
            const latest = latestActivityMs(coverage);
            if (latest !== null) void seek(latest);
          }}>Latest activity</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void seek(displayedMs - 30_000)}>−30s</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void seek(displayedMs + 30_000)}>+30s</Button>
        </div>
        {inlineError ? <p role="alert" className="text-xs text-destructive">{inlineError}</p> : null}
      </CardContent>
    </Card>
  );
}

function parseCoverageBuckets(payload: unknown): DetectionCoverageBucket[] | null {
  if (
    typeof payload !== "object"
    || payload === null
    || !("buckets" in payload)
    || !Array.isArray(payload.buckets)
  ) {
    return null;
  }
  return payload.buckets.flatMap((bucket) => {
    if (
      typeof bucket !== "object"
      || bucket === null
      || !("start" in bucket)
      || typeof bucket.start !== "string"
      || !("detections" in bucket)
      || typeof bucket.detections !== "number"
      || !("objects" in bucket)
      || typeof bucket.objects !== "number"
    ) {
      return [];
    }
    return [{ start: bucket.start, detections: bucket.detections, objects: bucket.objects }];
  });
}
