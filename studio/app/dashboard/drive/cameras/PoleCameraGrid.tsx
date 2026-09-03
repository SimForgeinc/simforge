"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Lock,
  LoaderCircle,
  Pause,
  RefreshCw,
  RotateCcw,
  VideoOff,
  Unlock,
} from "lucide-react";
import type { SignalFeature } from "@simforge-oss/maps/signals";
import type { PoleCamera, PoleCameraRig, ResolvedCameraPose } from "@simforge-oss/maps/camera-rig";
import { findRigFeature, resolveCameraPose } from "@simforge-oss/maps/camera-rig";
import { PerspectiveCamera, Vector2, Vector4 } from "three";
import type { CityViewer } from "@simforge-oss/viewer";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import type { WorldClock } from "@/app/lib/live-world/types";
import { Separator } from "@/app/components/ui/separator";
import type { CameraFeedState, CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import { cn } from "@/app/lib/utils";
import {
  adjustmentFromCamera,
  applyCameraAdjustment,
  cameraAdjustmentKey,
  exportAdjustedRigs,
  loadCameraAdjustments,
  saveCameraAdjustments,
  wrapHeading,
  type CameraAdjustment,
  type CameraAdjustments,
} from "./camera-adjustments";
import {
  archiveClipWindow,
  archiveVideoUrl,
  shouldCorrectVideoDrift,
} from "../history/replay-helpers";


export interface PoleCameraGridProps {
  rigs: readonly PoleCameraRig[];
  features: readonly SignalFeature[];
  /** The surface's sole CityViewer. Camera panes render this viewer's scene. */
  viewer: CityViewer | null;
  clock?: WorldClock | null;
  archiveUrlTemplate?: string | null;
  feeds?: CameraFeeds | null;
  onFeedStatus?: (cameraId: string, mode: CameraFeedState) => void;
}

type DisplayStatus = CameraFeedState | "paused";
type ComparisonMode = "split" | "overlay";
type AdjustmentField =
  | "headingDeg"
  | "pitchDeg"
  | "mountHeightM"
  | "yawDeg"
  | "correctionPitchDeg"
  | "heightM"
  | "forwardM";

const VIDEO_FILE = /\.(?:mp4|webm|ogv)(?:$|[?#])/i;
const STATIC_IMAGE = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;

function StatusBadge({ status }: { status: DisplayStatus }) {
  if (status === "live") return <Badge>Live</Badge>;
  if (status === "replay") return <Badge variant="secondary">Replay</Badge>;
  if (status === "unavailable") return <Badge variant="destructive">Unavailable</Badge>;
  if (status === "paused") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <Pause aria-hidden="true" /> Paused
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <LoaderCircle className="animate-spin" aria-hidden="true" /> Starting
    </Badge>
  );
}

function FeedUnavailable({ reconnect }: { reconnect?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/40 p-5 text-center">
      <VideoOff className="size-7 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">Feed unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {reconnect
            ? "No frame is being shown. Check the source, then reconnect."
            : "No frame is being shown. Multiplexed feeds reconnect automatically."}
        </p>
      </div>
      {reconnect ? (
        <Button type="button" size="sm" variant="outline" onClick={reconnect}>
          <RefreshCw aria-hidden="true" /> Reconnect
        </Button>
      ) : null}
    </div>
  );
}

function FocusedCameraFeed({
  camera,
  active,
  onStatus,
  fill = false,
}: {
  camera: PoleCamera;
  active: boolean;
  onStatus?: PoleCameraGridProps["onFeedStatus"];
  fill?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CameraFeedState>(
    camera.streamUrl ? "starting" : "unavailable",
  );
  const streamUrl = camera.streamUrl;
  const displayStatus: DisplayStatus = active ? status : "paused";

  useEffect(() => {
    if (!streamUrl) {
      setStatus("unavailable");
      onStatus?.(camera.id, "unavailable");
      return;
    }
    if (!active) return;
    setStatus("starting");
    onStatus?.(camera.id, "starting");
  }, [active, attempt, camera.id, onStatus, streamUrl]);

  const report = (next: CameraFeedState) => {
    setStatus(next);
    onStatus?.(camera.id, next);
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-muted",
        fill && "h-full w-full",
      )}
      style={fill ? undefined : { aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
    >
      <div className="absolute end-2 top-2 z-10">
        <StatusBadge status={displayStatus} />
      </div>
      {!active ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          <Pause className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            Paused to preserve the browser connection budget.
          </p>
        </div>
      ) : !streamUrl ? (
        <FeedUnavailable />
      ) : status === "unavailable" ? (
        <FeedUnavailable reconnect={() => setAttempt((value) => value + 1)} />
      ) : VIDEO_FILE.test(streamUrl) ? (
        <video
          key={attempt}
          src={streamUrl}
          className="h-full w-full object-contain"
          autoPlay
          controls
          muted
          playsInline
          onLoadedMetadata={(event) => {
            report(Number.isFinite(event.currentTarget.duration) ? "replay" : "starting");
          }}
          onPlaying={(event) => {
            report(Number.isFinite(event.currentTarget.duration) ? "replay" : "live");
          }}
          onError={() => report("unavailable")}
        />
      ) : (
        // Unknown/image endpoints are the MJPEG path. Only an actual decoded
        // response promotes it to live; static image files are labelled replay.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={attempt}
          src={streamUrl}
          alt={`${camera.label ?? camera.id} camera feed`}
          className="h-full w-full object-contain"
          onLoad={() => report(STATIC_IMAGE.test(streamUrl) ? "replay" : "live")}
          onError={() => report("unavailable")}
        />
      )}
    </div>
  );
}

function ArchiveCameraFeed({
  camera,
  clock,
  archiveUrlTemplate,
  fill = false,
}: {
  camera: PoleCamera;
  clock: WorldClock;
  archiveUrlTemplate: string;
  fill?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  const clockMs = clock.timeIso === null ? Number.NaN : Date.parse(clock.timeIso);
  const clip = Number.isFinite(clockMs) ? archiveClipWindow(clockMs) : null;
  const src = clip ? archiveVideoUrl(archiveUrlTemplate, camera.id, clockMs) : null;

  useEffect(() => setUnavailable(false), [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      !video
      || !clip
      || !Number.isFinite(clockMs)
      || video.seeking
      || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }
    const targetTime = (clockMs - clip.startMs) / 1_000;
    if (shouldCorrectVideoDrift(video.currentTime, targetTime) && isVideoTimeSeekable(video, targetTime)) {
      video.currentTime = targetTime;
    }
    if (clock.speed === 0) {
      video.pause();
      return;
    }
    video.playbackRate = clock.speed;
    void video.play().catch(() => {
      // Autoplay can still be gated while metadata loads. The next
      // authoritative clock sample retries once the muted video is ready.
    });
  }, [clip, clock.speed, clockMs]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-muted",
        fill && "h-full w-full",
      )}
      style={fill ? undefined : { aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
    >
      <div className="absolute end-2 top-2 z-10">
        <StatusBadge status={clock.speed === 0 ? "paused" : "replay"} />
      </div>
      {src ? (
        <video
          ref={videoRef}
          key={src}
          src={src}
          className="block h-full w-full object-contain"
          muted
          playsInline
          preload="auto"
          data-archive-camera={camera.id}
          onLoadedMetadata={(event) => {
            if (!clip || !Number.isFinite(clockMs)) return;
            const targetTime = (clockMs - clip.startMs) / 1_000;
            if (isVideoTimeSeekable(event.currentTarget, targetTime)) {
              event.currentTarget.currentTime = targetTime;
            }
            if (clock.speed > 0) {
              event.currentTarget.playbackRate = clock.speed;
              void event.currentTarget.play().catch(() => {
                // A later clock sample retries muted autoplay.
              });
            }
          }}
          onError={() => setUnavailable(true)}
        />
      ) : null}
      {unavailable || !src ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/90 p-4 text-center">
          <div>
            <VideoOff className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-medium text-foreground">No recording</p>
            <p className="mt-1 text-[10px] text-muted-foreground">No archived video covers this time.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isVideoTimeSeekable(video: HTMLVideoElement, targetTime: number): boolean {
  for (let index = 0; index < video.seekable.length; index += 1) {
    if (video.seekable.start(index) <= targetTime && targetTime <= video.seekable.end(index)) return true;
  }
  return false;
}

function MultiplexedCameraFeed({
  camera,
  feeds,
  status,
  fill = false,
}: {
  camera: PoleCamera;
  feeds: CameraFeeds;
  status: CameraFeedState;
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return feeds.subscribeFrames(camera.id, (frame) => {
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      canvas.getContext("2d")?.drawImage(frame, 0, 0, frame.width, frame.height);
    });
  }, [camera.id, feeds]);

  useEffect(() => {
    if (status === "live" || status === "replay") return;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [status]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-muted",
        fill && "h-full w-full",
      )}
      style={fill ? undefined : { aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
    >
      <div className="absolute end-2 top-2 z-10">
        <StatusBadge status={status} />
      </div>
      <canvas
        ref={canvasRef}
        className="block h-full w-full object-contain"
        aria-label={`${camera.label ?? camera.id} multiplexed camera feed`}
      />
      {status === "unavailable" ? (
        <div className="absolute inset-0">
          <FeedUnavailable />
        </div>
      ) : status === "starting" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-xs text-muted-foreground">
          Waiting for the first decoded frame…
        </div>
      ) : null}
    </div>
  );
}

interface CameraPane {
  readonly canvas: HTMLCanvasElement;
  readonly camera: PerspectiveCamera;
}

function applyResolvedPose(cameraObject: PerspectiveCamera, pose: ResolvedCameraPose): void {
  cameraObject.position.set(...pose.position);
  cameraObject.up.set(0, 1, 0);
  cameraObject.lookAt(...pose.target);
  cameraObject.fov = pose.verticalFovDeg;
  cameraObject.updateProjectionMatrix();
  cameraObject.updateMatrixWorld(true);
}

function TwinView({
  camera,
  pose,
  cameraKey,
  unlocked,
  adjustment,
  onAdjustmentChange,
  registerPane,
  fill = false,
}: {
  camera: PoleCamera;
  pose: ResolvedCameraPose;
  cameraKey: string;
  unlocked: boolean;
  adjustment: CameraAdjustment;
  onAdjustmentChange: (adjustment: CameraAdjustment) => void;
  registerPane: (key: string, pane: CameraPane | null) => void;
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraObjectRef = useRef<PerspectiveCamera | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const latestAdjustmentRef = useRef(adjustment);
  const latestPoseRef = useRef(pose);
  latestPoseRef.current = pose;
  latestAdjustmentRef.current = adjustment;
  if (!cameraObjectRef.current) cameraObjectRef.current = new PerspectiveCamera();
  const poseBytes = JSON.stringify({
    position: pose.position,
    target: pose.target,
    verticalFovDeg: pose.verticalFovDeg,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const cameraObject = cameraObjectRef.current;
    if (!canvas || !cameraObject) return;
    registerPane(cameraKey, { canvas, camera: cameraObject });
    return () => registerPane(cameraKey, null);
  }, [cameraKey, registerPane]);

  useEffect(() => {
    const cameraObject = cameraObjectRef.current;
    if (cameraObject) applyResolvedPose(cameraObject, latestPoseRef.current);
  }, [poseBytes]);

  const changeByInput = (yawDelta: number, pitchDelta: number, forwardDelta: number) => {
    const current = latestAdjustmentRef.current;
    onAdjustmentChange({
      ...current,
      correction: {
        ...current.correction,
        yawDeg: Math.min(45, Math.max(-45, current.correction.yawDeg + yawDelta)),
        pitchDeg: Math.min(45, Math.max(-45, current.correction.pitchDeg + pitchDelta)),
        forwardM: Math.min(10, Math.max(-10, current.correction.forwardM + forwardDelta)),
      },
    });
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-muted",
        unlocked && "ring-1 ring-primary",
        fill && "h-full w-full",
      )}
      style={fill ? undefined : { aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
    >
      <div className="absolute start-2 top-2 z-10">
        <Badge variant={unlocked ? "default" : "outline"} className="gap-1 bg-background/80">
          {unlocked ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}
          {unlocked ? "Aiming" : "Locked"}
        </Badge>
      </div>
      <canvas
        ref={canvasRef}
        className={cn("block h-full w-full", unlocked && "cursor-crosshair focus-visible:outline-none")}
        aria-label={`${camera.label ?? camera.id} calibrated digital twin view, ${unlocked ? "aiming" : "locked"}`}
        data-camera-key={cameraKey}
        data-camera-pose={poseBytes}
        tabIndex={unlocked ? 0 : -1}
        onKeyDown={(event) => {
          if (!unlocked) return;
          const key = event.key.toLowerCase();
          if (!["w", "a", "s", "d"].includes(key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (key === "w") changeByInput(0, 0, 0.25);
          if (key === "s") changeByInput(0, 0, -0.25);
          if (key === "a") changeByInput(-1, 0, 0);
          if (key === "d") changeByInput(1, 0, 0);
        }}
        onPointerDown={(event) => {
          if (!unlocked) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (!unlocked || !dragRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.preventDefault();
          event.stopPropagation();
          const previous = dragRef.current;
          dragRef.current = { x: event.clientX, y: event.clientY };
          changeByInput((event.clientX - previous.x) * 0.15, (previous.y - event.clientY) * 0.15, 0);
        }}
        onPointerUp={(event) => {
          if (!unlocked) return;
          event.stopPropagation();
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
    </div>
  );
}

function NumberAndSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  heading = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  heading?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);

  const accept = (candidate: number) => {
    if (!Number.isFinite(candidate)) return;
    onChange(heading ? wrapHeading(candidate) : Math.min(max, Math.max(min, candidate)));
  };

  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(8rem,2fr)_6.5rem] items-center gap-3">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={heading ? wrapHeading(value) : value}
        onChange={(event) => accept(Number(event.currentTarget.value))}
        className="h-1 w-full cursor-pointer appearance-none bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            setDraft(nextDraft);
            if (nextDraft.trim() !== "") accept(Number(nextDraft));
          }}
          onBlur={() => {
            setEditing(false);
            setDraft(String(value));
          }}
          className="h-8 pe-7 font-mono text-xs tabular-nums"
        />
        <span className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {unit}
        </span>
      </div>
    </div>
  );
}

function readAdjustmentField(adjustment: CameraAdjustment, field: AdjustmentField): number {
  if (field === "headingDeg") return adjustment.headingDeg;
  if (field === "pitchDeg") return adjustment.pitchDeg;
  if (field === "mountHeightM") return adjustment.mountHeightM;
  if (field === "yawDeg") return adjustment.correction.yawDeg;
  if (field === "correctionPitchDeg") return adjustment.correction.pitchDeg;
  if (field === "heightM") return adjustment.correction.heightM;
  return adjustment.correction.forwardM;
}

function writeAdjustmentField(
  adjustment: CameraAdjustment,
  field: AdjustmentField,
  value: number,
): CameraAdjustment {
  if (field === "headingDeg" || field === "pitchDeg" || field === "mountHeightM") {
    return { ...adjustment, [field]: value };
  }
  const correctionField = field === "correctionPitchDeg" ? "pitchDeg" : field;
  return { ...adjustment, correction: { ...adjustment.correction, [correctionField]: value } };
}

function CameraAimControls({
  camera,
  adjustment,
  pose,
  onChange,
  onReset,
}: {
  camera: PoleCamera;
  adjustment: CameraAdjustment;
  pose: ResolvedCameraPose;
  onChange: (adjustment: CameraAdjustment) => void;
  onReset: () => void;
}) {
  const control = (
    field: AdjustmentField,
    label: string,
    min: number,
    max: number,
    step: number,
    unit: string,
    heading = false,
  ) => (
    <NumberAndSlider
      key={field}
      label={label}
      value={readAdjustmentField(adjustment, field)}
      min={min}
      max={max}
      step={step}
      unit={unit}
      heading={heading}
      onChange={(value) => onChange(writeAdjustmentField(adjustment, field, value))}
    />
  );

  return (
    <section className="mt-4 border-t border-border pt-4" aria-label={`${camera.label ?? camera.id} aim controls`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Manual aim</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Every change writes through to the twin view immediately.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange({ ...adjustment, headingDeg: wrapHeading(adjustment.headingDeg - 5) })}
            aria-label="Rotate heading left 5 degrees"
          >
            −5°
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange({ ...adjustment, headingDeg: wrapHeading(adjustment.headingDeg + 5) })}
            aria-label="Rotate heading right 5 degrees"
          >
            +5°
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onReset}>
            <RotateCcw aria-hidden="true" /> Reset
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {control("headingDeg", "Compass heading", 0, 360, 0.1, "°", true)}
        {control("pitchDeg", "Mount pitch", -89, 10, 0.1, "°")}
        {control("mountHeightM", "Mount height", 0.5, 20, 0.05, "m")}
        {control("yawDeg", "Correction yaw", -45, 45, 0.1, "°")}
        {control("correctionPitchDeg", "Correction pitch", -45, 45, 0.1, "°")}
        {control("heightM", "Correction height", -5, 5, 0.01, "m")}
        {control("forwardM", "Correction forward", -10, 10, 0.05, "m")}
      </div>
      <Separator className="my-4" />
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resolved camera</h4>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Scene yaw (heading + yaw − 90)</dt>
            <dd className="mt-1 font-mono tabular-nums text-foreground">{pose.yawDeg.toFixed(3)}°</dd>
          </div>
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Vertical FOV (intrinsics)</dt>
            <dd className="mt-1 font-mono tabular-nums text-foreground">{pose.verticalFovDeg.toFixed(3)}°</dd>
          </div>
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Scene position [x, y, z]</dt>
            <dd className="mt-1 font-mono tabular-nums text-foreground">
              [{pose.position.map((value) => value.toFixed(3)).join(", ")}] m
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Comparison({
  camera,
  pose,
  cameraKey,
  adjustment,
  onAdjustmentChange,
  registerPane,
  feeds,
  clock,
  archiveUrlTemplate,
  feedStatus,
  active,
  mode,
  overlayOpacity,
  onOverlayOpacityChange,
  onFeedStatus,
}: {
  camera: PoleCamera;
  pose: ResolvedCameraPose;
  cameraKey: string;
  adjustment: CameraAdjustment;
  onAdjustmentChange: (adjustment: CameraAdjustment) => void;
  registerPane: (key: string, pane: CameraPane | null) => void;
  feeds?: CameraFeeds | null;
  clock?: WorldClock | null;
  archiveUrlTemplate?: string | null;
  feedStatus: CameraFeedState;
  active: boolean;
  mode: ComparisonMode;
  overlayOpacity: number;
  onOverlayOpacityChange: (opacity: number) => void;
  onFeedStatus?: PoleCameraGridProps["onFeedStatus"];
}) {
  const real = clock?.mode === "replay" && archiveUrlTemplate ? (
    <ArchiveCameraFeed
      camera={camera}
      clock={clock}
      archiveUrlTemplate={archiveUrlTemplate}
      fill={mode === "overlay"}
    />
  ) : feeds ? (
    <MultiplexedCameraFeed camera={camera} feeds={feeds} status={feedStatus} fill={mode === "overlay"} />
  ) : (
    <FocusedCameraFeed camera={camera} active={active} onStatus={onFeedStatus} fill={mode === "overlay"} />
  );
  const twin = (
    <TwinView
      camera={camera}
      pose={pose}
      cameraKey={cameraKey}
      unlocked={active}
      adjustment={adjustment}
      onAdjustmentChange={onAdjustmentChange}
      registerPane={registerPane}
      fill={mode === "overlay"}
    />
  );
  if (mode === "overlay") {
    return (
      <div>
        <div
          className="relative overflow-hidden rounded-md bg-muted"
          style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
        >
          <div className="absolute inset-0">{twin}</div>
          <div className="absolute inset-0" style={{ opacity: overlayOpacity }}>{real}</div>
          <Badge variant="outline" className="absolute start-2 top-2 z-20 bg-background/80">Real over twin</Badge>
        </div>
        <label className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          Real opacity
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(event) => onOverlayOpacityChange(Number(event.currentTarget.value))}
            className="h-1 flex-1 cursor-pointer appearance-none bg-muted accent-primary"
            aria-label="Real camera overlay opacity"
          />
          <span className="w-9 text-end font-mono tabular-nums">{Math.round(overlayOpacity * 100)}%</span>
        </label>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <section aria-label="Real camera feed">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Real</p>
        {real}
      </section>
      <section aria-label="Digital twin camera view">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Twin</p>
        {twin}
      </section>
    </div>
  );
}
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "fixed -start-[9999px] top-0 opacity-0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}

export function PoleCameraGrid({
  rigs,
  features,
  viewer,
  clock = null,
  archiveUrlTemplate = null,
  feeds = null,
  onFeedStatus,
}: PoleCameraGridProps) {
  const [adjustments, setAdjustments] = useState<CameraAdjustments>(() =>
    loadCameraAdjustments(typeof window === "undefined" ? null : window.localStorage),
  );
  const [feedStates, setFeedStates] = useState<Readonly<Record<string, CameraFeedState>>>(() => feeds?.states ?? {});
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("split");
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [storageError, setStorageError] = useState<string | null>(null);
  const panesRef = useRef(new Map<string, CameraPane>());
  const rootRef = useRef<HTMLDivElement>(null);
  const onFeedStatusRef = useRef(onFeedStatus);
  onFeedStatusRef.current = onFeedStatus;

  const registerPane = useCallback((key: string, pane: CameraPane | null) => {
    if (pane) panesRef.current.set(key, pane);
    else panesRef.current.delete(key);
  }, []);

  useEffect(() => {
    if (!viewer) return;
    const renderer = viewer.renderer;
    let frameRequest = 0;
    let lastRenderMs = 0;
    const renderPanes = (now: number) => {
      frameRequest = window.requestAnimationFrame(renderPanes);
      if (now - lastRenderMs < 1000 / 15) return;
      const panes = [...panesRef.current.values()].filter((pane) => pane.canvas.isConnected);
      if (panes.length === 0) return;
      lastRenderMs = now;

      const previousSize = renderer.getSize(new Vector2());
      const previousPixelRatio = renderer.getPixelRatio();
      const previousViewport = renderer.getViewport(new Vector4());
      const previousScissor = renderer.getScissor(new Vector4());
      const previousScissorTest = renderer.getScissorTest();
      const desiredPasses = panes.map((pane) => {
        const bounds = pane.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.min(640, Math.round(bounds.width)));
        const height = Math.max(1, Math.round(width * bounds.height / Math.max(1, bounds.width)));
        return { pane, width, height };
      });
      const desiredWidth = desiredPasses.reduce((sum, { width }) => sum + width, 0);
      const desiredHeight = Math.max(...desiredPasses.map(({ height }) => height));
      const scale = Math.min(1, previousSize.x / desiredWidth, previousSize.y / desiredHeight);
      const renderPasses = desiredPasses.map(({ pane, width, height }) => ({
        pane,
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
      }));

      // Never resize the shared drawing buffer here. Reallocating it for this
      // atlas every frame eventually loses the WebGL context for the World view.
      try {
        renderer.setScissorTest(true);
        let x = 0;
        for (const { pane, width, height } of renderPasses) {
          pane.camera.aspect = width / height;
          pane.camera.updateProjectionMatrix();
          renderer.setViewport(x, 0, width, height);
          renderer.setScissor(x, 0, width, height);
          renderer.render(viewer.scene, pane.camera);
          const context = pane.canvas.getContext("2d");
          if (pane.canvas.width !== width) pane.canvas.width = width;
          if (pane.canvas.height !== height) pane.canvas.height = height;
          const sourceX = Math.round(x * previousPixelRatio);
          const sourceY = renderer.domElement.height - Math.round(height * previousPixelRatio);
          const sourceWidth = Math.round(width * previousPixelRatio);
          const sourceHeight = Math.round(height * previousPixelRatio);
          context?.drawImage(
            renderer.domElement,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            width,
            height,
          );
          x += width;
        }
      } finally {
        renderer.setViewport(previousViewport);
        renderer.setScissor(previousScissor);
        renderer.setScissorTest(previousScissorTest);
      }
      if (rootRef.current) {
        rootRef.current.dataset.viewerCount = "1";
        rootRef.current.dataset.cameraObjectCount = String(panes.length);
        rootRef.current.dataset.viewerFps = viewer.getStats().fps.toFixed(2);
      }
    };
    frameRequest = window.requestAnimationFrame(renderPanes);
    return () => window.cancelAnimationFrame(frameRequest);
  }, [viewer]);
  useEffect(() => {
    if (!feeds) {
      setFeedStates({});
      return;
    }
    const receiveStates = (states: Readonly<Record<string, CameraFeedState>>) => {
      setFeedStates(states);
      for (const [cameraId, status] of Object.entries(states)) onFeedStatusRef.current?.(cameraId, status);
    };
    receiveStates(feeds.states);
    return feeds.subscribeStates(receiveStates);
  }, [feeds]);

  const configured = useMemo(
    () =>
      rigs.flatMap((rig) => {
        const feature = findRigFeature(features, rig);
        return rig.cameras.map((loadedCamera) => {
          const key = cameraAdjustmentKey(rig.featureId, loadedCamera.id);
          const adjustment = adjustments[key];
          const controls = adjustment ?? adjustmentFromCamera(loadedCamera);
          return {
            rig,
            loadedCamera,
            camera: applyCameraAdjustment(loadedCamera, controls),
            controls,
            adjusted: Boolean(adjustment),
            feature,
            key,
          };
        });
      }),
    [adjustments, features, rigs],
  );

  useEffect(() => {
    if (focusedKey && !configured.some((entry) => entry.key === focusedKey)) {
      setFocusedKey(null);
    }
  }, [configured, focusedKey]);

  const persist = useCallback((next: CameraAdjustments) => {
    setAdjustments(next);
    try {
      saveCameraAdjustments(window.localStorage, next);
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  if (configured.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-40 items-center justify-center p-6 text-sm text-muted-foreground">
          No pole camera rigs are configured for this world.
        </CardContent>
      </Card>
    );
  }

  return (
    <div ref={rootRef} className="space-y-4" data-viewer-count={viewer ? "1" : "0"}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Pole camera calibration</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Changes stay in this browser until the exported rig is moved into product configuration.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            const copied = await copyText(exportAdjustedRigs(rigs, adjustments));
            setCopyState(copied ? "copied" : "error");
            if (copied) window.setTimeout(() => setCopyState("idle"), 1800);
          }}
        >
          {copyState === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
          {copyState === "copied" ? "Rig JSON copied" : "Copy rig JSON"}
        </Button>
      </div>
      {copyState === "error" ? (
        <p role="alert" className="text-xs text-destructive">Clipboard access failed. Allow clipboard permission and try again.</p>
      ) : null}
      {storageError ? (
        <p role="alert" className="text-xs text-destructive">Camera adjustments could not be persisted: {storageError}</p>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {configured.map(({ rig, camera, loadedCamera, controls, adjusted, feature, key }) => {
          const focused = key === focusedKey;
          const pose = feature ? resolveCameraPose(feature, camera) : null;
          const feedStatus = feedStates[camera.id] ?? "starting";
          return (
            <Card key={key} className={cn(focused && "ring-1 ring-primary/50")}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {camera.label ?? camera.id}
                  {adjusted ? <Badge variant="secondary">Adjusted</Badge> : null}
                </CardTitle>
                <CardDescription>{rig.label ?? `Pole ${rig.featureId}`}</CardDescription>
                <CardAction className="flex items-center gap-2">
                  {focused ? (
                    <>
                      <div className="flex rounded-md border border-border p-0.5" aria-label="Camera comparison mode">
                        <Button
                          type="button"
                          size="sm"
                          variant={comparisonMode === "split" ? "secondary" : "ghost"}
                          onClick={() => setComparisonMode("split")}
                        >
                          Split
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={comparisonMode === "overlay" ? "secondary" : "ghost"}
                          onClick={() => setComparisonMode("overlay")}
                        >
                          Overlay
                        </Button>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => setFocusedKey(null)}>
                        <Lock aria-hidden="true" /> Stop aiming
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setFocusedKey(key)}>
                      <Unlock aria-hidden="true" /> Aim this camera
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent>
                {feature && pose ? (
                  <>
                    <Comparison
                      camera={camera}
                      pose={pose}
                      cameraKey={key}
                      adjustment={controls}
                      onAdjustmentChange={(nextAdjustment) => persist({ ...adjustments, [key]: nextAdjustment })}
                      registerPane={registerPane}
                      feeds={feeds}
                      clock={clock}
                      archiveUrlTemplate={archiveUrlTemplate}
                      feedStatus={feedStatus}
                      active={focused}
                      mode={focused ? comparisonMode : "split"}
                      overlayOpacity={overlayOpacity}
                      onOverlayOpacityChange={setOverlayOpacity}
                      onFeedStatus={onFeedStatus}
                    />
                    {focused ? (
                      <CameraAimControls
                        camera={camera}
                        adjustment={controls}
                        pose={pose}
                        onChange={(nextAdjustment) => persist({ ...adjustments, [key]: nextAdjustment })}
                        onReset={() => {
                          const next = { ...adjustments };
                          delete next[key];
                          persist(next);
                        }}
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="flex min-h-36 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 p-5 text-center">
                    <div>
                      <AlertTriangle className="mx-auto size-6 text-destructive" aria-hidden="true" />
                      <p className="mt-2 text-sm font-medium text-foreground">Configured pole not found</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Feature {rig.featureId} is absent. This camera was not attached to a nearby pole.
                      </p>
                    </div>
                  </div>
                )}
                {!adjusted && focused ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Loaded values shown. The source rig remains unchanged until you move a control.
                  </p>
                ) : null}
                {adjusted && focused ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Reset restores the loaded definition for {loadedCamera.id} only.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
