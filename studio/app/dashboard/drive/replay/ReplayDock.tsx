"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { AlertTriangle, Clock3, Play, Radio, RotateCcw, Square } from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { SelectMenuField } from "@/app/components/ui/select-menu";
import { Separator } from "@/app/components/ui/separator";
import { cn } from "@/app/lib/utils";
import type {
  TrajectoryPlaybackStatus,
  WorldClock,
  WorldSource,
} from "@/app/lib/live-world/types";

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8].map((speed) => ({
  value: String(speed),
  label: `${speed}×`,
}));
const CLOCK_STALE_AFTER_MS = 2_500;

export function ReplayDock(props: { source: WorldSource; className?: string }): JSX.Element | null {
  const { source, className } = props;
  if (!source.setReplay || !source.setLive || !source.subscribeClock) return null;
  return <RemoteReplayDock source={source} className={className} />;
}

function RemoteReplayDock({ source, className }: { source: WorldSource; className?: string }) {
  // Call these as members, never as detached references: they are methods on the
  // source and lose `this` the moment they are pulled off the object.
  const [clock, setClock] = useState<WorldClock>({ mode: "live", timeIso: null, speed: 1 });
  const [clockReceivedAt, setClockReceivedAt] = useState(0);
  const [clockStale, setClockStale] = useState(true);
  const [startLocal, setStartLocal] = useState(() => datetimeLocalValue(Date.now() - 60 * 60 * 1_000));
  const [speed, setSpeed] = useState("1");
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const dateBounds = useMemo(() => ({
    min: datetimeLocalValue(Date.now() - 24 * 60 * 60 * 1_000),
    max: datetimeLocalValue(Date.now()),
  }), []);

  useEffect(() => source.subscribeClock!((nextClock) => {
    setClock(nextClock);
    setClockReceivedAt(Date.now());
    setClockStale(false);
  }), [source]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockStale(clockReceivedAt === 0 || Date.now() - clockReceivedAt > CLOCK_STALE_AFTER_MS);
    }, 500);
    return () => window.clearInterval(timer);
  }, [clockReceivedAt]);

  const startReplay = async () => {
    setReplayBusy(true);
    setReplayError(null);
    try {
      const startIso = new Date(startLocal).toISOString();
      await source.setReplay!({ startIso, speed: Number(speed) });
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplayBusy(false);
    }
  };

  const goLive = async () => {
    setReplayBusy(true);
    setReplayError(null);
    try {
      await source.setLive!();
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplayBusy(false);
    }
  };

  return (
    <Card className={cn("w-[min(44rem,calc(100vw-2rem))] bg-card/95 shadow-2xl backdrop-blur-xl", className)}>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2">
          <Clock3 className="size-4 text-muted-foreground" aria-hidden="true" />
          Replay &amp; trajectory
        </CardTitle>
        <div className="col-start-2 row-span-2 row-start-1 flex items-center gap-2">
          <Badge variant={clock.mode === "replay" ? "secondary" : "outline"} className="gap-1.5 capitalize">
            <span className={cn("size-1.5 rounded-full", clock.mode === "live" ? "bg-emerald-500" : "bg-amber-500")} />
            {clock.mode}
          </Badge>
          {clockStale ? <Badge variant="destructive">Clock stale</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-end">
          <div className="min-w-0">
            <label htmlFor="drive-replay-start" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Start within the past 24 hours
            </label>
            <Input
              id="drive-replay-start"
              type="datetime-local"
              step="1"
              min={dateBounds.min}
              max={dateBounds.max}
              value={startLocal}
              onChange={(event) => setStartLocal(event.target.value)}
              disabled={replayBusy}
            />
          </div>
          <SelectMenuField
            id="drive-replay-speed"
            label="Speed"
            labelClassName="mb-1.5 text-xs font-medium"
            value={speed}
            options={SPEED_OPTIONS}
            onChange={setSpeed}
            disabled={replayBusy}
          />
          <Button onClick={startReplay} disabled={replayBusy || startLocal.length === 0}>
            <Play aria-hidden="true" />
            Replay
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Server clock</p>
            <p className="truncate font-mono text-sm text-foreground" title={clock.timeIso ?? undefined}>
              {clock.timeIso ? formatServerClock(clock.timeIso) : clock.mode === "live" ? "Live site time" : "Waiting for replay clock"}
            </p>
            {clock.mode === "replay" ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{clock.speed}× · updated only from twin clock messages</p>
            ) : null}
          </div>
          <Button variant="outline" size="sm" onClick={goLive} disabled={replayBusy || clock.mode === "live"}>
            <Radio aria-hidden="true" />
            Return to live
          </Button>
        </div>

        {replayError ? <ErrorMessage message={replayError} /> : null}
        <Separator />
        <TrajectoryControls source={source} />
      </CardContent>
    </Card>
  );
}

function TrajectoryControls({ source }: { source: WorldSource }) {
  const available = Boolean(
    source.listTrajectories
    && source.startTrajectory
    && source.stopTrajectory
    && source.subscribeTrajectoryStatus,
  );
  const [trajectories, setTrajectories] = useState<ReadonlyArray<{ file: string; name?: string }>>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<TrajectoryPlaybackStatus>({ active: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    return source.subscribeTrajectoryStatus!(setStatus);
  }, [available, source]);

  useEffect(() => {
    if (!available) return;
    let active = true;
    setError(null);
    source.listTrajectories!().then((items) => {
      if (!active) return;
      setTrajectories(items);
      setSelected((current) => current || items[0]?.file || "");
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => {
      active = false;
    };
  }, [available, source]);

  if (!available) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await source.startTrajectory!(selected);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await source.stopTrajectory!();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(false);
    }
  };

  const statusError = status.error ?? error;
  const progress = status.active && status.duration && status.elapsed !== undefined
    ? `${Math.min(status.elapsed, status.duration).toFixed(1)} / ${status.duration.toFixed(1)} s`
    : null;

  return (
    <section aria-labelledby="drive-trajectory-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="drive-trajectory-heading" className="text-sm font-semibold text-foreground">GPS trajectory</h3>
          <p className="text-xs text-muted-foreground">Play a recorded route in the shared world.</p>
        </div>
        <Badge variant={status.active ? "secondary" : "outline"}>
          {status.active ? status.finished ? "Finished" : "Playing" : "Stopped"}
        </Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <SelectMenuField
          label="Available trajectory"
          labelClassName="mb-1.5 text-xs font-medium"
          value={selected}
          options={trajectories.map((item) => ({ value: item.file, label: item.name ?? item.file }))}
          onChange={setSelected}
          placeholder={trajectories.length === 0 ? "No trajectories available" : "Select trajectory"}
          disabled={busy || status.active || trajectories.length === 0}
        />
        <Button variant="secondary" onClick={start} disabled={busy || status.active || selected.length === 0}>
          <Play aria-hidden="true" />
          Start
        </Button>
        <Button variant="outline" onClick={stop} disabled={busy || !status.active}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      </div>
      {status.active ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{status.name ?? selected}</span>
          {progress ? <span className="font-mono">{progress}</span> : null}
          {status.vehicleId ? <span className="font-mono">Actor {status.vehicleId}</span> : null}
        </div>
      ) : null}
      {statusError ? <ErrorMessage message={statusError} /> : null}
    </section>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function datetimeLocalValue(epochMs: number) {
  const date = new Date(epochMs);
  const localMs = epochMs - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 19);
}

function formatServerClock(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}
