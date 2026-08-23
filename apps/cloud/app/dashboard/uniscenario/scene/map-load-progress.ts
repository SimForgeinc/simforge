import type { MapModelLoadSnapshot } from "./map-camera-transition";

export type SceneLoadPhase =
  | "covering"
  | "resolving"
  | "assets"
  | "stabilizing"
  | "ready"
  | "error";

export type SceneLoadProgress = {
  phase: SceneLoadPhase;
  percent: number | null;
  /** Byte telemetry is authoritative; callers must not clamp it to a stale estimate. */
  percentExact?: boolean;
  message: string;
  detail: string;
  download?: {
    transferred: string;
    total: string | null;
    speed: string;
    stalled: boolean;
    stalledFor: string | null;
  };
};

export type SceneLoadProgressTracker = {
  peakOutstanding: number;
  percent: number;
};

export function initialSceneLoadProgress(label: string): SceneLoadProgress {
  return {
    phase: "resolving",
    percent: 8,
    message: `Loading ${label}`,
    detail: "Preparing the map definition…",
  };
}

export function sceneLoadProgressFromSnapshot(
  label: string,
  snapshot: MapModelLoadSnapshot,
  tracker: SceneLoadProgressTracker,
): { progress: SceneLoadProgress; tracker: SceneLoadProgressTracker } {
  const outstanding = Math.max(
    0,
    snapshot.loading + snapshot.queued + snapshot.uploading,
  );
  const peakOutstanding = Math.max(tracker.peakOutstanding, outstanding, 1);
  const completedFraction = Math.max(
    0,
    Math.min(1, 1 - outstanding / peakOutstanding),
  );
  const download = snapshot.downloads?.active
    ? downloadProgress(snapshot.downloads)
    : undefined;
  const byteFraction = snapshot.downloads?.totalBytes
    ? Math.max(
        0,
        Math.min(1, snapshot.downloads.transferredBytes / snapshot.downloads.totalBytes),
      )
    : 0;
  const hasExactByteProgress = Boolean(download && snapshot.downloads?.totalBytes);
  const nextPercent = outstanding === 0
    ? 94
    : Math.round(
        55 + (hasExactByteProgress ? byteFraction : completedFraction) * 35,
      );
  const percent = hasExactByteProgress
    ? Math.min(94, nextPercent)
    : Math.max(tracker.percent, Math.min(94, nextPercent));
  const trackerPercent = Math.max(tracker.percent, percent);

  if (snapshot.streamingError) {
    return {
      tracker: { peakOutstanding, percent: trackerPercent },
      progress: {
        phase: "error",
        percent: null,
        message: `${label} could not be loaded`,
        detail: snapshot.streamingError,
      },
    };
  }

  if (outstanding === 0 && snapshot.roadReady && snapshot.roadVisible) {
    return {
      tracker: { peakOutstanding, percent: trackerPercent },
      progress: {
        phase: "stabilizing",
        percent,
        message: `Finishing ${label}`,
        detail: "Checking the completed scene and preparing the first frame…",
      },
    };
  }

  const parts = [
    snapshot.loading > 0 ? `${snapshot.loading} downloading` : null,
    snapshot.queued > 0 ? `${snapshot.queued} queued` : null,
    snapshot.uploading > 0 ? `${snapshot.uploading} uploading` : null,
  ].filter(Boolean);
  return {
    tracker: { peakOutstanding, percent: trackerPercent },
    progress: {
      phase: "assets",
      percent,
      percentExact: hasExactByteProgress,
      message: `Loading ${label} assets`,
      detail: download?.stalled
        ? `No download data received for ${download.stalledFor}. The connection may be stalled.`
        : parts.length > 0
          ? `${parts.join(" · ")}…`
          : "Loading roads, buildings, and map objects…",
      download,
    },
  };
}

function downloadProgress(downloads: NonNullable<MapModelLoadSnapshot["downloads"]>) {
  return {
    transferred: formatBytes(downloads.transferredBytes),
    total: downloads.totalBytes === null ? null : formatBytes(downloads.totalBytes),
    speed: downloads.bytesPerSecond === null
      ? "Measuring speed"
      : `${formatBytes(downloads.bytesPerSecond)}/s`,
    stalled: downloads.stalledForMs >= 5_000,
    stalledFor: downloads.stalledForMs > 0
      ? formatDuration(downloads.stalledForMs)
      : null,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return `${seconds}s`;
}

export function failedSceneLoadProgress(
  label: string,
  reason: unknown,
): SceneLoadProgress {
  return {
    phase: "error",
    percent: null,
    message: `${label} could not be loaded`,
    detail: reason instanceof Error
      ? reason.message
      : "The scene stopped loading unexpectedly.",
  };
}
