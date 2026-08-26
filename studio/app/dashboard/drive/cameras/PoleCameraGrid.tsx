"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, Pause, RefreshCw, VideoOff } from "lucide-react";
import type { SignalFeature } from "@simforge/maps";
import type { PoleCamera, PoleCameraRig } from "@simforge/maps/camera-rig";
import { findRigFeature, resolveCameraPose } from "@simforge/maps/camera-rig";
import type { CityViewer } from "@simforge/viewer";
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

export type PoleCameraViewerFactory = (
  canvas: HTMLCanvasElement,
) => CityViewer | Promise<CityViewer>;

export interface PoleCameraGridProps {
  rigs: readonly PoleCameraRig[];
  features: readonly SignalFeature[];
  viewerFactory: PoleCameraViewerFactory;
  onFeedStatus?: (
    cameraId: string,
    mode: "live" | "replay" | "starting" | "unavailable",
  ) => void;
}

type FeedStatus = "live" | "replay" | "starting" | "unavailable";
type DisplayStatus = FeedStatus | "paused";

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

function FeedUnavailable({
  reconnect,
}: {
  reconnect?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/40 p-5 text-center">
      <VideoOff className="size-7 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">Feed unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {reconnect
            ? "No frame is being shown. Check the source, then reconnect."
            : "No stream URL is configured for this camera."}
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

function CameraFeed({
  camera,
  active,
  onStatus,
}: {
  camera: PoleCamera;
  active: boolean;
  onStatus?: PoleCameraGridProps["onFeedStatus"];
}) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<FeedStatus>(camera.streamUrl ? "starting" : "unavailable");
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

  const report = (next: FeedStatus) => {
    setStatus(next);
    onStatus?.(camera.id, next);
  };

  return (
    <div
      className="relative overflow-hidden rounded-md border border-border bg-muted"
      style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
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

function TwinView({
  camera,
  feature,
  viewerFactory,
}: {
  camera: PoleCamera;
  feature: SignalFeature;
  viewerFactory: PoleCameraViewerFactory;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let viewer: CityViewer | null = null;
    setError(null);

    Promise.resolve(viewerFactory(canvas))
      .then((createdViewer) => {
        if (disposed) {
          createdViewer.dispose();
          return;
        }
        viewer = createdViewer;
        const pose = resolveCameraPose(feature, camera);
        viewer.applyView({
          position: pose.position,
          target: pose.target,
          fov: pose.verticalFovDeg,
        });
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      disposed = true;
      viewer?.dispose();
    };
  }, [camera, feature, generation, viewerFactory]);

  return (
    <div
      className="relative overflow-hidden rounded-md border border-border bg-muted"
      style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        aria-label={`${camera.label ?? camera.id} calibrated digital twin view`}
      />
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-5 text-center">
          <AlertTriangle className="size-7 text-destructive" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-foreground">Twin view unavailable</p>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{error}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setGeneration((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" /> Retry twin
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PoleCameraGrid({
  rigs,
  features,
  viewerFactory,
  onFeedStatus,
}: PoleCameraGridProps) {
  const configured = useMemo(
    () =>
      rigs.flatMap((rig) => {
        const feature = findRigFeature(features, rig);
        return rig.cameras.map((camera) => ({
          rig,
          camera,
          feature,
          key: `${rig.featureId}:${camera.id}`,
        }));
      }),
    [features, rigs],
  );
  const [focusedKey, setFocusedKey] = useState<string | null>(configured[0]?.key ?? null);

  useEffect(() => {
    if (!configured.some((entry) => entry.key === focusedKey)) {
      setFocusedKey(configured[0]?.key ?? null);
    }
  }, [configured, focusedKey]);

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
    <div className="grid gap-4 xl:grid-cols-2">
      {configured.map(({ rig, camera, feature, key }) => {
        const focused = key === focusedKey;
        return (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{camera.label ?? camera.id}</CardTitle>
              <CardDescription>{rig.label ?? `Pole ${rig.featureId}`}</CardDescription>
              <CardAction>
                {!focused ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setFocusedKey(key)}>
                    Start feed
                  </Button>
                ) : null}
              </CardAction>
            </CardHeader>
            <CardContent>
              {feature ? (
                <div className="grid grid-cols-2 gap-3">
                  <section aria-label="Real camera feed">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Real</p>
                    <CameraFeed
                      key={`${key}:${focused ? "active" : "paused"}`}
                      camera={camera}
                      active={focused}
                      onStatus={onFeedStatus}
                    />
                  </section>
                  <section aria-label="Digital twin camera view">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Twin</p>
                    <TwinView camera={camera} feature={feature} viewerFactory={viewerFactory} />
                  </section>
                </div>
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
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
